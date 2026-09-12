import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AgentProfileInfo,
  Host,
  PeerAgent,
  PeerRelayAsk,
  Session,
  WindowRect,
} from '@termscape/protocol';
import type { Store } from '../db/store.js';
import { DEFAULT_WINDOW } from '../db/store.js';
import type { WebSocket as WsSocket } from 'ws';
import { PeerConnection } from './peer.js';

/**
 * Re-key a peer's session for this canvas.
 *
 * The peer's internal session id means nothing here and could collide with a
 * local one, whereas the address is already globally unique and is what every
 * cross-hub call uses — so the id becomes the address. The lineage is dragged
 * across with it: `spawnedBy` names the parent in whatever id space the
 * reference arrived in, and once the parent window here answers to its canvas
 * id, a canvas that cannot tell who spawned a window cannot frame parent and
 * child together. A parent the translator does not know is left as it arrived.
 */
export function localizeRemoteSession(
  s: Session,
  parentIdFor: (reference: string) => string | null,
): Session {
  return {
    ...s,
    id: s.address,
    spawnedBy: s.spawnedBy ? (parentIdFor(s.spawnedBy) ?? s.spawnedBy) : null,
  };
}

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
  /**
   * hostId -> what that machine has installed, as it last reported.
   *
   * Kept rather than derived because it cannot be: this hub's PATH says
   * nothing about another machine's, and the only source for that answer is
   * the machine itself.
   */
  private readonly remoteAgents = new Map<string, AgentProfileInfo[]>();
  /**
   * hostId -> the peer's internal session id -> the address it answers to
   * here. Kept only so `spawnedBy`, which arrives in the peer's id space, can
   * be translated when the session is re-keyed by address.
   */
  private readonly peerIds = new Map<string, Map<string, string>>();
  /**
   * hostId -> a child's id -> the canvas id of the parent that spawned it
   * from here. The id is the canvas's own choice, sent with the start request
   * and used by the peer as the child's id — so the lineage can be stamped on
   * the child's first upsert, which crosses before the start request's reply
   * does. The peer cannot hold this lineage at all: its session table's
   * foreign key would reject a parent that is not one of its own.
   */
  private readonly lineage = new Map<string, Map<string, string>>();

  constructor(
    private readonly store: Store,
    private readonly hubVersion: string,
    /**
     * Resolves a local session's address to its id. Lineage can arrive as an
     * address when the spawner lives on this canvas and the child on a peer —
     * the address is the one id both hubs agree on, but the canvas knows the
     * parent window by its local id.
     */
    private readonly localIdForAddress: (address: string) => string | null = () => null,
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
      // Its PATH is its own, and it may have changed since it was last here.
      void peer.refreshAgents();
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
      // Two passes: a child can report before its parent, and the lineage
      // translation needs the whole generation noted first.
      for (const s of sessions) if (!pending.has(s.address)) this.notePeerId(host.id, s);
      for (const s of sessions) {
        if (pending.has(s.address)) continue;
        map.set(s.address, this.withLineage(host.id, s, this.withLocalLayout(host.id, s)));
      }
      this.remote.set(host.id, map);
      this.emit('peerSessionsChanged', host.id);
    });

    peer.on('agents', (agents: AgentProfileInfo[]) => {
      this.remoteAgents.set(host.id, agents);
      this.emit('peerAgents', host.id, agents);
    });

    peer.on('sessionUpserted', (s: Session) => {
      if (this.isPendingRemoval(host.id, s.address)) return;
      this.notePeerId(host.id, s);
      const map = this.remote.get(host.id) ?? new Map<string, Session>();
      const localized = this.withLineage(host.id, s, this.withLocalLayout(host.id, s));
      map.set(s.address, localized);
      this.remote.set(host.id, map);
      this.emit('peerSession', localized);
    });

    peer.on('sessionRemoved', (address: string) => {
      this.forget(address);
    });

    peer.on('output', (address: string, data: string) => {
      this.emit('output', address, data);
    });

    // An agent over there acting on something its own hub cannot resolve.
    // We do it — we are the only hub that knows what every machine on this
    // canvas is and where every address on it lives — and the answer goes
    // back over the same link. `host.id` travels with it so the handler can
    // mark `you` and apply the `local` alias for a caller that is not on this
    // machine at all.
    peer.on('relay', (relayId: string, ask: PeerRelayAsk) => {
      this.emit('relay', ask, (ok: boolean, result: unknown, error: string | null) => {
        void peer
          .request({ t: 'relayResult', id: randomUUID(), relayId, ok, result, error })
          .catch(() => {
            // The host went away between asking and being answered. Its own
            // relay timeout is what tells its agent, and there is nothing
            // useful to do about it here.
          });
      }, host.id);
    });

    this.peers.set(host.id, peer);
    this.remote.set(host.id, new Map());
    this.updateHost(host.id, { state: 'connecting' });
    return peer;
  }

  /** What every attached machine has installed, by host id. */
  agentsByHost(): Record<string, AgentProfileInfo[]> {
    return Object.fromEntries(this.remoteAgents);
  }

  /** Ask every attached machine to probe its PATH again. */
  refreshAgents(): void {
    for (const peer of this.peers.values()) void peer.refreshAgents();
  }

  remove(hostId: string): void {
    this.peers.get(hostId)?.close();
    this.peers.delete(hostId);
    this.remote.delete(hostId);
    this.remoteAgents.delete(hostId);
    this.peerIds.delete(hostId);
    this.lineage.delete(hostId);
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
    // Lineage speaks two id spaces: the peer's own session ids, and — when
    // the spawner lived on this canvas — an address. Both resolve to the id
    // the parent window answers to here; anything else is left as it came.
    const base = localizeRemoteSession(s, (ref) =>
      this.peerIds.get(hostId)?.get(ref) ?? this.localIdForAddress(ref),
    );
    const saved = this.store.getRemoteWindows().get(s.address);
    if (saved) return { ...base, window: saved };
    const placed = this.placeRemote(hostId);
    this.store.saveRemoteWindow(s.address, hostId, placed);
    return { ...base, window: placed };
  }

  /** Remember a peer session's original id so lineage can be translated later. */
  private notePeerId(hostId: string, s: Session): void {
    let ids = this.peerIds.get(hostId);
    if (!ids) {
      ids = new Map<string, string>();
      this.peerIds.set(hostId, ids);
    }
    ids.set(s.id, s.address);
  }

  /**
   * Stamp canvas-side lineage onto a child the canvas hub itself spawned into
   * a peer. Keyed on the id the canvas chose for the child, so it applies to
   * the first upsert — the one that has to carry the lineage for the canvas
   * to frame parent and child together.
   */
  private withLineage(hostId: string, raw: Pick<Session, 'id'>, s: Session): Session {
    const parentId = this.lineage.get(hostId)?.get(raw.id);
    return parentId ? { ...s, spawnedBy: parentId } : s;
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
      const host = this.store.listHosts().find((h) => h.id === hostId);
      void peer
        .request({
          t: 'directory',
          id: randomUUID(),
          agents: forHost(hostId),
          // What that host is called, so it can answer for itself without a
          // row of its own — only the canvas holds one.
          youAre: host?.label,
        })
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
      /** The agent id, already resolved from the template on this side. */
      profile: string;
      template?: string | null;
      model?: string;
      effort?: string;
      prompt?: string;
      env?: Record<string, string>;
      name?: string;
      spawnedByAddress: string | null;
    },
  ): Promise<Session> {
    const peer = this.peers.get(hostId);
    if (!peer) throw new Error(`host ${hostId} is not connected`);
    if (!peer.connected) throw new Error(`host ${hostId} is not connected`);

    // Lineage is ours to keep, not the peer's (its session table would reject
    // a parent id it has never seen). The child's id is chosen here and sent
    // with the request, so the map below can be keyed on it before anything
    // moves: the child's first upsert crosses before this request's reply,
    // and it is the one that has to carry the lineage for the canvas to frame
    // parent and child together. Naming the child or not makes no difference.
    const parentId = req.spawnedByAddress
      ? this.localIdForAddress(req.spawnedByAddress)
      : null;
    const childId = randomUUID();
    if (parentId) {
      let byChild = this.lineage.get(hostId);
      if (!byChild) {
        byChild = new Map<string, string>();
        this.lineage.set(hostId, byChild);
      }
      byChild.set(childId, parentId);
    }

    const s = await peer.request<Session>({
      t: 'startSession',
      id: randomUUID(),
      sessionId: childId,
      ...req,
    });
    // The reply carries the peer's internal uuid, which means nothing here:
    // every session crossing this boundary is re-keyed to its address, the id
    // the canvas, the router and the ack back to the start dialog all agree
    // on. The window's local layout is minted now, so the sessionUpserted
    // broadcast that lands moments later resolves this same rect rather than
    // minting a rival one.
    this.notePeerId(hostId, s);
    return this.withLineage(hostId, s, this.withLocalLayout(hostId, s));
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
