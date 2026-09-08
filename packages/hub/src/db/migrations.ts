import type { Database } from 'better-sqlite3';

/**
 * Numbered, append-only migrations. Each runs once, in order, inside a
 * transaction; `schema_meta` records the high-water mark. Never edit a
 * migration that has shipped — add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE host (
        id            TEXT PRIMARY KEY,
        label         TEXT NOT NULL,
        ssh_host      TEXT NOT NULL,
        ssh_user      TEXT NOT NULL,
        ssh_port      INTEGER NOT NULL DEFAULT 22,
        key_ref       TEXT,
        hub_version   TEXT,
        state         TEXT NOT NULL DEFAULT 'disconnected',
        last_seen_at  INTEGER,
        error         TEXT
      );

      CREATE TABLE workspace (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        kind        TEXT NOT NULL CHECK (kind IN ('local','remote')),
        root_path   TEXT NOT NULL,
        host_id     TEXT REFERENCES host(id) ON DELETE CASCADE,
        color       TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        archived_at INTEGER
      );

      CREATE TABLE session (
        id                 TEXT PRIMARY KEY,
        workspace_id       TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name               TEXT NOT NULL,
        profile            TEXT NOT NULL,
        cwd                TEXT NOT NULL,
        agent_session_uuid TEXT,
        argv_json          TEXT NOT NULL,
        env_json           TEXT NOT NULL,
        spawned_by         TEXT REFERENCES session(id) ON DELETE SET NULL,
        state              TEXT NOT NULL,
        status_text        TEXT,
        title              TEXT,
        pid                INTEGER,
        exit_code          INTEGER,
        cols               INTEGER NOT NULL DEFAULT 80,
        rows               INTEGER NOT NULL DEFAULT 24,
        created_at         INTEGER NOT NULL,
        exited_at          INTEGER,
        last_active_at     INTEGER NOT NULL,
        UNIQUE (workspace_id, name)
      );

      CREATE TABLE session_snapshot (
        session_id  TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
        serialized  TEXT NOT NULL,
        cols        INTEGER NOT NULL,
        rows        INTEGER NOT NULL,
        captured_at INTEGER NOT NULL
      );

      CREATE TABLE window (
        session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
        x          REAL NOT NULL,
        y          REAL NOT NULL,
        w          REAL NOT NULL,
        h          REAL NOT NULL,
        z          INTEGER NOT NULL DEFAULT 0,
        collapsed  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE viewport (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        pan_x REAL NOT NULL,
        pan_y REAL NOT NULL,
        zoom  REAL NOT NULL
      );

      CREATE TABLE message (
        id             TEXT PRIMARY KEY,
        from_addr      TEXT NOT NULL,
        to_addr        TEXT NOT NULL,
        body           TEXT NOT NULL,
        sent_at        INTEGER NOT NULL,
        delivered_at   INTEGER,
        delivery_state TEXT NOT NULL,
        error          TEXT
      );

      CREATE INDEX idx_session_workspace ON session(workspace_id);
      CREATE INDEX idx_message_sent_at   ON message(sent_at);
      CREATE INDEX idx_workspace_host    ON workspace(host_id);
    `,
  },
  {
    version: 2,
    name: 'remote_windows',
    up: `
      -- Canvas layout for sessions that live on a peer hub.
      --
      -- Remote session state is deliberately NOT cached locally: the peer
      -- owns its sessions and their snapshots. But the layout is the user's
      -- view of their own canvas, so it belongs here, keyed by address rather
      -- than by a session id this database does not have.
      CREATE TABLE remote_window (
        address    TEXT PRIMARY KEY,
        host_id    TEXT NOT NULL REFERENCES host(id) ON DELETE CASCADE,
        x          REAL NOT NULL,
        y          REAL NOT NULL,
        w          REAL NOT NULL,
        h          REAL NOT NULL,
        z          INTEGER NOT NULL DEFAULT 0,
        collapsed  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_remote_window_host ON remote_window(host_id);
    `,
  },
  {
    version: 3,
    name: 'enrolled_hosts',
    up: `
      -- A host that ran the join installer dialled us; we hold no SSH
      -- credentials for it and cannot reach it on our own.
      --
      -- ssh_host and ssh_user are NOT NULL from migration 1 and enrolled rows
      -- have neither. They are written as '' and mapped back to null in the
      -- store. Rebuilding the table to relax the constraint would mean
      -- dropping it while workspace.host_id and remote_window.host_id hold
      -- cascading references to it, which is far more risk than a sentinel.
      ALTER TABLE host ADD COLUMN kind          TEXT NOT NULL DEFAULT 'ssh';
      -- The durable credential an enrolled host presents on every reconnect.
      -- Server-side only, like key_ref: it is never sent to the browser.
      ALTER TABLE host ADD COLUMN host_token    TEXT;
      ALTER TABLE host ADD COLUMN platform      TEXT;
    `,
  },
  {
    version: 4,
    name: 'pending_removals',
    up: `
      -- A window the user closed while its host was unreachable.
      --
      -- The intent outlives the disconnection. Without this the removal is
      -- lost with the process and the peer reports the session again on its
      -- next connection, which is what made closed terminals come back after
      -- a restart. Replayed the moment that host is reachable again.
      CREATE TABLE pending_removal (
        address      TEXT PRIMARY KEY,
        host_id      TEXT NOT NULL REFERENCES host(id) ON DELETE CASCADE,
        requested_at INTEGER NOT NULL
      );

      CREATE INDEX idx_pending_removal_host ON pending_removal(host_id);
    `,
  },
  {
    version: 5,
    name: 'session_model_effort',
    up: `
      -- What a template resolved to when this session started.
      --
      -- Recorded on the session rather than looked up from the template at
      -- resume time, for two reasons. Resume deliberately rebuilds argv
      -- instead of replaying it, so without these the model and effort are
      -- quietly lost the first time a machine restarts - and an agent coming
      -- back on a different model than it left with is worse than one that
      -- does not come back. And a template is editable: the answer belongs to
      -- the session that used it, not to whatever the template says today.
      --
      -- The opening instruction is deliberately *not* here. It is how the
      -- session started, not what it is, and it must not repeat on resume.
      ALTER TABLE session ADD COLUMN model    TEXT;
      ALTER TABLE session ADD COLUMN effort   TEXT;
      -- Which template was picked, for showing on the window. Null for a
      -- session started before templates existed, or by an agent's spawn_agent.
      ALTER TABLE session ADD COLUMN template TEXT;
    `,
  },
  {
    version: 6,
    name: 'stored_templates',
    up: `
      -- Templates made from the panel.
      --
      -- Kept here rather than round-tripped into ~/.termscape/agents.toml,
      -- which is the one real decision this table represents. That file is
      -- written by hand: a formatter that ate somebody's comments and ordering
      -- the first time they used the dialog would be a bad trade for a config
      -- file, and there is no TOML writer here to do it with anyway. So the
      -- file stays a read-only second source and this is the writable one,
      -- which is also how workspaces and hosts already work.
      --
      -- When both declare the same id the file wins. Someone who wrote a
      -- template by hand meant it, and a UI silently overriding their file is
      -- worse than a UI refusing an id the file has claimed.
      --
      -- The id is the primary key because it is the name a person picks from
      -- a list; there is no separate uuid to be the "real" identity and then
      -- explain.
      CREATE TABLE template (
        id          TEXT PRIMARY KEY,
        description TEXT,
        agent       TEXT NOT NULL,
        model       TEXT,
        effort      TEXT,
        prompt      TEXT,
        created_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 7,
    name: 'template_env',
    up: `
      -- Extra environment a template sets for the agent it launches.
      --
      -- JSON rather than a side table: it is a small map read and written
      -- whole, exactly like the argv and env already on the session row, and a
      -- table would buy queries nobody makes.
      ALTER TABLE template ADD COLUMN env_json TEXT;

      -- And the copy that belongs to the session, for the same reason model
      -- and effort are recorded there: a template is editable, and a session
      -- resumed a week later has to come back in the environment it was
      -- launched in rather than whatever the template says today.
      ALTER TABLE session ADD COLUMN template_env_json TEXT;
    `,
  },
];

export function runMigrations(db: Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const current =
    (
      db.prepare('SELECT MAX(version) AS v FROM schema_meta').get() as {
        v: number | null;
      }
    ).v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const m of pending) {
    const apply = db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_meta (version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
    });
    apply();
  }

  return LATEST_VERSION;
}

export const LATEST_VERSION = MIGRATIONS.reduce(
  (max, m) => Math.max(max, m.version),
  0,
);
