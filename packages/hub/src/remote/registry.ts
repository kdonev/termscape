import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Host, Session, WindowRect } from '@aicanvas/protocol';
import type { Store } from '../db/store.js';
import { DEFAULT_WINDOW } from '../db/store.js';
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
    this.remove(host.id);

    const peer = new PeerConnection({
      hostId: host.id,
      url,
      token,
      hubVersion: this.hubVersion,
    });

    peer.on('connected', (version: string) => {
      this.updateHost(host.id, { state: 'connected', hubVersion: version, error: null });
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
      const map = new Map<string, Session>();
      for (const s of sessions) map.set(s.address, this.withLocalLayout(host.id, s));
      this.remote.set(host.id, map);
      this.emit('peerSessionsChanged', host.id);
    });

    peer.on('sessionUpserted', (s: Session) => {
      const map = this.remote.get(host.id) ?? new Map<string, Session>();
      map.set(s.address, this.withLocalLayout(host.id, s));
      this.remote.set(host.id, map);
      this.emit('peerSession', this.withLocalLayout(host.id, s));
    });

    peer.on('sessionRemoved', (address: string) => {
      this.remote.get(host.id)?.delete(address);
      this.store.removeRemoteWindow(address);
      this.emit('peerSessionRemoved', address);
    });

    peer.on('output', (address: string, data: string) => {
      this.emit('output', address, data);
    });

    this.peers.set(host.id, peer);
    this.remote.set(host.id, new Map());
    this.updateHost(host.id, { state: 'connecting' });
    peer.connect();
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

  async readScreen(address: string, lines?: number): Promise<unknown> {
    const found = this.find(address);
    if (!found) throw new Error(`no agent at address "${address}"`);
    return found.peer.request({ t: 'readScreen', id: randomUUID(), address, lines });
  }
}
