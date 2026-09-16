import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@termscape/protocol';
import { useStore } from '../src/state/store.js';

/*
 * Dragging a workspace by its label moves every window in it by the same
 * offset. There is no workspace position of its own - the frame is drawn
 * around its windows - so this is the whole of the feature on the data side.
 */

const session = (id: string, x: number, y: number): Session =>
  ({
    id,
    workspaceId: 'ws',
    address: `ws/${id}`,
    window: { x, y, w: 400, h: 300, z: 0, collapsed: false },
  }) as Session;

let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  send = vi.fn();
  useStore.setState({
    sessions: [session('a', 0, 0), session('b', 500, 40), session('other', 2000, 2000)],
    client: { send } as never,
  });
});

describe('moveWindowsBy', () => {
  it('moves only the named windows, by the same offset, keeping their size', () => {
    useStore.getState().moveWindowsBy(['a', 'b'], 30, -10);
    const byId = new Map(useStore.getState().sessions.map((s) => [s.id, s.window]));
    expect(byId.get('a')).toEqual({ x: 30, y: -10, w: 400, h: 300, z: 0, collapsed: false });
    expect(byId.get('b')).toEqual({ x: 530, y: 30, w: 400, h: 300, z: 0, collapsed: false });
    expect(byId.get('other')).toMatchObject({ x: 2000, y: 2000 });
  });

  it('tells the hub about each window it moved, and nothing else', () => {
    useStore.getState().moveWindowsBy(['a', 'b'], 5, 5);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({
      t: 'moveWindow',
      sessionId: 'a',
      rect: { x: 5, y: 5, w: 400, h: 300, z: 0, collapsed: false },
    });
    expect(send.mock.calls.map((c) => c[0].sessionId)).toEqual(['a', 'b']);
  });

  it('sends nothing for a move that does not move', () => {
    useStore.getState().moveWindowsBy(['a'], 0, 0);
    useStore.getState().moveWindowsBy([], 10, 10);
    expect(send).not.toHaveBeenCalled();
  });
});
