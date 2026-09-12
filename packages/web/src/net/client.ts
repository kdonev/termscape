import {
  BinaryFrameKind,
  ClientMsg,
  decodeBinaryFrame,
  describeInput,
  describeLatin1,
  describeModeChanges,
  encodeBinaryFrame,
  ServerMsg,
  type AckableMsg,
} from '@termscape/protocol';
import { debug, debugOn } from '../debug.js';

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
          // Not the output - only the moments the program changes the terms.
          // Whether a wheel belongs to the program or to xterm's scrollback
          // is decided entirely by these, and by nothing the input side can
          // see.
          if (debugOn('output')) {
            const modes = describeModeChanges(text);
            if (modes) debug('output', f.sessionId, 'program set', modes);
          }
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
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // Silently dropped, and always has been - there is nowhere useful to
      // queue a keystroke to. Said out loud under tracing, because "the
      // socket was not open" and "the report was never encoded" look
      // identical from the far end and have nothing in common.
      if (debugOn('input')) {
        const bytes = new TextEncoder().encode(data);
        debug('input', sessionId, 'DROPPED (socket not open):', describeInput(bytes));
      }
      return;
    }
    if (debugOn('input')) {
      const bytes = new TextEncoder().encode(data);
      debug('input', sessionId, 'send utf8:', describeInput(bytes));
    }
    this.ws.send(
      encodeBinaryFrame(
        BinaryFrameKind.PtyInput,
        sessionId,
        new TextEncoder().encode(data),
      ),
    );
  }

  /**
   * Input that is bytes rather than text, delivered to the PTY unchanged.
   *
   * xterm hands these over as a "binary string": one character per byte, each
   * in 0..255. UTF-8 encoding it would turn every byte above 0x7f into two,
   * which is the whole reason this is a separate path - see PtyInputRaw.
   */
  sendInputBytes(sessionId: string, data: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      debug('input', sessionId, 'DROPPED (socket not open):', describeLatin1(data));
      return;
    }
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    // The mouse-report path. This is the line to compare against the hub's
    // `browser -> hub` line: the two describe the same bytes, so a report
    // that changes shape on the way has two entries that disagree.
    if (debugOn('input')) debug('input', sessionId, 'send raw:', describeInput(bytes));
    this.ws.send(encodeBinaryFrame(BinaryFrameKind.PtyInputRaw, sessionId, bytes));
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
      debug('attach', sessionId, 'attach sent');
      this.send({ t: 'attach', sessionId });
    } else {
      // A second window on the same session rides the first one's stream and
      // never asks for a snapshot of its own. Worth seeing, because it is one
      // of the ways a terminal can come up without the modes a snapshot
      // would have restored.
      debug('attach', sessionId, 'already attached; no snapshot will be sent');
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
