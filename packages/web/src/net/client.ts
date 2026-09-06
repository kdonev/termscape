import {
  BinaryFrameKind,
  ClientMsg,
  decodeBinaryFrame,
  encodeBinaryFrame,
  ServerMsg,
} from '@termscape/protocol';

type PtyListener = (chunk: string) => void;

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
    this.ws?.close();
  }
}
