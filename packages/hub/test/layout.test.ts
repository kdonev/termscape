import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.js';
import { LAYOUT_DEBOUNCE_MS } from '../src/session/manager.js';
import { removeTree } from './tmp.js';

/*
 * Where a window is, while it is being dragged.
 *
 * Sessions are read back out of SQLite on every emit and the write is
 * debounced, so anything else that broadcast mid-drag - a title the agent
 * rewrote, a status flip - used to carry the rect from *before* the drag and
 * snap the window back under the cursor a moment after it started moving. The
 * move is authoritative the instant it arrives; the debounce defers the write,
 * not the truth.
 */
let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-layout-'));
  process.env.TERMSCAPE_HOME = dir;
  hub = new Hub({ dbPath: join(dir, 'state.db') });
});

afterEach(() => {
  hub.shutdown();
  delete process.env.TERMSCAPE_HOME;
  removeTree(dir);
});

const start = async () => {
  const folder = join(dir, 'ws');
  mkdirSync(folder, { recursive: true });
  const ws = hub.createWorkspace('ws', folder);
  return hub.startSession({ workspaceId: ws.id, profile: 'shell' });
};

describe('a window being moved', () => {
  it(
    'reads back where it was just moved to, before the write lands',
    async () => {
      const s = await start();
      const moved = { ...s.window, x: s.window.x + 640, y: s.window.y + 480 };

      hub.moveWindow(s.id, moved);

      // No waiting: this is the read every unrelated broadcast makes, and it
      // is exactly the one that used to answer with the old rect.
      expect(hub.sessions.get(s.id)?.window).toMatchObject({ x: moved.x, y: moved.y });
      expect(
        hub.sessions.list().find((x) => x.id === s.id)?.window,
      ).toMatchObject({ x: moved.x, y: moved.y });
    },
    30_000,
  );

  it(
    'still keeps the last rect once the debounce has written it',
    async () => {
      const s = await start();
      // A drag is a stream of these; only the last one is ever written.
      for (let i = 1; i <= 5; i++) {
        hub.moveWindow(s.id, { ...s.window, x: s.window.x + i * 10 });
      }
      await new Promise((r) => setTimeout(r, LAYOUT_DEBOUNCE_MS * 3));
      expect(hub.sessions.get(s.id)?.window.x).toBe(s.window.x + 50);

      // And the row itself, not just the overlay: a hub restarted here has to
      // come back with the window where it was left.
      hub.shutdown();
      hub = new Hub({ dbPath: join(dir, 'state.db') });
      expect(hub.sessions.get(s.id)?.window.x).toBe(s.window.x + 50);
    },
    30_000,
  );
});
