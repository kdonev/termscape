import {
  BinaryFrameKind,
  ClientMsg,
  decodeBinaryFrame,
  encodeBinaryFrame,
  ServerMsg,
  type AckableMsg,
} from '@termscape/protocol';

type PtyListener = (chunk: string) => void;

/** A mutation that has been sent and is waiting for its ack. */
interface Pending {
  resolve: (result: RequestResult) => void;
  reject: (err: Error) => void;
}

/** What an ack carries back to the dialog that asked. */
export interface RequestResult {
  /** The session the mutation created, when it created one. */
  sessionId?: string;
}

/**
 * WebSocket client for the hub.
 *
 * Reconnects on its own, and on every reconnect re-sends the attach set so a
 * dropped socket does not leave a terminal silently dead. Terminal bytes ride
 * on binary frames; everything else is JSON.
 */
export class HubClient {
  private ws: WebSocket | null = null;
  private readonly ptyListeners = new Map<string, Set<PtyListener>>();
  private readonly attached = new Set<string>();
  private reconnectDelay = 500;
  private closed = false;
  private queue: ClientMsg[] = [];
  private readonly pending = new Map<string, Pending>();
  private nextRequest = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly onServerMsg: (m: ServerMsg) => void,
    private readonly onConnectionChange: (connected: boolean) => void,
  ) {}

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 500;
      ws.send(JSON.stringify({ t: 'hello', token: this.token } satisfies ClientMsg));
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const f = decodeBinaryFrame(new Uint8Array(ev.data));
        if (f.kind === BinaryFrameKind.PtyOutput) {
          const text = new TextDecoder().decode(f.payload);
          this.ptyListeners.get(f.sessionId)?.forEach((l) => l(text));
        }
        return;
      }
      const parsed = ServerMsg.safeParse(JSON.parse(ev.data as string));
      if (!parsed.success) return;

      if (parsed.data.t === 'ack') {
        const { requestId, ok, message, sessionId } = parsed.data;
        const waiting = this.pending.get(requestId);
        this.pending.delete(requestId);
        if (ok) waiting?.resolve({ sessionId });
        else waiting?.reject(new Error(message || 'the hub refused that'));
        // The promise is the whole interface for callers that only need to
        // know it happened; the ones that want a created id read the result.
        return;
      }

      if (parsed.data.t === 'ready') {
        this.onConnectionChange(true);
        // Re-establish attachments and drain anything queued while offline.
        for (const id of this.attached) this.rawSend({ t: 'attach', sessionId: id });
        const q = this.queue;
        this.queue = [];
        for (const m of q) this.rawSend(m);
      }
      this.onServerMsg(parsed.data);
    };

    ws.onclose = () => {
      this.onConnectionChange(false);
      this.ws = null;
      // A dialog waiting on an ack would otherwise sit with its spinner up
      // forever. The mutation may well have landed, so say what is actually
      // known rather than that it failed.
      this.failPending('lost the connection to the hub before it answered');
      if (this.closed) return;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    };

    ws.onerror = () => ws.close();
  }

  private rawSend(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.rawSend(msg);
    else this.queue.push(msg);
  }

  /**
   * Send a mutation and wait for the hub's answer.
   *
   * This is what lets a dialog stay open until it knows, and put a refusal
   * beside the field that caused it instead of in a toast in the corner. It
   * deliberately does not queue while offline the way send() does: a dialog
   * that sat waiting for a reconnect would report neither success nor
   * failure, and the honest answer is available immediately.
   */
  request(msg: AckableMsg): Promise<RequestResult> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('not connected to the hub'));
    }
    const requestId = `r${++this.nextRequest}`;
    return new Promise<RequestResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.rawSend({ ...msg, requestId });
    });
  }

  private failPending(reason: string): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const p of waiting) p.reject(new Error(reason));
  }

  /** Terminal input takes the binary path to avoid JSON-encoding keystrokes. */
  sendInput(sessionId: string, data: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      encodeBinaryFrame(
        BinaryFrameKind.PtyInput,
        sessionId,
        new TextEncoder().encode(data),
      ),
    );
  }

  /**
   * Attach to a session's output stream. Returns a detach function. The hub
   * only streams to attached clients, which is what keeps a zoomed-out canvas
   * of many terminals cheap.
   */
  attach(sessionId: string, listener: PtyListener): () => void {
    let set = this.ptyListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.ptyListeners.set(sessionId, set);
    }
    set.add(listener);

    if (!this.attached.has(sessionId)) {
      this.attached.add(sessionId);
      this.send({ t: 'attach', sessionId });
    }

    return () => {
      set!.delete(listener);
      if (set!.size === 0) {
        this.ptyListeners.delete(sessionId);
        this.attached.delete(sessionId);
        this.send({ t: 'detach', sessionId });
      }
    };
  }

  close(): void {
    this.closed = true;
    this.failPending('the connection was closed');
    this.ws?.close();
  }
}
