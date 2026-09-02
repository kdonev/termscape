import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  encodeInjection,
  slugify,
  type Message,
  type Host,
  type Session,
  type Viewport,
  type WindowRect,
  type Workspace,
} from '@aicanvas/protocol';
import { openDb, type Db } from './db/index.js';
import { Store } from './db/store.js';
import { ProfileRegistry } from './agents/profiles.js';
import { TokenRegistry } from './agents/tokens.js';
import { MessageRouter } from './agents/router.js';
import { SessionManager } from './session/manager.js';
import type { AgentApi } from './mcp/server.js';
import { PeerRegistry } from './remote/registry.js';
import { deploy, type DeployResult } from './remote/deployer.js';
import { paths } from './paths.js';

export const HUB_VERSION = '0.1.0';

/** Colours cycled through when a workspace is created, for canvas grouping. */
const WORKSPACE_COLORS = [
  '#7c9cf5',
  '#68b06e',
  '#d08b5b',
  '#b06ec2',
  '#4ea3b8',
  '#c2607a',
];

/** How many agents one workspace may hold, bounding runaway recursive spawns. */
export const DEFAULT_SPAWN_CAP = 12;

export interface HubOptions {
  dbPath?: string;
  spawnCap?: number;
}

/**
 * The hub: owns the database, the sessions, and the routing between agents.
 * The web server and the MCP endpoint are thin layers over this.
 */
export class Hub extends EventEmitter implements AgentApi {
  readonly db: Db;
  readonly store: Store;
  readonly profiles: ProfileRegistry;
  readonly tokens: TokenRegistry;
  readonly sessions: SessionManager;
  readonly router: MessageRouter;
  readonly peers: PeerRegistry;
  /** Live SSH tunnels, keyed by host id. Not persisted: they die with the hub. */
  private readonly tunnels = new Map<string, DeployResult>();
  private readonly spawnCap: number;

  constructor(opts: HubOptions = {}) {
    super();
    this.db = openDb(opts.dbPath ?? paths.db());
    this.store = new Store(this.db);
    this.profiles = ProfileRegistry.load();
    this.tokens = new TokenRegistry();
    this.spawnCap = opts.spawnCap ?? DEFAULT_SPAWN_CAP;

    // Origin is corrected once the server binds and knows its port.
    this.sessions = new SessionManager(
      this.store,
      this.profiles,
      this.tokens,
      'http://127.0.0.1:0',
    );

    this.router = new MessageRouter(this.store, this.sessions, this.profiles, (m) =>
      this.emit('message', m),
    );

    this.sessions.on('session', (s: Session) => this.emit('session', s));
    this.sessions.on('removed', (id: string, address: string | null) =>
      this.emit('removed', id, address),
    );
    this.sessions.on('data', (id: string, chunk: string) => this.emit('data', id, chunk));

    this.peers = new PeerRegistry(this.store, HUB_VERSION);
    this.peers.on('host', (h) => this.emit('host', h));
    this.peers.on('peerSession', (s: Session) => this.emit('session', s));
    this.peers.on('peerSessionRemoved', (addr: string) => this.emit('removed', addr, addr));
    this.peers.on('peerSessionsChanged', () => this.emit('peersChanged'));
    this.peers.on('output', (address: string, data: string) => {
      // Remote output is addressed by name; the browser keys on session id,
      // and for remote sessions the address *is* the id it was given.
      this.emit('data', address, data);
    });

    // Anything the DB still calls running died with the previous hub.
    this.sessions.reconcileOnBoot();
  }

  /** Local sessions plus every session reported by a connected peer. */
  allSessions(): Session[] {
    return [...this.sessions.list(), ...this.peers.sessions()];
  }

  /** Resolve an address to a local session, a remote one, or nothing. */
  private locate(address: string): 'local' | 'remote' | null {
    if (this.sessions.getByAddress(address)) return 'local';
    return this.peers.find(address) ? 'remote' : null;
  }

  setOrigin(origin: string): void {
    this.sessions.setHubOrigin(origin);
  }

  /* ---------------------------------------------------------- workspaces */

  createWorkspace(name: string, rootPath: string, hostId: string | null = null): Workspace {
    const abs = resolve(rootPath);
    if (!hostId && !existsSync(abs)) {
      throw new Error(`folder does not exist: ${abs}`);
    }
    const existing = this.store.listWorkspaces();
    const wsName = uniqueWorkspaceName(
      slugify(name || basename(abs)),
      existing.map((w) => w.name),
    );
    const ws: Workspace = {
      id: randomUUID(),
      name: wsName,
      kind: hostId ? 'remote' : 'local',
      rootPath: abs,
      hostId,
      color: WORKSPACE_COLORS[existing.length % WORKSPACE_COLORS.length]!,
      createdAt: Date.now(),
      archivedAt: null,
    };
    this.store.insertWorkspace(ws);
    this.emit('workspace', ws);
    return ws;
  }

  removeWorkspace(id: string): void {
    for (const s of this.sessions.list().filter((s) => s.workspaceId === id)) {
      this.sessions.remove(s.id);
    }
    this.store.removeWorkspace(id);
    this.emit('workspaceRemoved', id);
  }

  /* --------------------------------------------------------------- hosts */

  addHost(input: {
    label: string;
    sshHost: string;
    sshUser: string;
    sshPort: number;
    privateKeyPath?: string;
  }): Host {
    const host: Host = {
      id: randomUUID(),
      label: input.label || `${input.sshUser}@${input.sshHost}`,
      sshHost: input.sshHost,
      sshUser: input.sshUser,
      sshPort: input.sshPort,
      hubVersion: null,
      state: 'disconnected',
      lastSeenAt: null,
      error: null,
    };
    this.store.upsertHost({ ...host, keyRef: input.privateKeyPath ?? null });
    this.emit('host', host);
    return host;
  }

  removeHost(hostId: string): void {
    this.peers.remove(hostId);
    void this.tunnels.get(hostId)?.dispose().catch(() => {});
    this.tunnels.delete(hostId);
    this.store.removeHost(hostId);
    this.emit('hostRemoved', hostId);
  }

  /**
   * Deploy the hub to a host if needed, tunnel to it, and join it to the
   * directory. The peer token is minted per connection and never written to
   * the local database.
   */
  async connectHost(hostId: string): Promise<void> {
    const host = this.store.listHosts().find((h) => h.id === hostId);
    if (!host) throw new Error(`unknown host ${hostId}`);

    const token = randomBytes(24).toString('base64url');
    this.store.upsertHost({ ...host, state: 'connecting', error: null });
    this.emit('host', { ...host, state: 'connecting', error: null });

    try {
      const result = await deploy({
        sshHost: host.sshHost,
        sshUser: host.sshUser,
        sshPort: host.sshPort,
        privateKeyPath: this.store.hostKeyRef(hostId) ?? undefined,
        token,
        expectedVersion: HUB_VERSION,
        packagePath: process.env.AICANVAS_HUB_TARBALL,
        log: (line) => this.emit('hostLog', hostId, line),
      });
      this.tunnels.set(hostId, result);
      this.peers.add(host, result.localUrl, token);
    } catch (err) {
      const message = (err as Error).message;
      this.store.upsertHost({ ...host, state: 'error', error: message });
      this.emit('host', { ...host, state: 'error', error: message });
      throw err;
    }
  }

  /* ------------------------------------------------------------ sessions */

  async startSession(opts: {
    workspaceId: string;
    profile: string;
    name?: string;
    cwd?: string;
    spawnedBy?: string | null;
  }): Promise<Session> {
    const count = this.sessions.list().filter((s) => s.workspaceId === opts.workspaceId).length;
    if (count >= this.spawnCap) {
      throw new Error(
        `workspace already has ${count} agents (cap ${this.spawnCap}); stop one first`,
      );
    }
    return this.sessions.start({
      workspaceId: opts.workspaceId,
      profileId: opts.profile,
      name: opts.name,
      cwd: opts.cwd,
      spawnedBy: opts.spawnedBy ?? null,
    });
  }

  async resumeWorkspace(workspaceId: string): Promise<Session[]> {
    const out: Session[] = [];
    for (const s of this.sessions.list()) {
      if (s.workspaceId !== workspaceId) continue;
      if (s.state === 'running' || s.state === 'starting') continue;
      try {
        out.push(await this.sessions.resume(s.id));
      } catch (err) {
        this.emit('error', new Error(`resume ${s.address}: ${(err as Error).message}`));
      }
    }
    return out;
  }

  moveWindow(sessionId: string, rect: WindowRect): void {
    this.sessions.moveWindow(sessionId, rect);
  }

  setViewport(v: Viewport): void {
    this.store.saveViewport(v);
  }

  /* ------------------------------------------------- AgentApi (MCP tools) */

  private requireSession(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error('your session is no longer known to the hub');
    return s;
  }

  async whoami(sessionId: string) {
    const s = this.requireSession(sessionId);
    const ws = this.store.getWorkspace(s.workspaceId);
    return {
      address: s.address,
      workspace: ws?.name ?? null,
      cwd: s.cwd,
      profile: s.profile,
      spawnedBy: s.spawnedBy ? this.sessions.get(s.spawnedBy)?.address ?? null : null,
    };
  }

  /**
   * One flat directory across every hub. An agent should not have to know or
   * care whether a peer is on this machine or a remote one; the address is
   * the whole interface.
   */
  async listAgents(sessionId: string, workspace?: string) {
    const me = this.requireSession(sessionId);
    const wsById = new Map(this.store.listWorkspaces().map((w) => [w.id, w]));

    const local = this.sessions.list().map((s) => ({
      address: s.address,
      workspace: wsById.get(s.workspaceId)?.name ?? null,
      profile: s.profile,
      state: s.state,
      status: s.status,
      statusText: s.statusText,
      host: 'local' as string,
      isYou: s.id === me.id,
    }));

    const hostLabels = new Map(this.store.listHosts().map((h) => [h.id, h.label]));
    const remote = this.peers.sessions().map((s) => {
      // A remote session's workspace row lives on its own hub, not here, so
      // the workspace name comes from the address and the host from the
      // registry rather than from a local join that would always miss.
      const hostId = this.peers.hostIdFor(s.address);
      return {
        address: s.address,
        workspace: s.address.split('/')[0] ?? null,
        profile: s.profile,
        state: s.state,
        status: s.status,
        statusText: s.statusText,
        host: (hostId ? hostLabels.get(hostId) : undefined) ?? 'remote',
        isYou: false,
      };
    });

    return [...local, ...remote].filter((a) => !workspace || a.workspace === workspace);
  }

  async sendMessage(sessionId: string, to: string, text: string) {
    const me = this.requireSession(sessionId);
    if (me.address === to) throw new Error('cannot send a message to yourself');

    // An unknown address goes down the local path deliberately: the router
    // records the failed attempt with its reason, which is what keeps the
    // promise that no message is ever dropped silently.
    if (this.locate(to) !== 'remote') {
      const r = this.router.send(me.address, to, text);
      if (!r.delivered) throw new Error(r.error ?? 'delivery failed');
      return { delivered: true, to, deliveredAt: r.deliveredAt };
    }

    // Cross-host: the peer performs the actual injection. We still record the
    // attempt locally so the message log and the canvas edge are complete.
    const id = randomUUID();
    const sentAt = Date.now();
    try {
      await this.peers.deliver(me.address, to, text);
      const m: Message = {
        id, fromAddr: me.address, toAddr: to, body: text,
        sentAt, deliveredAt: Date.now(), deliveryState: 'delivered', error: null,
      };
      this.store.insertMessage(m);
      this.emit('message', m);
      return { delivered: true, to, deliveredAt: m.deliveredAt };
    } catch (err) {
      const m: Message = {
        id, fromAddr: me.address, toAddr: to, body: text,
        sentAt, deliveredAt: null, deliveryState: 'failed',
        error: (err as Error).message,
      };
      this.store.insertMessage(m);
      this.emit('message', m);
      throw err;
    }
  }

  async spawnAgent(
    sessionId: string,
    opts: { profile?: string; name?: string; workspace?: string; prompt?: string },
  ) {
    const me = this.requireSession(sessionId);
    const ws = opts.workspace
      ? this.store.getWorkspaceByName(opts.workspace)
      : this.store.getWorkspace(me.workspaceId);
    if (!ws) throw new Error(`unknown workspace "${opts.workspace}"`);

    const child = await this.startSession({
      workspaceId: ws.id,
      profile: opts.profile ?? me.profile,
      name: opts.name,
      spawnedBy: me.id,
    });

    if (opts.prompt) {
      // The child's CLI is not listening yet; wait for it to come up before
      // typing, otherwise the first instruction is written into the void.
      void this.deliverInitialPrompt(child.id, me.address, opts.prompt);
    }

    return {
      address: child.address,
      workspace: ws.name,
      profile: child.profile,
      promptQueued: !!opts.prompt,
    };
  }

  /**
   * Wait for a freshly spawned agent to produce output (its prompt) before
   * injecting the first instruction. Bounded so a CLI that never prints
   * cannot leave this hanging.
   */
  private async deliverInitialPrompt(
    sessionId: string,
    fromAddr: string,
    prompt: string,
  ): Promise<void> {
    const pty = this.sessions.pty(sessionId);
    if (!pty) return;

    const ready = await new Promise<boolean>((res) => {
      let settled = false;
      const done = (v: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pty.off('data', onData);
        res(v);
      };
      const onData = () => setTimeout(() => done(true), 1200);
      const timer = setTimeout(() => done(false), 20_000);
      timer.unref?.();
      pty.on('data', onData);
    });

    if (!ready || !pty.running) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const mode = this.profiles.get(session.profile)?.inject ?? 'bracketed';
    try {
      this.sessions.write(
        sessionId,
        encodeInjection(`[from ${fromAddr}] ${prompt}`, mode),
      );
    } catch {
      // The agent died between the readiness check and the write; the message
      // log already reflects that it never started.
    }
  }

  async readScreen(sessionId: string, address: string, lines?: number) {
    this.requireSession(sessionId);
    if (this.locate(address) === 'remote') {
      return this.peers.readScreen(address, lines);
    }
    const target = this.sessions.getByAddress(address);
    if (!target) throw new Error(`no agent at address "${address}"`);
    const pty = this.sessions.pty(target.id);
    if (!pty) {
      const snap = this.store.getSnapshot(target.id);
      if (!snap) throw new Error(`agent "${address}" has no screen to read`);
      return { address, running: false, screen: '(not running; last saved screen only)' };
    }
    return { address, running: pty.running, screen: pty.tailLines(lines ?? 40) };
  }

  async setStatus(sessionId: string, text: string) {
    const s = this.requireSession(sessionId);
    this.sessions.setStatusText(s.id, text);
    return { ok: true };
  }

  async stopAgent(sessionId: string, address: string) {
    const me = this.requireSession(sessionId);
    const target = this.sessions.getByAddress(address);
    if (!target) throw new Error(`no agent at address "${address}"`);
    if (target.id === me.id) throw new Error('use your own exit command to stop yourself');
    // An agent may only stop what it created. Otherwise a single confused
    // agent could take down the whole canvas.
    if (target.spawnedBy !== me.id) {
      throw new Error(`"${address}" was not spawned by you; only its spawner may stop it`);
    }
    this.sessions.stop(target.id);
    return { stopped: address };
  }

  /* ------------------------------------------------------------ lifecycle */

  messages(): Message[] {
    return this.store.listMessages();
  }

  shutdown(): void {
    for (const t of this.tunnels.values()) void t.dispose().catch(() => {});
    this.tunnels.clear();
    this.peers.closeAll();
    this.sessions.shutdown();
    try {
      this.db.close();
    } catch {
      // Already closed.
    }
  }
}

function uniqueWorkspaceName(desired: string, taken: string[]): string {
  const set = new Set(taken);
  if (!set.has(desired)) return desired;
  for (let n = 2; n < 1000; n++) {
    if (!set.has(`${desired}-${n}`)) return `${desired}-${n}`;
  }
  throw new Error(`could not allocate a workspace name for "${desired}"`);
}
