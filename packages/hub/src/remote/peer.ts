import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  PEER_SCHEMA_VERSION,
  PeerResponse,
  type PeerRequest,
  type Session,
} from '@aicanvas/protocol';

export interface PeerOptions {
  hostId: string;
  /** Loopback URL of the tunnelled remote hub, e.g. ws://127.0.0.1:51234/peer */
  url: string;
  token: string;
  hubVersion: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Client half of the hub-to-hub link.
 *
 * Reconnects with backoff, because the whole point of running a daemon on the
 * remote host rather than an ssh subprocess is that the sessions survive the
 * link dropping. On reconnect it re-subscribes and re-fetches the peer's
 * session list, so the canvas repopulates on its own.
 */
export class PeerConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly attached = new Set<string>();
  private closed = false;
  private backoff = 500;
  private _connected = false;
  private _remoteVersion: string | null = null;

  constructor(private readonly opts: PeerOptions) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  get remoteVersion(): string | null {
    return this._remoteVersion;
  }

  get hostId(): string {
    return this.opts.hostId;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          token: this.opts.token,
          hubVersion: this.opts.hubVersion,
          schemaVersion: PEER_SCHEMA_VERSION,
        } satisfies PeerRequest),
      );
    });

    ws.on('message', (raw: Buffer) => this.onMessage(raw));

    ws.on('close', () => {
      this.ws = null;
      const wasConnected = this._connected;
      this._connected = false;
      this.failAllPending('peer connection closed');
      if (wasConnected) this.emit('disconnected');
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15_000);
    });

    ws.on('error', (err: Error) => {
      this.emit('error', err);
      ws.close();
    });
  }

  private onMessage(raw: Buffer): void {
    let parsed;
    try {
      parsed = PeerResponse.safeParse(JSON.parse(raw.toString('utf8')));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const msg = parsed.data;

    switch (msg.t) {
      case 'welcome': {
        // Refuse a peer we cannot speak to correctly rather than half-working.
        if (msg.schemaVersion !== PEER_SCHEMA_VERSION) {
          this.emit(
            'error',
            new Error(
              `peer schema mismatch: remote hub ${msg.hubVersion} speaks v${msg.schemaVersion}, ` +
                `this hub speaks v${PEER_SCHEMA_VERSION}. Redeploy the remote hub.`,
            ),
          );
          this.close();
          return;
        }
        this._connected = true;
        this._remoteVersion = msg.hubVersion;
        this.backoff = 500;
        this.emit('connected', msg.hubVersion);
        // Re-establish attachments that predate this connection.
        for (const address of this.attached) {
          void this.request({ t: 'attach', id: randomUUID(), address });
        }
        void this.refresh();
        return;
      }

      case 'ok':
      case 'err': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.t === 'ok') p.resolve(msg.result);
        else p.reject(new Error(msg.message));
        return;
      }

      case 'sessions':
        this.emit('sessions', msg.sessions as Session[]);
        return;
      case 'sessionUpserted':
        this.emit('sessionUpserted', msg.session as Session);
        return;
      case 'sessionRemoved':
        this.emit('sessionRemoved', msg.address);
        return;
      case 'output':
        this.emit('output', msg.address, msg.data);
        return;
    }
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Send a request and await its reply. */
  request<T = unknown>(req: PeerRequest): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`host ${this.opts.hostId} is not connected`));
    }
    const id = 'id' in req ? req.id : randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`peer request "${req.t}" timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify(req));
    });
  }

  async refresh(): Promise<void> {
    try {
      const sessions = await this.request<Session[]>({
        t: 'listSessions',
        id: randomUUID(),
      });
      this.emit('sessions', sessions);
    } catch (err) {
      this.emit('error', err as Error);
    }
  }

  async attach(address: string): Promise<void> {
    this.attached.add(address);
    await this.request({ t: 'attach', id: randomUUID(), address });
  }

  async detach(address: string): Promise<void> {
    this.attached.delete(address);
    await this.request({ t: 'detach', id: randomUUID(), address });
  }

  close(): void {
    this.closed = true;
    this.failAllPending('peer closed');
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }
}
