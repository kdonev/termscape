import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, LATEST_VERSION } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrations.js';
import { Store, DEFAULT_WINDOW } from '../src/db/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-db-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('applies from empty and reports the latest version', () => {
    const db = openDb(join(dir, 'state.db'));
    const v = (
      db.prepare('SELECT MAX(version) AS v FROM schema_meta').get() as { v: number }
    ).v;
    expect(v).toBe(LATEST_VERSION);
    db.close();
  });

  it('is idempotent: re-running applies nothing and does not throw', () => {
    const path = join(dir, 'state.db');
    const db = openDb(path);
    const before = db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get() as { n: number };
    runMigrations(db);
    runMigrations(db);
    const after = db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get() as { n: number };
    expect(after.n).toBe(before.n);
    db.close();
  });

  it('reopening an existing database preserves data', () => {
    const path = join(dir, 'state.db');
    const db1 = openDb(path);
    new Store(db1).saveViewport({ panX: 12, panY: -8, zoom: 0.75 });
    db1.close();

    const db2 = openDb(path);
    expect(new Store(db2).getViewport()).toEqual({ panX: 12, panY: -8, zoom: 0.75 });
    db2.close();
  });
});

describe('store round-trips', () => {
  function seed() {
    const db = openDb(join(dir, 'state.db'));
    const store = new Store(db);
    const ws = {
      id: 'ws1',
      name: 'api',
      kind: 'local' as const,
      rootPath: dir,
      hostId: null,
      color: '#7c9cf5',
      createdAt: Date.now(),
      archivedAt: null,
    };
    store.insertWorkspace(ws);
    return { db, store, ws };
  }

  it('persists a session with its launch spec and reads it back addressed', () => {
    const { db, store, ws } = seed();
    const now = Date.now();
    store.insertSession(
      {
        id: 's1',
        workspaceId: ws.id,
        name: 'reviewer',
        address: 'api/reviewer',
        profile: 'claude',
        cwd: dir,
        agentSessionUuid: 'uuid-1',
        spawnedBy: null,
        state: 'running',
        status: 'busy',
        statusText: null,
        title: null,
        pid: 42,
        exitCode: null,
        cols: 100,
        rows: 30,
        resumable: true,
        createdAt: now,
        exitedAt: null,
        lastActiveAt: now,
        window: { ...DEFAULT_WINDOW, x: 10, y: 20 },
      },
      { argv: ['claude', '--session-id', 'uuid-1'], env: { A: 'b' } },
    );

    const loaded = store.getSession('s1', () => true)!;
    expect(loaded.address).toBe('api/reviewer');
    expect(loaded.window.x).toBe(10);
    expect(loaded.agentSessionUuid).toBe('uuid-1');
    // A row loaded from disk is by definition not running.
    expect(loaded.status).toBe('unknown');

    expect(store.getLaunchSpec('s1')).toEqual({
      argv: ['claude', '--session-id', 'uuid-1'],
      env: { A: 'b' },
    });
    db.close();
  });

  it('round-trips a screen snapshot byte-for-byte', () => {
    const { db, store, ws } = seed();
    const now = Date.now();
    store.insertSession(
      {
        id: 's1', workspaceId: ws.id, name: 'a', address: 'api/a', profile: 'shell',
        cwd: dir, agentSessionUuid: null, spawnedBy: null, state: 'running',
        status: 'unknown', statusText: null, title: null, pid: null, exitCode: null,
        cols: 80, rows: 24, resumable: false, createdAt: now, exitedAt: null,
        lastActiveAt: now, window: DEFAULT_WINDOW,
      },
      { argv: ['bash'], env: {} },
    );

    // Escape sequences must survive storage untouched, or a restored window
    // renders with the wrong colours and cursor position.
    const serialized = '\x1b[32mgreen\x1b[0m\r\n\x1b[1;5Hcursor';
    store.saveSnapshot('s1', serialized, 80, 24);
    expect(store.getSnapshot('s1')).toEqual({ serialized, cols: 80, rows: 24 });

    // Upsert, not duplicate.
    store.saveSnapshot('s1', 'replaced', 100, 30);
    expect(store.getSnapshot('s1')).toEqual({ serialized: 'replaced', cols: 100, rows: 30 });
    db.close();
  });

  it('cascades sessions, windows and snapshots when a workspace is removed', () => {
    const { db, store, ws } = seed();
    const now = Date.now();
    store.insertSession(
      {
        id: 's1', workspaceId: ws.id, name: 'a', address: 'api/a', profile: 'shell',
        cwd: dir, agentSessionUuid: null, spawnedBy: null, state: 'running',
        status: 'unknown', statusText: null, title: null, pid: null, exitCode: null,
        cols: 80, rows: 24, resumable: false, createdAt: now, exitedAt: null,
        lastActiveAt: now, window: DEFAULT_WINDOW,
      },
      { argv: ['bash'], env: {} },
    );
    store.saveSnapshot('s1', 'screen', 80, 24);

    store.removeWorkspace(ws.id);
    expect(store.getSession('s1', () => false)).toBeNull();
    expect(store.getSnapshot('s1')).toBeNull();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM window').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it('keeps a deferred removal until it is cleared, and drops it with its host', () => {
    const { db, store } = seed();
    store.upsertHost({
      id: 'h1', label: 'kid', kind: 'enrolled', sshHost: null, sshUser: null,
      sshPort: 22, platform: null, hubVersion: null, state: 'disconnected',
      lastSeenAt: null, error: null,
    });

    store.addPendingRemoval('remote/one', 'h1');
    store.addPendingRemoval('remote/two', 'h1');
    expect(store.pendingRemovals('h1').map((p) => p.address)).toEqual([
      'remote/one',
      'remote/two',
    ]);

    store.clearPendingRemoval('remote/one');
    expect(store.pendingRemovals().map((p) => p.address)).toEqual(['remote/two']);

    // Dropping the host drops any instruction still queued for it: there is
    // nobody left to tell.
    store.removeHost('h1');
    expect(store.pendingRemovals()).toEqual([]);
    db.close();
  });

  it('records message delivery outcomes, including failures', () => {
    const { db, store } = seed();
    store.insertMessage({
      id: 'm1', fromAddr: 'api/a', toAddr: 'api/b', body: 'hi',
      sentAt: 1, deliveredAt: 2, deliveryState: 'delivered', error: null,
    });
    store.insertMessage({
      id: 'm2', fromAddr: 'api/a', toAddr: 'api/gone', body: 'hello?',
      sentAt: 3, deliveredAt: null, deliveryState: 'failed', error: 'no agent',
    });
    const all = store.listMessages();
    expect(all.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(all[1]!.deliveryState).toBe('failed');
    expect(all[1]!.error).toBe('no agent');
    db.close();
  });
});
