import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  encodeInjection,
  MAX_PENDING_PROPOSALS,
  parseAddress,
  slugify,
  type AgentProfileInfo,
  type AgentTemplateInfo,
  type Message,
  type Host,
  type PeerAgent,
  type PeerRelayAsk,
  type Session,
  type TemplateProposal,
  type Viewport,
  type WindowRect,
  type Workspace,
} from '@termscape/protocol';
import { openDb, type Db } from './db/index.js';
import { Store } from './db/store.js';
import { briefMode, ProfileRegistry } from './agents/profiles.js';
import { AgentDetector } from './agents/detect.js';
import { TemplateRegistry, validate as validateTemplate } from './agents/templates.js';
import { TokenRegistry } from './agents/tokens.js';
import { MessageRouter } from './agents/router.js';
import { SessionManager } from './session/manager.js';
import { briefFileFor } from './agents/wiring.js';
import type { AgentApi } from './mcp/server.js';
import { PeerRegistry } from './remote/registry.js';
import type { Uplink } from './remote/peer-serve.js';
import { deploy, type DeployResult } from './remote/deployer.js';
import { hubTarballPath } from './remote/tarball.js';
import { paths } from './paths.js';

export const HUB_VERSION = '0.1.0';

/**
 * How long changes are pooled before every attached machine is told the
 * canvas has moved on. A status change is a session change, and agents change
 * status several times a turn.
 */
const ANNOUNCE_COALESCE_MS = 300;

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
  /**
   * What the picker offers: an agent plus a model, an effort and a first task.
   *
   * Reassigned rather than mutated when a template is saved or removed: the
   * list is a merge of three sources and one write can change a row nobody
   * touched, so the answer is a fresh load rather than a patched one.
   */
  templates: TemplateRegistry;
  /** What of those profiles this machine actually has installed. */
  readonly agents: AgentDetector;
  readonly tokens: TokenRegistry;
  readonly sessions: SessionManager;
  readonly router: MessageRouter;
  readonly peers: PeerRegistry;
  /**
   * The link back to the canvas this hub was attached to, if it was. Null on a
   * hub that owns a canvas — which is what makes the difference between the
   * two roles a null check rather than a flag.
   */
  private uplink: Uplink | null = null;
  private announceTimer: NodeJS.Timeout | null = null;
  /** Live SSH tunnels, keyed by host id. Not persisted: they die with the hub. */
  private readonly tunnels = new Map<string, DeployResult>();
  private readonly spawnCap: number;
  /**
   * Proposals waiting on a human, newest last. In memory on purpose: the agent
   * waiting for the answer dies with the hub, so a proposal that outlived both
   * would be a dialog nobody could be told the outcome of.
   */
  private readonly proposals = new Map<string, TemplateProposal>();
  /**
   * How many browsers are looking. The hub cannot see its own sockets - the
   * server owns those - so it is told, and it only uses this to answer an
   * agent honestly about whether anyone is there to decide.
   */
  private viewers = 0;

  constructor(opts: HubOptions = {}) {
    super();
    this.db = openDb(opts.dbPath ?? paths.db());
    this.store = new Store(this.db);
    this.profiles = ProfileRegistry.load();
    this.templates = TemplateRegistry.load(this.profiles, this.store);
    this.agents = new AgentDetector(this.profiles);
    // A joined hub is the only thing that knows its own PATH, so it says so
    // rather than waiting to be asked again; peer-serve forwards this to the
    // canvas the same way it forwards session changes.
    this.agents.on('changed', (found: AgentProfileInfo[]) => this.emit('agents', found));
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
    this.peers.on('peerAgents', (hostId: string, found: AgentProfileInfo[]) =>
      this.emit('hostAgents', hostId, found),
    );
    this.peers.on('peerSession', (s: Session) => this.emit('session', s));
    this.peers.on('peerSessionRemoved', (addr: string) => this.emit('removed', addr, addr));
    this.peers.on('peerSessionsChanged', () => this.emit('peersChanged'));
    this.peers.on('output', (address: string, data: string) => {
      // Remote output is addressed by name; the browser keys on session id,
      // and for remote sessions the address *is* the id it was given.
      this.emit('data', address, data);
    });

    // A host asking us to act on an address it cannot resolve itself. We are
    // the only hub that knows where every address on this canvas lives, and
    // the answer travels back the way the question came.
    this.peers.on(
      'relay',
      (
        ask: PeerRelayAsk,
        reply: (ok: boolean, result: unknown, error: string | null) => void,
      ) => {
        const done = (p: Promise<unknown>) =>
          p.then(
            (result) => reply(true, result, null),
            (err: Error) => reply(false, null, err.message),
          );

        if (ask.t === 'deliver') return void done(this.deliverFrom(ask.from, ask.to, ask.body));
        return void done(this.readScreenAt(ask.address, ask.lines));
      },
    );

    // Every attached machine's view of the canvas is whatever we last told it,
    // so anything that changes who is running has to be followed by telling
    // them again.
    this.peers.on('directoryStale', () => this.scheduleAnnounce());
    this.on('session', () => this.scheduleAnnounce());
    this.on('removed', () => this.scheduleAnnounce());
    this.on('peersChanged', () => this.scheduleAnnounce());

    // Anything the DB still calls running died with the previous hub.
    this.sessions.reconcileOnBoot();
    this.reconcileHostsOnBoot();
  }

  /**
   * A persisted `connected` is a lie the moment this process starts: the
   * tunnels and sockets died with the last one. Mark every host down, then
   * redial the ones we know how to reach. Enrolled hosts are left alone —
   * they dial us, and arrive on their own.
   */
  private reconcileHostsOnBoot(): void {
    for (const host of this.store.listHosts()) {
      this.store.upsertHost({ ...host, state: 'disconnected', error: null });
      if (host.kind !== 'ssh') continue;
      void this.connectHost(host.id).catch((err) => {
        this.emit('hostLog', host.id, `reconnect failed: ${(err as Error).message}`);
      });
    }
  }

  /** Local sessions plus every session reported by a connected peer. */
  allSessions(): Session[] {
    return [...this.sessions.list(), ...this.peers.sessions()];
  }

  /**
   * Resolve an address to a local session, one on a peer we hold, one the
   * canvas told us about, or nothing.
   *
   * The three are exclusive by construction: a hub either owns the canvas and
   * has peers, or is attached to one and has an uplink. Never both.
   */
  private locate(address: string): 'local' | 'remote' | 'uplink' | null {
    if (this.sessions.getByAddress(address)) return 'local';
    if (this.peers.find(address)) return 'remote';
    return this.uplink?.agents().some((a) => a.address === address) ? 'uplink' : null;
  }

  /**
   * Attach this hub to the canvas reachable over `uplink`.
   *
   * Called by whatever owns the socket, once, at wiring time. A hub that owns
   * its own canvas never calls it.
   */
  setUplink(uplink: Uplink | null): void {
    this.uplink = uplink;
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

  /**
   * Rename a workspace, or point it at a different folder.
   *
   * The rename is the fussy half. A workspace's name is the first segment of
   * every agent address in it (`workspace/agent`), and those addresses are
   * stored on the session rows, written into each agent's brief, and held by
   * peers on other machines. Rewriting all of that under running agents would
   * change what they had already been told they were called, so a rename is
   * refused while anything is running here. Stopping an agent is a cheap thing
   * to ask and an honest one; silently breaking message delivery is not.
   *
   * Repointing the folder is not fussy at all: a session records its own cwd
   * at launch and resume rebuilds from that, so only agents started afterwards
   * see the new path.
   */
  updateWorkspace(
    id: string,
    patch: { name?: string; rootPath?: string },
  ): Workspace {
    const ws = this.store.getWorkspace(id);
    if (!ws) throw new Error(`unknown workspace ${id}`);

    const next: { name?: string; rootPath?: string } = {};

    if (patch.rootPath !== undefined) {
      const abs = resolve(patch.rootPath);
      // Only a local folder can be checked from here; a remote one is the
      // other machine's to know about, exactly as it is on create.
      if (!ws.hostId && !existsSync(abs)) {
        throw new Error(`folder does not exist: ${abs}`);
      }
      if (abs !== ws.rootPath) next.rootPath = abs;
    }

    if (patch.name !== undefined) {
      const wanted = slugify(patch.name);
      if (!wanted) throw new Error('a workspace needs a name');
      if (wanted !== ws.name) {
        const running = this.sessions.list().filter((s) => s.workspaceId === id);
        if (running.length > 0) {
          throw new Error(
            `cannot rename while ${running.length} agent${running.length === 1 ? '' : 's'} ` +
              'here still exist: the name is part of their addresses. Remove them first.',
          );
        }
        if (this.store.getWorkspaceByName(wanted)) {
          throw new Error(`a workspace called "${wanted}" already exists`);
        }
        next.name = wanted;
      }
    }

    if (next.name === undefined && next.rootPath === undefined) return ws;

    this.store.updateWorkspace(id, next);
    const updated = this.store.getWorkspace(id)!;
    this.emit('workspace', updated);
    return updated;
  }

  async removeWorkspace(id: string): Promise<void> {
    const ws = this.store.getWorkspace(id);
    for (const s of this.sessions.list().filter((s) => s.workspaceId === id)) {
      this.sessions.remove(s.id);
    }

    // A workspace on a host owns no PTY here: its agents run over there, and
    // the peer has to be told about each one or they come back on the next
    // resync as windows belonging to a workspace that no longer exists. The
    // peer's own workspace id means nothing in this database, so they are
    // found the only way they can be - by the workspace half of the address.
    if (ws?.hostId) {
      for (const s of this.peers.sessions()) {
        if (parseAddress(s.address)?.workspace === ws.name) {
          await this.peers.removeSession(s.address);
        }
      }
    }

    this.store.removeWorkspace(id);
    this.emit('workspaceRemoved', id);
  }

  /* ----------------------------------------------------------- templates */

  /**
   * Create a template or replace one, from the panel.
   *
   * Refusals happen here, on the values, before anything is written - which is
   * the whole reason this carries a requestId. The rules are the loader's own,
   * called rather than restated: an agent that declares no way to spell a
   * model or an effort cannot be given one.
   *
   * An id `agents.toml` has claimed is refused outright instead of being
   * stored and then silently losing to the file at load. Storing it would
   * leave a row in the database that never appears in the list, which is a
   * worse thing to explain than a dialog that says no.
   */
  saveTemplate(input: {
    id: string;
    agent: string;
    description?: string | null;
    model?: string | null;
    effort?: string | null;
    prompt?: string | null;
  }): AgentTemplateInfo {
    const candidate = this.candidateTemplate(input);
    this.store.upsertTemplate({
      id: candidate.id,
      description: candidate.description,
      agent: candidate.agent,
      model: candidate.model ?? null,
      effort: candidate.effort ?? null,
      prompt: candidate.prompt ?? null,
    });
    this.reloadTemplates();
    return this.templates.info().find((t) => t.id === candidate.id)!;
  }

  /**
   * Everything that can say no about a template, in one place.
   *
   * Shared by the panel and by an agent's proposal so the two cannot drift:
   * an agent should be refused by exactly the rule a human would be, and a
   * proposal that would fail on accept must fail while the agent is still
   * there to be told why.
   */
  private candidateTemplate(input: {
    id: string;
    agent: string;
    description?: string | null;
    model?: string | null;
    effort?: string | null;
    prompt?: string | null;
  }): {
    id: string;
    description: string;
    agent: string;
    model?: string;
    effort?: string;
    prompt?: string;
    source: 'stored';
  } {
    const id = slugify(input.id);
    if (!id) throw new Error('a template needs a name');
    // `[template.reviewer]` parses as one table called `template`, which is
    // why that word cannot be a template id any more than it can be an agent.
    if (id === 'template') throw new Error('"template" is not usable as a name');

    const existing = this.templates.get(id);
    if (existing?.source === 'file') {
      throw new Error(
        `"${id}" is declared in agents.toml; edit it there, or pick another name`,
      );
    }

    const blank = (v: string | null | undefined): string | undefined => {
      const t = v?.trim();
      return t ? t : undefined;
    };

    const candidate = {
      id,
      description: blank(input.description) ?? this.profiles.get(input.agent)?.description ?? id,
      agent: input.agent,
      model: blank(input.model),
      effort: blank(input.effort),
      prompt: blank(input.prompt),
      source: 'stored' as const,
    };

    const problem = validateTemplate(candidate, this.profiles);
    if (problem) throw new Error(problem);
    return candidate;
  }

  /**
   * Remove a stored template.
   *
   * Nothing running is disturbed, and nothing pretends otherwise: a session
   * records what its template resolved to precisely so resume cannot drift, so
   * the agents this one started keep their model, their effort and their
   * ability to come back. Removing one that shadowed an agent's bare template
   * reveals that bare one again rather than emptying a row.
   */
  removeTemplate(id: string): void {
    const t = this.templates.get(id);
    if (!t) throw new Error(`unknown template "${id}"`);
    if (t.source === 'file') {
      throw new Error(`"${id}" is declared in agents.toml; remove it there`);
    }
    if (t.source === 'derived') {
      throw new Error(`"${id}" is ${t.agent}'s own template and is not stored`);
    }
    this.store.removeTemplate(id);
    this.reloadTemplates();
  }

  /**
   * Rebuild the merged list and tell everyone.
   *
   * Rebuilt rather than patched because the merge is what changed: one write
   * can alter a row nobody touched - removing a stored template reveals the
   * derived one under it - and only a fresh load knows that.
   */
  private reloadTemplates(): void {
    this.templates = TemplateRegistry.load(this.profiles, this.store);
    this.emit('templates', this.templates.info());
  }

  /* -------------------------------------------------- template proposals */

  /** Told by the server, which owns the sockets. */
  setViewers(n: number): void {
    this.viewers = n;
  }

  pendingProposals(): TemplateProposal[] {
    return [...this.proposals.values()];
  }

  /**
   * An agent asking for a template.
   *
   * Everything that can be refused is refused here, before a human is shown
   * anything: nobody should be asked to approve a template that cannot load.
   * What survives is put in front of whoever is watching, and the tool returns
   * at once - a call that blocked until somebody wandered back to the canvas
   * would be a stalled agent, and MCP clients time out.
   */
  async proposeTemplate(
    sessionId: string,
    input: {
      id: string;
      agent: string;
      description?: string;
      model?: string;
      effort?: string;
      prompt?: string;
    },
  ): Promise<{ proposalId: string; status: string; anyoneWatching: boolean; note: string }> {
    const me = this.requireSession(sessionId);

    const mine = [...this.proposals.values()].filter((p) => p.fromAddr === me.address);
    if (mine.length >= MAX_PENDING_PROPOSALS) {
      /*
       * Name them. The way this limit is actually reached is a human closing
       * the dialog without deciding, which leaves the proposal waiting and the
       * agent blocked - and an agent that can say *which* templates are stuck
       * lets them go and answer those, rather than reporting a number nobody
       * can act on.
       */
      throw new Error(
        `you have ${mine.length} template proposals still waiting on a human: ` +
          mine.map((p) => `"${p.template.id}"`).join(', ') +
          '. Tell them those are waiting in the panel, under templates, and that each ' +
          'can be added or declined there; you cannot propose another until one is ' +
          'answered.',
      );
    }

    // The same checks saveTemplate makes, run now rather than at accept time,
    // so a refusal reaches the agent that can do something about it instead of
    // the human who cannot.
    const candidate = this.candidateTemplate(input);

    const proposal: TemplateProposal = {
      id: randomUUID(),
      fromAddr: me.address,
      proposedAt: Date.now(),
      template: {
        id: candidate.id,
        agent: candidate.agent,
        description: candidate.description ?? null,
        model: candidate.model ?? null,
        effort: candidate.effort ?? null,
        prompt: candidate.prompt ?? null,
      },
    };
    this.proposals.set(proposal.id, proposal);
    this.emit('templateProposed', proposal);

    return {
      proposalId: proposal.id,
      status: 'awaiting review',
      anyoneWatching: this.viewers > 0,
      note:
        (this.viewers > 0
          ? 'A human has been shown this and can accept, edit or reject it.'
          : 'Nobody has the canvas open right now, so nobody has seen it yet; ' +
            'it will be shown when someone opens it.') +
        ` The template "${candidate.id}" does not exist until it is accepted, so do not` +
        ' try to start an agent from it yet. The answer will be typed into your terminal.',
    };
  }

  /**
   * A human's answer.
   *
   * What is accepted is what the dialog showed rather than what the agent
   * asked for, because this is a proposal and editing it is the likely path -
   * so the fields come back with the answer.
   */
  resolveTemplateProposal(
    proposalId: string,
    accept: boolean,
    edits: {
      id?: string;
      agent?: string;
      description?: string | null;
      model?: string | null;
      effort?: string | null;
      prompt?: string | null;
    } = {},
  ): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error('that proposal is no longer waiting');

    if (accept) {
      // Before removing it: a refusal here - a name the file claimed since,
      // say - should leave the dialog open with the proposal still live.
      const saved = this.saveTemplate({ ...proposal.template, ...edits });
      this.proposals.delete(proposalId);
      this.emit('templateProposalResolved', proposalId);
      this.tellAgent(
        proposal.fromAddr,
        `Your proposed template was accepted and saved as "${saved.id}"` +
          (saved.id === proposal.template.id ? '' : ` (you asked for "${proposal.template.id}")`) +
          `. It launches ${saved.agent}` +
          [saved.model && `on ${saved.model}`, saved.effort && `at ${saved.effort} effort`]
            .filter(Boolean)
            .join(' ')
            .replace(/^(.)/, ' $1') +
          '. You can start an agent from it now.',
      );
      return;
    }

    this.proposals.delete(proposalId);
    this.emit('templateProposalResolved', proposalId);
    this.tellAgent(
      proposal.fromAddr,
      `Your proposed template "${proposal.template.id}" was declined. Do not` +
        ' propose it again unless you are asked to; carry on with what you were doing.',
    );
  }

  /**
   * A notice from the hub itself, typed into an agent's terminal.
   *
   * Its own prefix, deliberately neither `[from <address>]` nor bare text: it
   * is not a peer talking and it is not the human either, and an agent that
   * mistook it for one of those would either reply into the void or treat it
   * as an instruction.
   */
  private tellAgent(address: string, text: string): void {
    const target = this.sessions.getByAddress(address);
    if (!target) return;
    const mode = this.profiles.get(target.profile)?.inject ?? 'bracketed';
    try {
      this.sessions.write(target.id, encodeInjection(`[termscape] ${text}`, mode));
    } catch {
      // The agent is gone. Nothing to tell and nothing to fix.
    }
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
      kind: 'ssh',
      sshHost: input.sshHost,
      sshUser: input.sshUser,
      sshPort: input.sshPort,
      platform: null,
      hubVersion: null,
      state: 'disconnected',
      lastSeenAt: null,
      error: null,
    };
    this.store.upsertHost({ ...host, keyRef: input.privateKeyPath ?? null });
    this.emit('host', host);
    return host;
  }

  /**
   * Correct a host's details after the fact.
   *
   * Nothing here reconnects: an ssh detail that was wrong is usually being
   * fixed while the host sits in `error`, and the reconnect is the next thing
   * the operator does on purpose. Saving and dialling in one step would also
   * mean a typo in the label re-runs a deploy.
   */
  updateHost(
    hostId: string,
    patch: {
      label?: string;
      sshHost?: string;
      sshUser?: string;
      sshPort?: number;
      privateKeyPath?: string;
    },
  ): Host {
    const host = this.store.getHost(hostId);
    if (!host) throw new Error(`unknown host ${hostId}`);

    const ssh = ['sshHost', 'sshUser', 'sshPort', 'privateKeyPath'] as const;
    if (host.kind !== 'ssh' && ssh.some((k) => patch[k] !== undefined)) {
      // An enrolled host dialled us and is reached over the socket it opened.
      // Storing ssh details for it would be storing something nothing reads.
      throw new Error(`${host.label} joined by itself; it has no ssh details to edit`);
    }

    const label = patch.label?.trim();
    const next: Host = {
      ...host,
      label: label || host.label,
      sshHost: patch.sshHost?.trim() ?? host.sshHost,
      sshUser: patch.sshUser?.trim() ?? host.sshUser,
      sshPort: patch.sshPort ?? host.sshPort,
    };
    if (next.kind === 'ssh' && (!next.sshHost || !next.sshUser)) {
      throw new Error('an ssh host needs a user and a host');
    }

    this.store.upsertHost({
      ...next,
      // upsertHost COALESCEs key_ref, so undefined keeps whatever is stored
      // and an empty string is the only way to say "back to the ssh agent".
      keyRef: patch.privateKeyPath === undefined ? null : patch.privateKeyPath.trim(),
    });
    this.emit('host', next);
    return next;
  }

  /**
   * Drop a host from the canvas, and stop the hub running on it.
   *
   * Stopping it matters more than it looks: that hub is a daemon on someone
   * else's machine, and if it keeps running it holds its own install open —
   * on Windows an in-use .node cannot be deleted, so re-joining that machine
   * fails on a permission error rather than replacing the files.
   */
  async removeHost(hostId: string): Promise<void> {
    await this.peers.requestShutdown(hostId).catch(() => false);
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
    if (host.kind !== 'ssh' || !host.sshHost || !host.sshUser) {
      throw new Error(
        `"${host.label}" enrolled itself and dials this hub; there is nothing here to connect to. ` +
          'Re-run the join command on that machine if it has not come back.',
      );
    }

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
        packagePath: hubTarballPath() ?? undefined,
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

  /**
   * Turn what the picker sent into an agent, a model and an effort.
   *
   * `profile` on the wire is a *template* id, and it is still called profile
   * because every agent has a bare template under its own name - so the value
   * a client sent before templates existed still resolves, to the same thing
   * it always did. Anything the caller passed explicitly beats the template,
   * which is what makes the dialog's model dropdown an override rather than a
   * second source of truth.
   */
  private resolveTemplate(opts: {
    profile: string;
    model?: string;
    effort?: string;
    prompt?: string;
  }): { agent: string; template: string | null; model?: string; effort?: string; prompt?: string } {
    const t = this.templates.get(opts.profile);
    if (!t) {
      // Not a template: an agent id straight from spawn_agent or an older
      // client. Nothing has been chosen for it, which is today's behaviour.
      return {
        agent: opts.profile,
        template: null,
        model: opts.model,
        effort: opts.effort,
        prompt: opts.prompt,
      };
    }
    if (t.error) throw new Error(`template "${t.id}": ${t.error}`);
    return {
      agent: t.agent,
      template: t.id,
      model: opts.model ?? t.model,
      effort: opts.effort ?? t.effort,
      prompt: opts.prompt ?? t.prompt,
    };
  }

  async startSession(opts: {
    workspaceId: string;
    profile: string;
    model?: string;
    effort?: string;
    prompt?: string;
    name?: string;
    cwd?: string;
    spawnedBy?: string | null;
  }): Promise<Session> {
    const ws = this.store.getWorkspace(opts.workspaceId);
    if (!ws) throw new Error(`unknown workspace ${opts.workspaceId}`);
    const picked = this.resolveTemplate(opts);

    // A workspace that belongs to a host runs its agents there. The peer owns
    // the PTY; what comes back is a session we show on our own canvas.
    if (ws.hostId) {
      const spawner = opts.spawnedBy ? this.sessions.get(opts.spawnedBy) : null;
      // Resolved values cross, never the template id: a template is config
      // and the two machines do not share config, so a name that means "opus,
      // high effort" here may mean nothing over there. The id travels only so
      // the window can say which one was picked.
      return this.peers.startSession(ws.hostId, {
        workspaceName: ws.name,
        rootPath: ws.rootPath,
        profile: picked.agent,
        template: picked.template,
        model: picked.model,
        effort: picked.effort,
        prompt: picked.prompt,
        name: opts.name,
        spawnedByAddress: spawner?.address ?? null,
      });
    }

    return this.startResolved({ ...opts, ...picked });
  }

  /**
   * Start an agent whose template has already been resolved to values.
   *
   * Its own entry point because the peer path must not resolve again. A
   * template is config and the two machines do not share config: if this hub
   * happened to declare `[template.claude]` with a model, re-resolving an
   * agent id the canvas sent would apply a choice the canvas never made.
   */
  async startResolved(opts: {
    workspaceId: string;
    agent: string;
    template?: string | null;
    model?: string;
    effort?: string;
    prompt?: string;
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
    const session = await this.sessions.start({
      workspaceId: opts.workspaceId,
      profileId: opts.agent,
      template: opts.template ?? null,
      model: opts.model,
      effort: opts.effort,
      // A window called "reviewer" says more than one called "claude", so the
      // template names the agent when nothing else did.
      name: opts.name ?? opts.template ?? undefined,
      cwd: opts.cwd,
      spawnedBy: opts.spawnedBy ?? null,
    });

    /*
     * Typed in once the CLI is up rather than written into argv, where it
     * would be a different thing entirely - and not immediately, because it
     * would land before the program is reading. Not awaited: the window
     * should appear now, and the instruction arrives when the agent is ready.
     *
     * For an agent whose brief has no flag to ride in on, the brief goes
     * first, in the same injection rather than a separate one. Two would be
     * two turns - the agent would answer the brief before being told what to
     * do, and the second would have to wait out the first.
     */
    const opening = [this.typedBrief(session), opts.prompt]
      .filter((part): part is string => !!part)
      .join('\n\n');
    if (opening) void this.deliverOpeningInstruction(session.id, opening);

    return session;
  }

  /**
   * The brief for an agent that cannot be handed one, or null.
   *
   * Read back off disk rather than re-rendered: the wiring wrote exactly this
   * text a moment ago, and rendering it twice is two chances to render it
   * differently. A profile with `brief: 'flag'` returns null here because its
   * argv already carries the path.
   */
  private typedBrief(session: Session): string | null {
    const profile = this.profiles.get(session.profile);
    if (!profile || briefMode(profile) !== 'typed') return null;
    try {
      return readFileSync(briefFileFor(session.id), 'utf8');
    } catch {
      // The brief is context, not the task. An agent that came up without it
      // is worse off, not broken, and refusing to start it would be worse.
      return null;
    }
  }

  /**
   * Bring a stopped session back, and re-brief it if its brief was typed.
   *
   * The re-brief is why this exists rather than callers reaching for
   * `sessions.resume` directly. A CLI that had to be told where it is by
   * having text typed at it remembers none of that across a restart, and
   * neither of the two in that position is resumable in the first place - so
   * what comes back is a fresh conversation that has never been told it has an
   * address or any peers.
   */
  async resumeSession(sessionId: string): Promise<Session> {
    const session = await this.sessions.resume(sessionId);
    const brief = this.typedBrief(session);
    if (brief) void this.deliverOpeningInstruction(session.id, brief);
    return session;
  }

  async resumeWorkspace(workspaceId: string): Promise<Session[]> {
    const out: Session[] = [];
    for (const s of this.sessions.list()) {
      if (s.workspaceId !== workspaceId) continue;
      if (s.state === 'running' || s.state === 'starting') continue;
      try {
        out.push(await this.resumeSession(s.id));
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

    // What the canvas told us about, on a hub attached to one. Its own view
    // is the only complete one, so this is where an agent on an attached
    // machine learns that anything exists beyond this machine.
    const fromCanvas = (this.uplink?.agents() ?? []).map((a) => ({ ...a, isYou: false }));

    return [...local, ...remote, ...fromCanvas].filter(
      (a) => !workspace || a.workspace === workspace,
    );
  }

  async sendMessage(sessionId: string, to: string, text: string) {
    const me = this.requireSession(sessionId);
    if (me.address === to) throw new Error('cannot send a message to yourself');
    return this.deliverFrom(me.address, to, text);
  }

  /**
   * Tell every attached machine who is on the canvas.
   *
   * Coalesced, because a status change is a session change and agents change
   * status several times a turn; the directory only needs to be right once the
   * dust settles. Unrefed so a pending announcement never holds the hub up.
   */
  private scheduleAnnounce(): void {
    // Most hubs have nobody to tell: one that owns a canvas with no machines
    // attached, and every hub that is itself an attached machine.
    if (this.announceTimer || !this.peers.any) return;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = null;
      this.peers.announce((hostId) => this.directoryFor(hostId));
    }, ANNOUNCE_COALESCE_MS);
    this.announceTimer.unref?.();
  }

  /**
   * The canvas as one machine on it should see it: everything, minus that
   * machine's own agents. It has those already, and sending them back would
   * have every agent over there listed twice.
   */
  private directoryFor(hostId: string): PeerAgent[] {
    const wsById = new Map(this.store.listWorkspaces().map((w) => [w.id, w]));
    const hostLabels = new Map(this.store.listHosts().map((h) => [h.id, h.label]));

    const here = this.sessions.list().map((s) => ({
      address: s.address,
      workspace: wsById.get(s.workspaceId)?.name ?? null,
      profile: s.profile,
      state: s.state,
      status: s.status,
      statusText: s.statusText,
      // What the machine that owns the canvas is called, from anywhere else.
      host: 'canvas',
    }));

    const elsewhere = this.peers
      .sessions()
      .filter((s) => this.peers.hostIdFor(s.address) !== hostId)
      .map((s) => ({
        address: s.address,
        workspace: s.address.split('/')[0] ?? null,
        profile: s.profile,
        state: s.state,
        status: s.status,
        statusText: s.statusText,
        host: hostLabels.get(this.peers.hostIdFor(s.address) ?? '') ?? 'remote',
      }));

    return [...here, ...elsewhere];
  }

  /**
   * Deliver on behalf of an address this hub has already established.
   *
   * Three ways out, and which one is taken is the only difference between an
   * agent in the next window, one on a machine this hub holds, and one only
   * the canvas can reach. No caller sees which.
   */
  async deliverFrom(fromAddr: string, to: string, text: string) {
    const where = this.locate(to);

    // An unknown address goes down the local path deliberately: the router
    // records the failed attempt with its reason, which is what keeps the
    // promise that no message is ever dropped silently.
    if (where === 'local' || where === null) {
      const r = this.router.send(fromAddr, to, text);
      if (!r.delivered) throw new Error(r.error ?? 'delivery failed');
      return { delivered: true, to, deliveredAt: r.deliveredAt };
    }

    // Off this machine: whoever owns the PTY performs the injection. We still
    // record the attempt locally so the message log and the canvas edge are
    // complete on this side too.
    const id = randomUUID();
    const sentAt = Date.now();
    try {
      if (where === 'remote') await this.peers.deliver(fromAddr, to, text);
      // Only the canvas knows where every address lives, so an attached hub
      // hands the message up rather than trying to route it itself.
      else await this.uplink!.ask({ t: 'deliver', from: fromAddr, to, body: text });
      const m: Message = {
        id, fromAddr, toAddr: to, body: text,
        sentAt, deliveredAt: Date.now(), deliveryState: 'delivered', error: null,
      };
      this.store.insertMessage(m);
      this.emit('message', m);
      return { delivered: true, to, deliveredAt: m.deliveredAt };
    } catch (err) {
      const m: Message = {
        id, fromAddr, toAddr: to, body: text,
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

    // The child starts the way its parent did: from the same template, so the
    // model and effort the template chose are not silently dropped in favour
    // of the bare agent's defaults. A template deleted since the parent
    // started falls back to the agent itself; a profile the spawning agent
    // named explicitly always wins.
    const inherit =
      opts.profile ??
      (me.template && this.templates.get(me.template) ? me.template : me.profile);

    const child = await this.startSession({
      workspaceId: ws.id,
      profile: inherit,
      name: opts.name,
      spawnedBy: me.id,
    });

    if (opts.prompt) {
      // The child's CLI is not listening yet; wait for it to come up before
      // typing, otherwise the first instruction is written into the void.
      if (ws.hostId) {
        // The child's PTY is on the peer, so the readiness wait belongs there
        // too; a plain delivery is the only thing this side can do.
        void this.peers
          .deliver(me.address, child.address, opts.prompt)
          .catch(() => {
            // Recorded by the message log on the owning hub; a spawn that
            // succeeded should not fail because the greeting did not land.
          });
      } else {
        void this.deliverInitialPrompt(child.id, me.address, opts.prompt);
      }
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
    // A spawned agent's first task came from another agent, so it is attributed
    // exactly as any other message from that agent would be.
    await this.typeWhenReady(sessionId, `[from ${fromAddr}] ${prompt}`);
  }

  /**
   * A template's opening instruction, typed in plainly.
   *
   * Deliberately not through deliverInitialPrompt: that prefixes
   * `[from <address>]`, which is right for a message from a peer and wrong
   * for an instruction from the human sitting in front of the canvas. The
   * agent's brief tells it that a `[from ...]` line is a colleague rather than
   * the human, so wearing that prefix here would be a lie about who is asking.
   */
  private async deliverOpeningInstruction(
    sessionId: string,
    prompt: string,
  ): Promise<void> {
    await this.typeWhenReady(sessionId, prompt);
  }

  /**
   * Wait for the CLI to be up, then type. Written straight away the text lands
   * before the program is reading it; the wait is for output to arrive and
   * then pause, which is as close to "it has drawn its prompt" as this gets
   * without knowing the CLI.
   */
  private async typeWhenReady(sessionId: string, text: string): Promise<void> {
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
      this.sessions.write(sessionId, encodeInjection(text, mode));
    } catch {
      // The agent died between the readiness check and the write; the message
      // log already reflects that it never started.
    }
  }

  async readScreen(sessionId: string, address: string, lines?: number) {
    this.requireSession(sessionId);
    return this.readScreenAt(address, lines);
  }

  /**
   * read_screen for a caller this hub has already established — either an
   * agent of its own, or a peer that authenticated one and is asking on its
   * behalf. Resolves the address the same three ways a delivery does.
   */
  private async readScreenAt(address: string, lines?: number) {
    const where = this.locate(address);
    if (where === 'remote') return this.peers.readScreen(address, lines);
    if (where === 'uplink') {
      return this.uplink!.ask<{ address: string; running: boolean; screen: string }>({
        t: 'readScreen',
        address,
        lines,
      });
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
    if (!target) {
      // Spawn lineage lives on the hub that owns the session, so the
      // spawned-by rule below is enforced over there, by that hub.
      if (this.locate(address) === 'remote') {
        await this.peers.stopSession(address);
        return { stopped: address };
      }
      throw new Error(`no agent at address "${address}"`);
    }
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
