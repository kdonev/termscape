import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@termscape/protocol';
import { useStore } from '../src/state/store.js';

/*
 * A spawn is the one creation nobody clicked: an agent the user is looking at
 * brings a child into the world mid-session. The store is what decides the
 * canvas should frame parent and child together, and it can only do that when
 * the upsert is (a) genuinely new and (b) parented by the window the user has
 * selected.
 */

let n = 0;
const session = (over: Partial<Session>): Session =>
  ({
    id: `s${++n}`,
    workspaceId: 'ws',
    name: 'agent',
    address: 'ws/agent',
    profile: 'claude',
    template: null,
    model: null,
    effort: null,
    cwd: '.',
    agentSessionUuid: null,
    spawnedBy: null,
    state: 'starting',
    status: 'unknown',
    statusText: null,
    title: null,
    pid: null,
    exitCode: null,
    cols: 100,
    rows: 30,
    resumable: false,
    createdAt: 0,
    exitedAt: null,
    lastActiveAt: 0,
    window: { x: 0, y: 0, w: 720, h: 460, z: 0, collapsed: false },
    ...over,
  }) as Session;

const reset = (): void => {
  useStore.setState({ sessions: [], selectedId: null, focusRequest: null });
};

beforeEach(reset);

describe('a spawn widening the focus', () => {
  it('frames parent and child when the selected window spawns', () => {
    const parent = session({ id: 'parent' });
    useStore.setState({ sessions: [parent], selectedId: 'parent' });

    useStore.getState().apply({
      t: 'sessionUpserted',
      session: session({ id: 'child', spawnedBy: 'parent' }),
    });

    const r = useStore.getState().focusRequest;
    expect(r?.sessionId).toBe('child');
    expect(r?.alsoId).toBe('parent');
    // The parent keeps the keyboard: selection must not move.
    expect(useStore.getState().selectedId).toBe('parent');
  });

  it('does nothing when the spawner is not the selected window', () => {
    const parent = session({ id: 'parent' });
    useStore.setState({ sessions: [parent], selectedId: null });

    useStore.getState().apply({
      t: 'sessionUpserted',
      session: session({ id: 'child', spawnedBy: 'parent' }),
    });

    expect(useStore.getState().focusRequest).toBeNull();
  });

  it('does nothing for a window created without a parent', () => {
    useStore.setState({ sessions: [], selectedId: 'parent' });

    useStore.getState().apply({ t: 'sessionUpserted', session: session({ id: 'child' }) });

    expect(useStore.getState().focusRequest).toBeNull();
  });

  it('does nothing when the upsert is an update, not a new window', () => {
    const child = session({ id: 'child', spawnedBy: 'parent' });
    useStore.setState({ sessions: [session({ id: 'parent' }), child], selectedId: 'parent' });

    useStore.getState().apply({
      t: 'sessionUpserted',
      session: { ...child, state: 'running' },
    });

    expect(useStore.getState().focusRequest).toBeNull();
  });
});
