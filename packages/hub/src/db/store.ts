import {
  makeAddress,
  type Host,
  type Message,
  type Session,
  type Viewport,
  type WindowRect,
  type Workspace,
} from '@termscape/protocol';
import type { Db } from './index.js';

/** Row shapes as they come back from SQLite (snake_case, 0/1 booleans). */
interface SessionRow {
  id: string;
  workspace_id: string;
  name: string;
  profile: string;
  template: string | null;
  model: string | null;
  effort: string | null;
  cwd: string;
  agent_session_uuid: string | null;
  argv_json: string;
  env_json: string;
  template_env_json: string | null;
  spawned_by: string | null;
  state: string;
  status_text: string | null;
  title: string | null;
  pid: number | null;
  exit_code: number | null;
  cols: number;
  rows: number;
  created_at: number;
  exited_at: number | null;
  last_active_at: number;
  workspace_name: string;
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  z: number | null;
  collapsed: number | null;
}

export const DEFAULT_WINDOW: WindowRect = {
  x: 0,
  y: 0,
  w: 720,
  h: 460,
  z: 0,
  collapsed: false,
};

/** Persisted fields that live only in the DB, not on the wire Session. */
export interface SessionLaunchSpec {
  argv: string[];
  env: Record<string, string>;
}

/**
 * A template the user made from the panel, as stored.
 *
 * Deliberately not `AgentTemplate`: that one carries a resolved description
 * and the reason it cannot be used, both of which are worked out against the
 * profiles at load. This is only what was typed.
 */
export interface StoredTemplate {
  id: string;
  description: string | null;
  agent: string;
  model: string | null;
  effort: string | null;
  prompt: string | null;
  /** Extra environment for the agent process. Empty when it sets none. */
  env: Record<string, string>;
}

interface StoredTemplateRow {
  id: string;
  description: string | null;
  agent: string;
  model: string | null;
  effort: string | null;
  prompt: string | null;
  env_json: string | null;
  created_at: number;
}

/**
 * A JSON column back as a string map, tolerating anything that is not one.
 *
 * Rows predating the column are null, and a hand-edited database is not a
 * reason to refuse to start: an unreadable value is treated as "none set",
 * which is what it was before the column existed.
 */
function envFromJson(json: string | null): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

export class Store {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------- hosts */

  listHosts(): Host[] {
    const rows = this.db.prepare('SELECT * FROM host ORDER BY label').all() as any[];
    // ssh_host/ssh_user are NOT NULL in the schema and enrolled hosts have
    // neither, so '' is the stored sentinel. See migration 3.
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      kind: r.kind ?? 'ssh',
      sshHost: r.ssh_host || null,
      sshUser: r.ssh_user || null,
      sshPort: r.ssh_port,
      platform: r.platform ?? null,
      hubVersion: r.hub_version,
      state: r.state,
      lastSeenAt: r.last_seen_at,
      error: r.error,
    }));
  }

  getHost(id: string): Host | null {
    return this.listHosts().find((h) => h.id === id) ?? null;
  }

  upsertHost(h: Host & { keyRef?: string | null; hostToken?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO host (id, label, kind, ssh_host, ssh_user, ssh_port, key_ref,
                           host_token, platform, hub_version, state, last_seen_at, error)
         VALUES (@id, @label, @kind, @sshHost, @sshUser, @sshPort, @keyRef,
                 @hostToken, @platform, @hubVersion, @state, @lastSeenAt, @error)
         ON CONFLICT(id) DO UPDATE SET
           label=@label, kind=@kind, ssh_host=@sshHost, ssh_user=@sshUser,
           ssh_port=@sshPort, key_ref=COALESCE(@keyRef, key_ref),
           host_token=COALESCE(@hostToken, host_token), platform=@platform,
           hub_version=@hubVersion, state=@state, last_seen_at=@lastSeenAt,
           error=@error`,
      )
      .run({
        ...h,
        sshHost: h.sshHost ?? '',
        sshUser: h.sshUser ?? '',
        platform: h.platform ?? null,
        keyRef: h.keyRef ?? null,
        hostToken: h.hostToken ?? null,
      });
  }

  removeHost(id: string): void {
    this.db.prepare('DELETE FROM host WHERE id = ?').run(id);
  }

  hostKeyRef(id: string): string | null {
    const r = this.db.prepare('SELECT key_ref FROM host WHERE id = ?').get(id) as
      | { key_ref: string | null }
      | undefined;
    return r?.key_ref ?? null;
  }

  /**
   * Match an enrolled host by the durable token it presents on reconnect.
   * Server-side only — like key_ref, this never travels to the browser.
   */
  hostByToken(token: string): Host | null {
    const r = this.db.prepare('SELECT id FROM host WHERE host_token = ?').get(token) as
      | { id: string }
      | undefined;
    return r ? this.getHost(r.id) : null;
  }

  /* ----------------------------------------------------------- workspaces */

  listWorkspaces(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspace WHERE archived_at IS NULL ORDER BY created_at')
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      rootPath: r.root_path,
      hostId: r.host_id,
      color: r.color,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
    }));
  }

  getWorkspace(id: string): Workspace | null {
    return this.listWorkspaces().find((w) => w.id === id) ?? null;
  }

  getWorkspaceByName(name: string): Workspace | null {
    return this.listWorkspaces().find((w) => w.name === name) ?? null;
  }

  insertWorkspace(w: Workspace): void {
    this.db
      .prepare(
        `INSERT INTO workspace (id, name, kind, root_path, host_id, color, created_at, archived_at)
         VALUES (@id, @name, @kind, @rootPath, @hostId, @color, @createdAt, @archivedAt)`,
      )
      .run(w);
  }

  /**
   * Change a workspace's name or folder in place.
   *
   * Deliberately narrow: id, kind, host and colour identify the row and the
   * node drawn for it, and nothing in the UI has any business editing them.
   */
  updateWorkspace(id: string, patch: { name?: string; rootPath?: string }): void {
    this.db
      .prepare(
        `UPDATE workspace
            SET name = COALESCE(@name, name),
                root_path = COALESCE(@rootPath, root_path)
          WHERE id = @id`,
      )
      .run({ id, name: patch.name ?? null, rootPath: patch.rootPath ?? null });
  }

  removeWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspace WHERE id = ?').run(id);
  }

  /* ------------------------------------------------------------ templates */

  /**
   * Templates made from the panel. `agents.toml` is a second source and is
   * merged over these by TemplateRegistry, not here: this is only the half
   * that can be written.
   */
  listStoredTemplates(): StoredTemplate[] {
    return (
      this.db
        .prepare('SELECT * FROM template ORDER BY id')
        .all() as StoredTemplateRow[]
    ).map((r) => ({
      id: r.id,
      description: r.description,
      agent: r.agent,
      model: r.model,
      effort: r.effort,
      prompt: r.prompt,
      env: envFromJson(r.env_json),
    }));
  }

  getStoredTemplate(id: string): StoredTemplate | null {
    return this.listStoredTemplates().find((t) => t.id === id) ?? null;
  }

  /**
   * Create or replace one, wholesale.
   *
   * Replace rather than patch because the dialog sends the whole form, and a
   * template is four fields: a patch API here would only be a way to make
   * clearing a model harder to express than setting one.
   */
  upsertTemplate(t: StoredTemplate): void {
    this.db
      .prepare(
        `INSERT INTO template (id, description, agent, model, effort, prompt, env_json, created_at)
         VALUES (@id, @description, @agent, @model, @effort, @prompt, @envJson, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           description = excluded.description,
           agent       = excluded.agent,
           model       = excluded.model,
           effort      = excluded.effort,
           prompt      = excluded.prompt,
           env_json    = excluded.env_json`,
      )
      .run({
        id: t.id,
        description: t.description ?? null,
        agent: t.agent,
        model: t.model ?? null,
        effort: t.effort ?? null,
        prompt: t.prompt ?? null,
        // Stored as `null` rather than `{}` so a template that sets nothing
        // looks the same as every row written before the column existed.
        envJson: Object.keys(t.env).length > 0 ? JSON.stringify(t.env) : null,
        createdAt: Date.now(),
      });
  }

  removeTemplate(id: string): void {
    this.db.prepare('DELETE FROM template WHERE id = ?').run(id);
  }

  /* ------------------------------------------------------------- sessions */

  private rowToSession(r: SessionRow, resumable: boolean): Session {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      address: makeAddress(r.workspace_name, r.name),
      profile: r.profile,
      template: r.template,
      model: r.model,
      effort: r.effort,
      cwd: r.cwd,
      agentSessionUuid: r.agent_session_uuid,
      spawnedBy: r.spawned_by,
      state: r.state as Session['state'],
      // Live status is held in memory by the SessionManager; a row loaded from
      // disk is by definition not running, so it reads as unknown until start.
      status: 'unknown',
      statusText: r.status_text,
      title: r.title,
      pid: r.pid,
      exitCode: r.exit_code,
      cols: r.cols,
      rows: r.rows,
      resumable,
      createdAt: r.created_at,
      exitedAt: r.exited_at,
      lastActiveAt: r.last_active_at,
      window: {
        x: r.x ?? DEFAULT_WINDOW.x,
        y: r.y ?? DEFAULT_WINDOW.y,
        w: r.w ?? DEFAULT_WINDOW.w,
        h: r.h ?? DEFAULT_WINDOW.h,
        z: r.z ?? DEFAULT_WINDOW.z,
        collapsed: r.collapsed === 1,
      },
    };
  }

  private readonly selectSession = `
    SELECT s.*, w.name AS workspace_name,
           win.x, win.y, win.w, win.h, win.z, win.collapsed
    FROM session s
    JOIN workspace w ON w.id = s.workspace_id
    LEFT JOIN window win ON win.session_id = s.id
  `;

  listSessions(isResumable: (profile: string) => boolean): Session[] {
    const rows = this.db
      .prepare(`${this.selectSession} ORDER BY s.created_at`)
      .all() as SessionRow[];
    return rows.map((r) => this.rowToSession(r, isResumable(r.profile)));
  }

  getSession(id: string, isResumable: (profile: string) => boolean): Session | null {
    const r = this.db
      .prepare(`${this.selectSession} WHERE s.id = ?`)
      .get(id) as SessionRow | undefined;
    return r ? this.rowToSession(r, isResumable(r.profile)) : null;
  }

  namesInWorkspace(workspaceId: string): string[] {
    return (
      this.db
        .prepare('SELECT name FROM session WHERE workspace_id = ?')
        .all(workspaceId) as { name: string }[]
    ).map((r) => r.name);
  }

  /**
   * `templateEnv` is recorded beside the launch spec rather than folded into
   * it: the spec is rebuilt from scratch on every resume, and this is the one
   * input to that rebuild which lives on the template rather than the profile
   * — so the session has to keep its own copy or a later edit to the template
   * would silently change what a resumed agent runs in.
   */
  insertSession(
    s: Session,
    spec: SessionLaunchSpec,
    templateEnv: Record<string, string> = {},
  ): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO session (
             id, workspace_id, name, profile, template, model, effort, cwd,
             agent_session_uuid,
             argv_json, env_json, template_env_json, spawned_by, state, status_text, title,
             pid, exit_code, cols, rows, created_at, exited_at, last_active_at)
           VALUES (
             @id, @workspaceId, @name, @profile, @template, @model, @effort, @cwd,
             @agentSessionUuid,
             @argvJson, @envJson, @templateEnvJson, @spawnedBy, @state, @statusText, @title,
             @pid, @exitCode, @cols, @rows, @createdAt, @exitedAt, @lastActiveAt)`,
        )
        .run({
          id: s.id,
          workspaceId: s.workspaceId,
          name: s.name,
          profile: s.profile,
          template: s.template,
          model: s.model,
          effort: s.effort,
          cwd: s.cwd,
          agentSessionUuid: s.agentSessionUuid,
          argvJson: JSON.stringify(spec.argv),
          envJson: JSON.stringify(spec.env),
          templateEnvJson:
            Object.keys(templateEnv).length > 0 ? JSON.stringify(templateEnv) : null,
          spawnedBy: s.spawnedBy,
          state: s.state,
          statusText: s.statusText,
          title: s.title,
          pid: s.pid,
          exitCode: s.exitCode,
          cols: s.cols,
          rows: s.rows,
          createdAt: s.createdAt,
          exitedAt: s.exitedAt,
          lastActiveAt: s.lastActiveAt,
        });
      this.saveWindow(s.id, s.window);
    });
    tx();
  }

  /** Fields that change over a session's life. Layout is written separately. */
  updateSession(
    id: string,
    patch: Partial<
      Pick<
        Session,
        'state' | 'pid' | 'exitCode' | 'statusText' | 'title' | 'cols' | 'rows' | 'exitedAt' | 'lastActiveAt' | 'agentSessionUuid'
      >
    >,
  ): void {
    const map: Record<string, string> = {
      state: 'state',
      pid: 'pid',
      exitCode: 'exit_code',
      statusText: 'status_text',
      title: 'title',
      cols: 'cols',
      rows: 'rows',
      exitedAt: 'exited_at',
      lastActiveAt: 'last_active_at',
      agentSessionUuid: 'agent_session_uuid',
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${map[k]} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE session SET ${sets} WHERE id = @id`)
      .run({ id, ...Object.fromEntries(entries) });
  }

  getLaunchSpec(id: string): SessionLaunchSpec | null {
    const r = this.db
      .prepare('SELECT argv_json, env_json FROM session WHERE id = ?')
      .get(id) as { argv_json: string; env_json: string } | undefined;
    if (!r) return null;
    return { argv: JSON.parse(r.argv_json), env: JSON.parse(r.env_json) };
  }

  /** What the template this session came from added to its environment. */
  getTemplateEnv(id: string): Record<string, string> {
    const r = this.db
      .prepare('SELECT template_env_json FROM session WHERE id = ?')
      .get(id) as { template_env_json: string | null } | undefined;
    return envFromJson(r?.template_env_json ?? null);
  }

  setLaunchSpec(id: string, spec: SessionLaunchSpec): void {
    this.db
      .prepare('UPDATE session SET argv_json = ?, env_json = ? WHERE id = ?')
      .run(JSON.stringify(spec.argv), JSON.stringify(spec.env), id);
  }

  removeSession(id: string): void {
    this.db.prepare('DELETE FROM session WHERE id = ?').run(id);
  }

  /* --------------------------------------------------------------- layout */

  saveWindow(sessionId: string, rect: WindowRect): void {
    this.db
      .prepare(
        `INSERT INTO window (session_id, x, y, w, h, z, collapsed)
         VALUES (@sessionId, @x, @y, @w, @h, @z, @collapsed)
         ON CONFLICT(session_id) DO UPDATE SET
           x=@x, y=@y, w=@w, h=@h, z=@z, collapsed=@collapsed`,
      )
      .run({ sessionId, ...rect, collapsed: rect.collapsed ? 1 : 0 });
  }

  getViewport(): Viewport {
    const r = this.db.prepare('SELECT * FROM viewport WHERE id = 1').get() as
      | { pan_x: number; pan_y: number; zoom: number }
      | undefined;
    return r ? { panX: r.pan_x, panY: r.pan_y, zoom: r.zoom } : { panX: 0, panY: 0, zoom: 1 };
  }

  saveViewport(v: Viewport): void {
    this.db
      .prepare(
        `INSERT INTO viewport (id, pan_x, pan_y, zoom) VALUES (1, @panX, @panY, @zoom)
         ON CONFLICT(id) DO UPDATE SET pan_x=@panX, pan_y=@panY, zoom=@zoom`,
      )
      .run(v);
  }

  /* -------------------------------------------------- remote window layout */

  /**
   * Layout for peer-hosted sessions, keyed by address. Remote session state
   * itself is never cached here; the peer owns it.
   */
  getRemoteWindows(): Map<string, WindowRect> {
    const rows = this.db.prepare('SELECT * FROM remote_window').all() as any[];
    return new Map(
      rows.map((r) => [
        r.address as string,
        { x: r.x, y: r.y, w: r.w, h: r.h, z: r.z, collapsed: r.collapsed === 1 },
      ]),
    );
  }

  saveRemoteWindow(address: string, hostId: string, rect: WindowRect): void {
    this.db
      .prepare(
        `INSERT INTO remote_window (address, host_id, x, y, w, h, z, collapsed)
         VALUES (@address, @hostId, @x, @y, @w, @h, @z, @collapsed)
         ON CONFLICT(address) DO UPDATE SET
           host_id=@hostId, x=@x, y=@y, w=@w, h=@h, z=@z, collapsed=@collapsed`,
      )
      .run({ address, hostId, ...rect, collapsed: rect.collapsed ? 1 : 0 });
  }

  removeRemoteWindow(address: string): void {
    this.db.prepare('DELETE FROM remote_window WHERE address = ?').run(address);
  }

  /* ----------------------------------------------- deferred removals */

  /**
   * Addresses the user closed while their host was unreachable, kept until
   * that host can be told. Keyed by address for the same reason remote_window
   * is: the owning hub's session id means nothing in this database.
   */
  pendingRemovals(hostId?: string): { address: string; hostId: string }[] {
    const rows = (
      hostId
        ? this.db.prepare('SELECT * FROM pending_removal WHERE host_id = ?').all(hostId)
        : this.db.prepare('SELECT * FROM pending_removal').all()
    ) as any[];
    return rows.map((r) => ({ address: r.address, hostId: r.host_id }));
  }

  addPendingRemoval(address: string, hostId: string): void {
    this.db
      .prepare(
        `INSERT INTO pending_removal (address, host_id, requested_at)
         VALUES (@address, @hostId, @requestedAt)
         ON CONFLICT(address) DO UPDATE SET host_id=@hostId, requested_at=@requestedAt`,
      )
      .run({ address, hostId, requestedAt: Date.now() });
  }

  clearPendingRemoval(address: string): void {
    this.db.prepare('DELETE FROM pending_removal WHERE address = ?').run(address);
  }

  /* ------------------------------------------------------------ snapshots */

  saveSnapshot(sessionId: string, serialized: string, cols: number, rows: number): void {
    this.db
      .prepare(
        `INSERT INTO session_snapshot (session_id, serialized, cols, rows, captured_at)
         VALUES (@sessionId, @serialized, @cols, @rows, @capturedAt)
         ON CONFLICT(session_id) DO UPDATE SET
           serialized=@serialized, cols=@cols, rows=@rows, captured_at=@capturedAt`,
      )
      .run({ sessionId, serialized, cols, rows, capturedAt: Date.now() });
  }

  getSnapshot(
    sessionId: string,
  ): { serialized: string; cols: number; rows: number } | null {
    const r = this.db
      .prepare('SELECT serialized, cols, rows FROM session_snapshot WHERE session_id = ?')
      .get(sessionId) as { serialized: string; cols: number; rows: number } | undefined;
    return r ?? null;
  }

  /* ------------------------------------------------------------- messages */

  listMessages(limit = 500): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM message ORDER BY sent_at DESC LIMIT ?')
      .all(limit) as any[];
    return rows
      .map((r) => ({
        id: r.id,
        fromAddr: r.from_addr,
        toAddr: r.to_addr,
        body: r.body,
        sentAt: r.sent_at,
        deliveredAt: r.delivered_at,
        deliveryState: r.delivery_state,
        error: r.error,
      }))
      .reverse();
  }

  insertMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO message (id, from_addr, to_addr, body, sent_at, delivered_at, delivery_state, error)
         VALUES (@id, @fromAddr, @toAddr, @body, @sentAt, @deliveredAt, @deliveryState, @error)`,
      )
      .run(m);
  }
}
