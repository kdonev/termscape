import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  Host,
  PeerAgent,
  PeerRelayAsk,
  Session,
  WindowRect,
} from '@aicanvas/protocol';
import type { Store } from '../db/store.js';
import { DEFAULT_WINDOW } from '../db/store.js';
import type { WebSocket as WsSocket } from 'ws';
import { PeerConnection } from './peer.js';

/**
 * Tracks connected peer hubs and the sessions they own.
 *
 * Remote sessions are held in memory only: the peer is the source of truth for
 * its own sessions and snapshots, so a stale local copy would be worse than
 * none. What *is* persisted locally is the window layout, because that is the
 * user's view of their canvas rather than the peer's state.
 */
export class PeerRegistry extends EventEmitter {
  private readonly peers = new Map<string, PeerConnection>();
  /** hostId -> address -> session, as last reported by that peer. */
  private readonly remote = new Map<string, Map<string, Session>>();

  constructor(
    private readonly store: Store,
    private readonly hubVersion: string,
  ) {
    super();
  }

  /* ---------------------------------------------------------- connection */

  add(host: Host, url: string, token: string): PeerConnection {
    const peer = this.create(host, { url, token });
    peer.connect();
    return peer;
  }

  /**
   * Adopt a socket an enrolled host opened towards us. Same peer, same events,
   * same routing — only the direction of the dial differs, and nothing
   * downstream of here can tell.
   */
  addInbound(host: Host, socket: WsSocket, remoteVersion: string): PeerConnection {
    const peer = this.create(host, {});
    peer.adopt(socket, remoteVersion);
    return peer;
  }

  private create(host: Host, opts: { url?: string; token?: string }): PeerConnection {
    const existing = this.peers.get(host.id);
    if (existing?.connected) {
      // Two live processes are claiming one host - a duplicate left behind by
      // an interrupted install, say. Taking the newcomer and merely dropping
      // the old one is not enough: it reconnects, displaces the newcomer, and
      // the two evict each other forever. Tell it to stop instead.
      void existing
        .request({ t: 'shutdown', id: randomUUID() })
        .catch(() => {
          // It may go away before answering, which is the point.
        });
    }
    this.remove(host.id);

    const peer = new PeerConnection({
      hostId: host.id,
      ...opts,
      hubVersion: this.hubVersion,
    });

    peer.on('connected', (version: string) => {
      this.updateHost(host.id, { state: 'connected', hubVersion: version, error: null });
      // A host that was unreachable when the user closed one of its windows
      // has an instruction waiting for it.
      void this.flushPendingRemovals(host.id, peer);
      // It knows nothing about the rest of the canvas until it is told, and
      // its agents are running the moment it reconnects.
      this.emit('directoryStale');
    });

    peer.on('disconnected', () => {
      this.updateHost(host.id, { state: 'disconnected' });
      // Windows stay on the canvas (layout is local) but go offline, rather
      // than vanishing and losing the user's arrangement.
      this.emit('peerSessionsChanged', host.id);
    });

    peer.on('error', (err: Error) => {
      this.updateHost(host.id, { state: 'error', error: err.message });
    });

    peer.on('sessions', (sessions: Session[]) => {
      // A removal still queued for this host must not put its window back on
      // the canvas in the meantime — and withLocalLayout would mint it a fresh
      // layout row on the way past, undoing the close a second time.
      const pending = new Set(this.store.pendingRemovals(host.id).map((p) => p.address));
      const map = new Map<string, Session>();
      for (const s of sessions) {
        if (pending.has(s.address)) continue;
        map.set(s.address, this.withLocalLayout(host.id, s));
      }
      this.remote.set(host.id, map);
      this.emit('peerSessionsChanged', host.id);
    });

    peer.on('sessionUpserted', (s: Session) => {
      if (this.isPendingRemoval(host.id, s.address)) return;
      const map = this.remote.get(host.id) ?? new Map<string, Session>();
      map.set(s.address, this.withLocalLayout(host.id, s));
      this.remote.set(host.id, map);
      this.emit('peerSession', this.withLocalLayout(host.id, s));
    });

    peer.on('sessionRemoved', (address: string) => {
      this.forget(address);
    });

    peer.on('output', (address: string, data: string) => {
      this.emit('output', address, data);
    });

    // An agent over there acting on an address its own hub cannot resolve.
    // We do it — we are the only hub that knows where every address on this
    // canvas lives — and the answer goes back over the same link.
    peer.on('relay', (relayId: string, ask: PeerRelayAsk) => {
      this.emit('relay', ask, (ok: boolean, result: unknown, error: string | null) => {
        void peer
          .request({ t: 'relayResult', id: randomUUID(), relayId, ok, result, error })
          .catch(() => {
            // The host went away between asking and being answered. Its own
            // relay timeout is what tells its agent, and there is nothing
            // useful to do about it here.
          });
      });
    });

    this.peers.set(host.id, peer);
    this.remote.set(host.id, new Map());
    this.updateHost(host.id, { state: 'connecting' });
    return peer;
  }

  remove(hostId: string): void {
    this.peers.get(hostId)?.close();
    this.peers.delete(hostId);
    this.remote.delete(hostId);
    this.emit('peerSessionsChanged', hostId);
  }

  closeAll(): void {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.remote.clear();
  }

  /* --------------------------------------------------------------- state */

  private updateHost(hostId: string, patch: Partial<Host>): void {
    const host = this.store.listHosts().find((h) => h.id === hostId);
    if (!host) return;
    const next: Host = {
      ...host,
      ...patch,
      lastSeenAt: patch.state === 'connected' ? Date.now() : host.lastSeenAt,
    };
    this.store.upsertHost(next);
    this.emit('host', next);
  }

  /**
   * Overlay the locally stored window rect. The peer has no idea where the
   * user put its window, and should not: layout is a local concern.
   */
  private withLocalLayout(hostId: string, s: Session): Session {
    // Re-key remote sessions by address. The peer's internal session id means
    // nothing here and could collide with a local one, whereas the address is
    // already globally unique and is what every cross-hub call uses. This
    // makes attach/input/resize routing fall out of a single lookup.
    const base: Session = { ...s, id: s.address };
    const saved = this.store.getRemoteWindows().get(s.address);
    if (saved) return { ...base, window: saved };
    const placed = this.placeRemote(hostId);
    this.store.saveRemoteWindow(s.address, hostId, placed);
    return { ...base, window: placed };
  }

  /** Remote hosts get their own band of canvas, well clear of local windows. */
  private placeRemote(hostId: string): WindowRect {
    const hostIndex = Math.max(
      0,
      this.store.listHosts().findIndex((h) => h.id === hostId),
    );
    const existing = this.remote.get(hostId)?.size ?? 0;
    return {
      ...DEFAULT_WINDOW,
      x: existing % 3 * (DEFAULT_WINDOW.w + 40),
      y: 900 + hostIndex * 1200 + Math.floor(existing / 3) * (DEFAULT_WINDOW.h + 40),
      z: existing,
    };
  }

  peer(hostId: string): PeerConnection | null {
    return this.peers.get(hostId) ?? null;
  }

  /** Whether there is any attached machine to tell things to. */
  get any(): boolean {
    return this.peers.size > 0;
  }

  /**
   * Tell every attached host who is on the canvas.
   *
   * `forHost` receives the whole directory minus that host's own agents: it
   * already has those, and listing them twice is worse than not sending them.
   */
  announce(forHost: (hostId: string) => PeerAgent[]): void {
    for (const [hostId, peer] of this.peers) {
      if (!peer.connected) continue;
      void peer
        .request({ t: 'directory', id: randomUUID(), agents: forHost(hostId) })
        .catch(() => {
          // A host that dropped mid-announce gets the current directory when
          // it reconnects, which is the same thing a moment later.
        });
    }
  }

  /** Every remote session across every peer. */
  sessions(): Session[] {
    const out: Session[] = [];
    for (const [hostId, map] of this.remote) {
      const online = this.peers.get(hostId)?.connected ?? false;
      for (const s of map.values()) {
        // A peer we cannot reach cannot have running sessions from our point
        // of view; showing them as running would be a lie.
        out.push(online ? s : { ...s, state: 'stopped', status: 'unknown' });
      }
    }
    return out;
  }

  find(address: string): { peer: PeerConnection; session: Session } | null {
    for (const [hostId, map] of this.remote) {
      const s = map.get(address);
      const peer = this.peers.get(hostId);
      if (s && peer) return { peer, session: s };
    }
    return null;
  }

  /**
   * Which host owns an address. The peer's workspace rows do not exist in the
   * local database (remote state is not cached), so the registry is the only
   * thing that knows this mapping.
   */
  hostIdFor(address: string): string | null {
    for (const [hostId, map] of this.remote) {
      if (map.has(address)) return hostId;
    }
    return null;
  }

  /* ------------------------------------------------------------ removal */

  /**
   * Close a remote window for good.
   *
   * Returns false for an address this registry does not own, so the caller can
   * fall through to its local path — the same shape as saveLayout.
   *
   * The window goes either way: the user closed it, and making that conditional
   * on a host being up would be its own kind of broken. What varies is only
   * when the owning hub hears about it.
   */
  async removeSession(address: string): Promise<boolean> {
    const hostId = this.hostIdFor(address);
    if (!hostId) return false;
    const peer = this.peers.get(hostId);
    this.forget(address);
    try {
      if (!peer?.connected) throw new Error(`host ${hostId} is not connected`);
      await peer.request({ t: 'removeSession', id: randomUUID(), address });
    } catch {
      // Unreachable, or it went away mid-request. The instruction waits in the
      // database rather than dying with this process, which is precisely what
      // used to let a closed terminal come back after a restart.
      this.store.addPendingRemoval(address, hostId);
    }
    return true;
  }

  /**
   * Replay removals queued while a host was unreachable. Each one is
   * idempotent over there, so a row whose removal already landed costs one
   * round trip and nothing else.
   */
  private async flushPendingRemovals(hostId: string, peer: PeerConnection): Promise<void> {
    for (const { address } of this.store.pendingRemovals(hostId)) {
      try {
        await peer.request({ t: 'removeSession', id: randomUUID(), address });
        this.forget(address);
      } catch {
        // Still out of reach. The row survives for the next connection.
      }
    }
  }

  /** Drop every local trace of a remote session: cache, layout, and queue. */
  private forget(address: string): void {
    for (const map of this.remote.values()) map.delete(address);
    this.store.removeRemoteWindow(address);
    this.store.clearPendingRemoval(address);
    this.emit('peerSessionRemoved', address);
  }

  private isPendingRemoval(hostId: string, address: string): boolean {
    return this.store.pendingRemovals(hostId).some((p) => p.address === address);
  }

  /* ------------------------------------------------------------- layout */

  saveLayout(address: string, rect: WindowRect): boolean {
    for (const [hostId, map] of this.remote) {
      if (map.has(address)) {
        this.store.saveRemoteWindow(address, hostId, rect);
        const s = map.get(address)!;
        map.set(address, { ...s, window: rect });
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ requests */

  async deliver(from: string, to: string, body: string): Promise<void> {
    const found = this.find(to);
    if (!found) throw new Error(`no agent at address "${to}"`);
    if (!found.peer.connected) {
      throw new Error(`host for "${to}" is not connected`);
    }
    await found.peer.request({ t: 'deliver', id: randomUUID(), from, to, body });
  }

  /**
   * Start an agent on a peer. The receiving hub creates the workspace if it
   * does not have one by that name, so a host needs no setup before its first
   * session — which is what makes picking a host at workspace-creation time
   * enough on its own.
   */
  async startSession(
    hostId: string,
    req: {
      workspaceName: string;
      rootPath: string;
      profile: string;
      name?: string;
      spawnedByAddress: string | null;
    },
  ): Promise<Session> {
    const peer = this.peers.get(hostId);
    if (!peer) throw new Error(`host ${hostId} is not connected`);
    if (!peer.connected) throw new Error(`host ${hostId} is not connected`);
    return peer.request<Session>({ t: 'startSession', id: randomUUID(), ...req });
  }

  /**
   * Ask a peer to stop its whole hub. Best effort by nature: it may already be
   * gone, and it stops answering the moment it obeys.
   */
  async requestShutdown(hostId: string): Promise<boolean> {
    const peer = this.peers.get(hostId);
    if (!peer?.connected) return false;
    try {
      await peer.request({ t: 'shutdown', id: randomUUID() });
      return true;
    } catch {
      // It went away before replying, which is the outcome we wanted.
      return false;
    }
  }

  async stopSession(address: string): Promise<void> {
    const found = this.find(address);
    if (!found) throw new Error(`no agent at address "${address}"`);
    await found.peer.request({ t: 'stopSession', id: randomUUID(), address });
  }

  async readScreen(address: string, lines?: number): Promise<unknown> {
    const found = this.find(address);
    if (!found) throw new Error(`no agent at address "${address}"`);
    return found.peer.request({ t: 'readScreen', id: randomUUID(), address, lines });
  }
}
