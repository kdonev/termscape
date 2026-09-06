import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  PEER_SCHEMA_VERSION,
  PeerResponse,
  type PeerRequest,
  type AgentProfileInfo,
  type Session,
} from '@termscape/protocol';

export interface PeerOptions {
  hostId: string;
  /**
   * Loopback URL of the tunnelled remote hub, e.g. ws://127.0.0.1:51234/peer.
   * Absent for an enrolled host: it dialled us, and we have no way to dial it.
   */
  url?: string;
  token?: string;
  hubVersion: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Requesting half of the hub-to-hub link — the side that owns the canvas.
 *
 * It gets its socket one of two ways. `connect()` dials an SSH-deployed hub
 * through its tunnel and reconnects with backoff, because the whole point of a
 * daemon rather than an ssh subprocess is that sessions survive the link
 * dropping. `adopt()` takes a socket an enrolled host opened towards us; there
 * is nothing to dial on a drop, so we wait for it to come back and adopt the
 * new socket instead.
 *
 * Either way, once the socket is live this class behaves identically: it
 * re-subscribes and re-fetches the peer's session list, so the canvas
 * repopulates on its own.
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

  /** True when this peer dialled us and we cannot dial it back. */
  get inbound(): boolean {
    return !this.opts.url;
  }

  connect(): void {
    if (this.closed) return;
    if (!this.opts.url) {
      throw new Error(`host ${this.opts.hostId} enrolled itself; it dials us`);
    }
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          t: 'hello',
          token: this.opts.token ?? '',
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

  /**
   * Take over a socket an enrolling host opened towards us. Its hello was
   * already validated by the join endpoint, and we already answered `welcome`,
   * so there is no handshake left to run here — go straight to the connected
   * state the welcome path would have reached.
   */
  adopt(socket: WebSocket, remoteVersion: string): void {
    if (this.closed) {
      socket.close();
      return;
    }
    this.ws = socket;

    socket.on('message', (raw: Buffer) => this.onMessage(raw));

    socket.on('close', () => {
      // Ignore a socket we already replaced with a newer one. A null `ws`
      // means close() ran, which is ours to finish, not to skip.
      if (this.ws && this.ws !== socket) return;
      this.ws = null;
      const wasConnected = this._connected;
      this._connected = false;
      this.failAllPending('peer connection closed');
      if (wasConnected) this.emit('disconnected');
      // No redial: the host reaches us, not the other way round. It will come
      // back on its own backoff and be adopted again.
    });

    socket.on('error', (err: Error) => {
      this.emit('error', err);
      socket.close();
    });

    this._connected = true;
    this._remoteVersion = remoteVersion;
    this.emit('connected', remoteVersion);
    this.onLive();
  }

  /** Everything that must happen once a socket is usable, either way in. */
  private onLive(): void {
    for (const address of this.attached) {
      // A session that vanished while the link was down cannot be re-attached,
      // and that is not a reason to fail anything: drop it and carry on.
      void this.request({ t: 'attach', id: randomUUID(), address }).catch(() => {
        this.attached.delete(address);
      });
    }
    void this.refresh();
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
        this.onLive();
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
      case 'agents':
        this.emit('agents', msg.agents as AgentProfileInfo[]);
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

      // This peer asking us to act on an address it cannot resolve itself.
      // Answered with a `relayResult` request rather than an `ok`, because the
      // request channel runs the other way: it is not replying to us here, it
      // is asking, and we answer.
      case 'relay':
        this.emit('relay', msg.relayId, msg.ask);
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

  /**
   * What agent CLIs that machine has. Its own failure is swallowed rather
   * than raised as a host error: not knowing which agents are over there is
   * a worse picker, not a broken host, and marking it `error` for that would
   * take its windows off the canvas.
   */
  async refreshAgents(): Promise<void> {
    try {
      const agents = await this.request<AgentProfileInfo[]>({
        t: 'listAgents',
        id: randomUUID(),
      });
      this.emit('agents', agents);
    } catch {
      // Older hub, or a link that dropped mid-question. It pushes an
      // unsolicited `agents` when its own detection finishes anyway.
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
    const wasConnected = this._connected;
    this._connected = false;
    this.ws?.close();
    this.ws = null;
    // Closing a peer is a disconnection like any other. Without this the
    // socket's own close handler sees _connected already false and stays
    // quiet, leaving the host row claiming to be connected.
    if (wasConnected) this.emit('disconnected');
  }
}
