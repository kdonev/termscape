import { describe, expect, it } from 'vitest';
import type { Session, WindowRect } from '@termscape/protocol';
import { choosePlacement } from '../src/session/manager.js';
import { DEFAULT_WINDOW } from '../src/db/store.js';

/**
 * Where a new window lands. The rules: never on top of anything already on
 * the canvas, near its own workspace's group, near another group when its own
 * is empty, and cascading — not stacking — when one parent spawns repeatedly.
 */

let nextId = 0;
function session(workspaceId: string, window: Partial<WindowRect>): Session {
  nextId += 1;
  return {
    id: `s${nextId}`,
    workspaceId,
    window: { ...DEFAULT_WINDOW, z: 0, collapsed: false, ...window },
  } as Session;
}

const overlaps = (a: WindowRect, b: Pick<WindowRect, 'x' | 'y' | 'w' | 'h'>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('choosePlacement', () => {
  it('puts the first window ever at the origin', () => {
    const r = choosePlacement({ workspaceId: 'ws', parentId: null, sessions: [] });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it('places beside its own workspace group without overlapping anything', () => {
    const sessions = [
      session('ws', { x: 0, y: 0 }),
      session('ws', { x: 760, y: 0 }),
    ];
    const r = choosePlacement({ workspaceId: 'ws', parentId: null, sessions });
    for (const s of sessions) expect(overlaps(r, s.window)).toBe(false);
    // Near the group, not across the canvas.
    expect(r.x).toBeGreaterThan(0);
    expect(r.x).toBeLessThan(760 * 2 + 1000);
  });

  it('does not land on a window the user dragged into the next slot', () => {
    // The count-based grid this replaces would have handed out x = 760 as the
    // second slot even though something occupies it now.
    const sessions = [
      session('ws', { x: 0, y: 0 }),
      session('ws', { x: 760, y: 0 }),
      session('other', { x: 0, y: 0 }),
    ];
    const r = choosePlacement({ workspaceId: 'other', parentId: null, sessions });
    for (const s of sessions) expect(overlaps(r, s.window)).toBe(false);
  });

  it('puts a workspace with no windows beside another workspace, not at the origin', () => {
    const sessions = [
      session('first', { x: 0, y: 0 }),
      session('first', { x: 760, y: 0 }),
    ];
    const r = choosePlacement({ workspaceId: 'second', parentId: null, sessions });
    for (const s of sessions) expect(overlaps(r, s.window)).toBe(false);
    expect(r.x).toBeGreaterThan(760);
  });

  it('tucks a spawned child below-right of its parent', () => {
    const parent = session('ws', { x: 100, y: 100 });
    const r = choosePlacement({
      workspaceId: 'ws',
      parentId: parent.id,
      sessions: [parent],
    });
    expect(overlaps(r, parent.window)).toBe(false);
    expect(r.x).toBeGreaterThanOrEqual(parent.window.x);
    expect(r.y).toBeGreaterThanOrEqual(parent.window.y + parent.window.h);
  });

  it('cascades a second child of the same parent instead of stacking it', () => {
    const parent = session('ws', { x: 100, y: 100 });
    const first = choosePlacement({
      workspaceId: 'ws',
      parentId: parent.id,
      sessions: [parent],
    });
    const firstChild = session('ws', first);
    const second = choosePlacement({
      workspaceId: 'ws',
      parentId: parent.id,
      sessions: [parent, firstChild],
    });
    expect(overlaps(second, parent.window)).toBe(false);
    expect(overlaps(second, firstChild.window)).toBe(false);
    // Still near the family, not flung to a distant slot.
    expect(second.x).toBeLessThan(parent.window.x + 2 * (DEFAULT_WINDOW.w + 100));
  });

  it('keeps every window clear when a workspace fills up row after row', () => {
    let sessions: Session[] = [];
    for (let i = 0; i < 10; i++) {
      const r = choosePlacement({ workspaceId: 'ws', parentId: null, sessions });
      for (const s of sessions) expect(overlaps(r, s.window)).toBe(false);
      sessions = [...sessions, session('ws', r)];
    }
  });
});
