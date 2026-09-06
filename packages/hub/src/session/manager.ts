import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  makeAddress,
  uniqueName,
  type Session,
  type WindowRect,
} from '@termscape/protocol';
import { DEFAULT_WINDOW, Store, type SessionLaunchSpec } from '../db/store.js';
import { ProfileRegistry, template, templateAll, type AgentProfile } from '../agents/profiles.js';
import { resolveCommand } from '../agents/resolve.js';
import { TokenRegistry } from '../agents/tokens.js';
import { writeWiring } from '../agents/wiring.js';
import { PtySession } from './pty.js';

/** Debounce for persisting the serialized screen of an active session. */
const SNAPSHOT_DEBOUNCE_MS = 5_000;
/**
 * How long titles are pooled before one write and one broadcast. An agent
 * rewrites its terminal title as it works, and every change would otherwise be
 * a row update and a frame to every browser.
 */
const TITLE_COALESCE_MS = 250;
/** Debounce for persisting window geometry while a window is being dragged. */
export const LAYOUT_DEBOUNCE_MS = 250;

export interface StartOptions {
  workspaceId: string;
  profileId: string;
  /**
   * The template this came from and what it resolved to. Values, never argv:
   * the agent declares how to spell them, which is the only way one template
   * can name a model for CLIs that all spell `--model` differently.
   */
  template?: string | null;
  model?: string;
  effort?: string;
  name?: string;
  cwd?: string;
  spawnedBy?: string | null;
  cols?: number;
  rows?: number;
  window?: WindowRect;
}

export interface ManagerEvents {
  session: (s: Session) => void;
  /**
   * The address travels with the id: after the delete there is nothing left
   * to look it up from, and peers address sessions by name.
   */
  removed: (sessionId: string, address: string | null) => void;
  data: (sessionId: string, chunk: string) => void;
  exit: (sessionId: string, code: number) => void;
}

/**
 * Owns every PTY on this hub, plus the persistence of their state.
 *
 * The invariant worth stating: SQLite always holds enough to redraw the canvas
 * and relaunch each agent. Live objects here are a cache over that, never the
 * other way round.
 */
export class SessionManager extends EventEmitter {
  private readonly live = new Map<string, PtySession>();
  private readonly snapshotTimers = new Map<string, NodeJS.Timeout>();
  private readonly layoutTimers = new Map<string, NodeJS.Timeout>();
  /** Latest title per session, waiting for the coalescing window to close. */
  private readonly pendingTitles = new Map<string, string>();
  private titleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileRegistry,
    readonly tokens: TokenRegistry,
    private hubOrigin: string,
  ) {
    super();
  }

  setHubOrigin(origin: string): void {
    this.hubOrigin = origin;
  }

  /* ----------------------------------------------------------- accessors */

  private isResumable = (profile: string): boolean => this.profiles.isResumable(profile);

  list(): Session[] {
    return this.store.listSessions(this.isResumable).map((s) => this.decorate(s));
  }

  get(id: string): Session | null {
    const s = this.store.getSession(id, this.isResumable);
    return s ? this.decorate(s) : null;
  }

  getByAddress(address: string): Session | null {
    return this.list().find((s) => s.address === address) ?? null;
  }

  /** Overlay live runtime status onto the persisted row. */
  private decorate(s: Session): Session {
    const p = this.live.get(s.id);
    if (!p) return s;
    return { ...s, status: p.status, pid: p.pid, cols: p.cols, rows: p.rows };
  }

  pty(id: string): PtySession | null {
    return this.live.get(id) ?? null;
  }

  /* -------------------------------------------------------------- launch */

  /** Build the resolved argv/env for a launch. `resume` swaps in --resume. */
  private buildSpec(
    session: {
      id: string;
      address: string;
      cwd: string;
      agentSessionUuid: string | null;
      model?: string | null;
      effort?: string | null;
    },
    workspaceName: string,
    profile: AgentProfile,
    peers: string[],
    resume: boolean,
  ): SessionLaunchSpec {
    const token = this.tokens.mint(session.id);
    let vars: Record<string, string> = {
      address: session.address,
      workspace: workspaceName,
      cwd: session.cwd,
      session_uuid: session.agentSessionUuid ?? '',
      default_shell: profile.command,
      model: session.model ?? '',
      effort: session.effort ?? '',
    };

    if (profile.mcp) {
      const w = writeWiring({
        sessionId: session.id,
        address: session.address,
        workspace: workspaceName,
        cwd: session.cwd,
        profile,
        token,
        hubOrigin: this.hubOrigin,
        peers,
      });
      vars = {
        ...vars,
        mcp_config_path: w.mcpConfigPath,
        settings_path: w.settingsPath,
        brief_path: w.briefPath,
      };
    }

    /*
     * The model and effort fragments are appended, and a fragment for a value
     * the session does not have disappears entirely rather than expanding to
     * an empty string - `--model ''` is not the same request as no --model at
     * all, and the CLIs treat it as an error.
     *
     * Appending is also what makes resume keep them: resume swaps the base
     * args for resumeArgs and these ride along either way, so an agent comes
     * back on the model it left with. That is the whole reason the values are
     * on the session row rather than read from the template, which may have
     * been edited since.
     */
    const base = resume && profile.resumeArgs ? profile.resumeArgs : profile.args;
    const argTemplate = [
      ...base,
      ...(session.model && profile.modelArgs ? profile.modelArgs : []),
      ...(session.effort && profile.effortArgs ? profile.effortArgs : []),
    ];

    // Resolve to an absolute path here rather than at spawn time, so the
    // stored argv is exactly what will be run and a missing CLI is reported
    // as a clear error instead of node-pty's bare "File not found:".
    const { argv } = resolveCommand(
      template(profile.command, vars),
      templateAll(argTemplate, vars),
    );

    return {
      argv,
      env: Object.fromEntries(
        Object.entries(profile.env).map(([k, v]) => [k, templateAll([v], vars)[0]!]),
      ),
    };
  }

  private peersOf(workspaceId: string, exceptId?: string): string[] {
    return this.list()
      .filter((s) => s.workspaceId === workspaceId && s.id !== exceptId)
      .map((s) => s.address);
  }

  async start(opts: StartOptions): Promise<Session> {
    const ws = this.store.getWorkspace(opts.workspaceId);
    if (!ws) throw new Error(`unknown workspace ${opts.workspaceId}`);
    const profile = this.profiles.require(opts.profileId);

    const name = uniqueName(
      opts.name ?? opts.profileId,
      this.store.namesInWorkspace(ws.id),
    );
    const id = randomUUID();
    const cwd = opts.cwd ?? ws.rootPath;
    if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`);

    const now = Date.now();
    const session: Session = {
      id,
      workspaceId: ws.id,
      name,
      address: makeAddress(ws.name, name),
      profile: profile.id,
      template: opts.template ?? null,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      cwd,
      // Claude Code keys its conversation store by cwd + this uuid; holding on
      // to it is what makes --resume possible after a restart.
      agentSessionUuid: profile.resumeArgs ? randomUUID() : null,
      spawnedBy: opts.spawnedBy ?? null,
      state: 'starting',
      status: 'unknown',
      statusText: null,
      title: null,
      pid: null,
      exitCode: null,
      cols: opts.cols ?? 100,
      rows: opts.rows ?? 30,
      resumable: !!profile.resumeArgs,
      createdAt: now,
      exitedAt: null,
      lastActiveAt: now,
      window: opts.window ?? this.placeWindow(ws.id, opts.spawnedBy ?? null),
    };

    const spec = this.buildSpec(session, ws.name, profile, this.peersOf(ws.id), false);
    this.store.insertSession(session, spec);
    this.spawn(session, spec, profile);
    return this.get(id)!;
  }

  /** Bring a stopped session back, reusing its recorded argv and cwd. */
  async resume(sessionId: string): Promise<Session> {
    const s = this.store.getSession(sessionId, this.isResumable);
    if (!s) throw new Error(`unknown session ${sessionId}`);
    if (this.live.get(sessionId)?.running) return this.get(sessionId)!;

    const ws = this.store.getWorkspace(s.workspaceId);
    if (!ws) throw new Error(`unknown workspace ${s.workspaceId}`);
    const profile = this.profiles.require(s.profile);

    // Rebuild rather than replay the stored argv verbatim: the token must be
    // fresh and the wiring files must be rewritten for this run.
    const spec = this.buildSpec(
      s,
      ws.name,
      profile,
      this.peersOf(ws.id, s.id),
      !!profile.resumeArgs && !!s.agentSessionUuid,
    );
    this.store.setLaunchSpec(s.id, spec);
    this.spawn(s, spec, profile);
    return this.get(sessionId)!;
  }

  private spawn(session: Session, spec: SessionLaunchSpec, profile: AgentProfile): void {
    const existing = this.live.get(session.id);
    if (existing) existing.dispose();

    const p = new PtySession(
      session.id,
      session.cols,
      session.rows,
      profile.readyHint ? new RegExp(profile.readyHint) : null,
      profile.status,
    );
    this.live.set(session.id, p);

    // Restoring the persisted screen first means a resumed window shows its
    // prior content immediately rather than flashing empty.
    const snap = this.store.getSnapshot(session.id);
    if (snap) p.restore(snap.serialized);

    p.on('data', (chunk: string) => {
      this.emit('data', session.id, chunk);
      this.scheduleSnapshot(session.id);
    });
    p.on('status', () => this.emitSession(session.id));
    p.on('title', (title: string) => this.noteTitle(session.id, title));
    p.on('exit', ({ exitCode }: { exitCode: number }) => {
      this.persistSnapshot(session.id);
      this.tokens.revoke(session.id);
      this.store.updateSession(session.id, {
        state: 'exited',
        pid: null,
        exitCode,
        exitedAt: Date.now(),
      });
      this.emit('exit', session.id, exitCode);
      this.emitSession(session.id);
    });

    try {
      p.start({
        argv: spec.argv,
        env: spec.env,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
      });
      this.store.updateSession(session.id, {
        state: 'running',
        pid: p.pid,
        exitCode: null,
        exitedAt: null,
        lastActiveAt: Date.now(),
      });
    } catch (err) {
      this.store.updateSession(session.id, {
        state: 'failed',
        pid: null,
        exitedAt: Date.now(),
      });
      this.emitSession(session.id);
      throw err;
    }
    this.emitSession(session.id);
  }

  /* --------------------------------------------------------------- input */

  write(sessionId: string, data: string): void {
    const p = this.live.get(sessionId);
    if (!p?.running) throw new Error(`session ${sessionId} is not running`);
    p.write(data);
    this.store.updateSession(sessionId, { lastActiveAt: Date.now() });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const p = this.live.get(sessionId);
    p?.resize(cols, rows);
    this.store.updateSession(sessionId, { cols, rows });
  }

  setStatusText(sessionId: string, text: string): void {
    this.store.updateSession(sessionId, { statusText: text });
    this.emitSession(sessionId);
  }

  /**
   * A title the program in the PTY set for itself.
   *
   * An agent rewrites this as it works, several times a second, so the write
   * and the broadcast are held to the last value in a window rather than one
   * apiece. Unrefed: a pending title is never a reason to keep the process up.
   */
  private noteTitle(sessionId: string, title: string): void {
    this.pendingTitles.set(sessionId, title);
    if (this.titleTimer) return;
    this.titleTimer = setTimeout(() => {
      this.titleTimer = null;
      const batch = [...this.pendingTitles];
      this.pendingTitles.clear();
      for (const [id, t] of batch) {
        this.store.updateSession(id, { title: t });
        this.emitSession(id);
      }
    }, TITLE_COALESCE_MS);
    this.titleTimer.unref?.();
  }

  /** Called by the hooks endpoint: exact turn boundaries from the agent CLI. */
  setStatusFromHook(sessionId: string, status: 'busy' | 'idle'): void {
    this.live.get(sessionId)?.noteHook(status);
    this.emitSession(sessionId);
  }

  stop(sessionId: string): void {
    const p = this.live.get(sessionId);
    if (!p) return;
    this.persistSnapshot(sessionId);
    p.kill();
    this.tokens.revoke(sessionId);
    this.store.updateSession(sessionId, { state: 'stopped', pid: null });
    this.emitSession(sessionId);
  }

  remove(sessionId: string): void {
    // Capture the address before the row goes: peers address sessions by
    // name, and after the delete there is nothing left to look it up from.
    const address = this.get(sessionId)?.address ?? null;
    this.live.get(sessionId)?.dispose();
    this.live.delete(sessionId);
    this.clearTimer(this.snapshotTimers, sessionId);
    this.clearTimer(this.layoutTimers, sessionId);
    this.tokens.revoke(sessionId);
    this.store.removeSession(sessionId);
    this.emit('removed', sessionId, address);
  }

  /* ------------------------------------------------------------ snapshots */

  private scheduleSnapshot(sessionId: string): void {
    if (this.snapshotTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.snapshotTimers.delete(sessionId);
      this.persistSnapshot(sessionId);
    }, SNAPSHOT_DEBOUNCE_MS);
    // Never let a pending snapshot hold the process open at shutdown.
    t.unref?.();
    this.snapshotTimers.set(sessionId, t);
  }

  /** Screen only — the deliberate cost of the snapshot-only design. */
  persistSnapshot(sessionId: string): void {
    const p = this.live.get(sessionId);
    if (!p) return;
    try {
      this.store.saveSnapshot(sessionId, p.serializeForPersist(), p.cols, p.rows);
    } catch (err) {
      console.error(`[snapshot] ${sessionId}: ${(err as Error).message}`);
    }
  }

  persistAllSnapshots(): void {
    for (const id of this.live.keys()) this.persistSnapshot(id);
  }

  snapshotForAttach(sessionId: string): { serialized: string; cols: number; rows: number } | null {
    const p = this.live.get(sessionId);
    if (p) return { serialized: p.serializeForAttach(), cols: p.cols, rows: p.rows };
    // Not running: fall back to whatever the last persisted screen was.
    return this.store.getSnapshot(sessionId);
  }

  /* --------------------------------------------------------------- layout */

  moveWindow(sessionId: string, rect: WindowRect): void {
    this.clearTimer(this.layoutTimers, sessionId);
    const t = setTimeout(() => {
      this.layoutTimers.delete(sessionId);
      this.store.saveWindow(sessionId, rect);
    }, LAYOUT_DEBOUNCE_MS);
    t.unref?.();
    this.layoutTimers.set(sessionId, t);
  }

  /**
   * Place a new window: tucked below-right of its parent when spawned by
   * another agent, otherwise in the next free slot of a simple grid.
   */
  private placeWindow(workspaceId: string, parentId: string | null): WindowRect {
    const siblings = this.list().filter((s) => s.workspaceId === workspaceId);
    if (parentId) {
      const parent = this.get(parentId);
      if (parent) {
        return {
          ...DEFAULT_WINDOW,
          x: parent.window.x + 60,
          y: parent.window.y + parent.window.h + 40,
          z: parent.window.z + 1,
        };
      }
    }
    const all = this.list();
    const col = siblings.length % 3;
    const row = Math.floor(siblings.length / 3);
    const originX = all.length === siblings.length ? 0 : this.workspaceOriginX(workspaceId);
    return {
      ...DEFAULT_WINDOW,
      x: originX + col * (DEFAULT_WINDOW.w + 40),
      y: row * (DEFAULT_WINDOW.h + 40),
      z: siblings.length,
    };
  }

  /** Workspaces are laid out left to right so their groups do not overlap. */
  private workspaceOriginX(workspaceId: string): number {
    const order = this.store.listWorkspaces().findIndex((w) => w.id === workspaceId);
    return Math.max(0, order) * (DEFAULT_WINDOW.w + 40) * 3.5;
  }

  /* -------------------------------------------------------------- helpers */

  private clearTimer(map: Map<string, NodeJS.Timeout>, key: string): void {
    const t = map.get(key);
    if (t) {
      clearTimeout(t);
      map.delete(key);
    }
  }

  private emitSession(sessionId: string): void {
    const s = this.get(sessionId);
    if (s) this.emit('session', s);
  }

  /**
   * Startup reconciliation. Sessions cannot outlive the hub, so anything the
   * DB still calls running is stale and is marked stopped, ready to resume.
   */
  reconcileOnBoot(): void {
    for (const s of this.store.listSessions(this.isResumable)) {
      if (s.state === 'running' || s.state === 'starting') {
        this.store.updateSession(s.id, { state: 'stopped', pid: null });
      }
    }
  }

  shutdown(): void {
    this.persistAllSnapshots();
    for (const [id, p] of this.live) {
      p.dispose();
      this.store.updateSession(id, { state: 'stopped', pid: null });
    }
    this.live.clear();
    for (const t of this.snapshotTimers.values()) clearTimeout(t);
    for (const t of this.layoutTimers.values()) clearTimeout(t);
    this.snapshotTimers.clear();
    this.layoutTimers.clear();
    // The title timer is a single shared timeout rather than one per session,
    // which is exactly why it was missed here: it holds a write that would
    // land after the caller closes the database, and better-sqlite3 throws
    // rather than ignoring it. Unref keeps it from holding the process open;
    // it does not stop it firing while the process is still coming down.
    if (this.titleTimer) clearTimeout(this.titleTimer);
    this.titleTimer = null;
    this.pendingTitles.clear();
  }
}
