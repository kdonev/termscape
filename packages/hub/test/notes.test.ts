import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Note } from '@termscape/protocol';
import { Hub } from '../src/hub.js';
import { removeTree } from './tmp.js';

/*
 * Notes skip the debounce a window's layout goes through (see
 * `layout.test.ts`): `hub.saveNote` writes straight to SQLite, the same way
 * `setViewport` already does. This is the guard for that - a note saved and
 * immediately followed by a shutdown must not be the one drag windows lose.
 */

let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-notes-'));
  process.env.TERMSCAPE_HOME = dir;
  hub = new Hub({ dbPath: join(dir, 'state.db') });
});

afterEach(() => {
  hub.shutdown();
  delete process.env.TERMSCAPE_HOME;
  removeTree(dir);
});

const note = (over: Partial<Note> = {}): Note => ({
  id: 'n1',
  x: 100,
  y: 200,
  w: 220,
  h: 180,
  z: 1,
  text: 'buy milk',
  color: 'yellow',
  updatedAt: Date.now(),
  ...over,
});

describe('a note', () => {
  it('survives a shutdown and reopen with no debounce to lose it', () => {
    hub.saveNote(note());
    // No wait, unlike layout.test.ts's debounce case: a note write is
    // synchronous, so the very next line is the one that would fail if it
    // were not.
    hub.shutdown();

    hub = new Hub({ dbPath: join(dir, 'state.db') });
    const loaded = hub.store.listNotes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'n1', x: 100, y: 200, text: 'buy milk' });
  });

  it('round-trips through save, list, and remove', () => {
    hub.saveNote(note({ id: 'a', z: 0 }));
    hub.saveNote(note({ id: 'b', z: 1 }));
    expect(hub.store.listNotes().map((n) => n.id)).toEqual(['a', 'b']);

    hub.saveNote(note({ id: 'a', z: 0, text: 'edited', color: 'pink' }));
    expect(hub.store.listNotes().find((n) => n.id === 'a')).toMatchObject({
      text: 'edited',
      color: 'pink',
    });

    hub.removeNote('a');
    expect(hub.store.listNotes().map((n) => n.id)).toEqual(['b']);
  });

  it('clamps width and height to the minimum instead of trusting the client', () => {
    const saved = hub.saveNote(note({ w: 10, h: 5 }));
    expect(saved).toMatchObject({ w: 120, h: 80 });
    expect(hub.store.listNotes()[0]).toMatchObject({ w: 120, h: 80 });
  });

  it('drops a write with a non-finite number rather than storing garbage', () => {
    const saved = hub.saveNote(note({ x: NaN }));
    expect(saved).toBeNull();
    expect(hub.store.listNotes()).toEqual([]);
  });
});
