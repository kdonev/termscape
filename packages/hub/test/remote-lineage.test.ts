import { describe, expect, it } from 'vitest';
import type { Session } from '@termscape/protocol';
import { localizeRemoteSession } from '../src/remote/registry.js';

/*
 * A remote window answers to its address here, not the peer's internal id —
 * and its lineage must make the same journey, or the canvas cannot tell that
 * the freshly appeared window was spawned by the one the user is looking at.
 */

const session = (over: Partial<Session>): Session =>
  ({
    id: 'peer-uuid-child',
    workspaceId: 'peer-ws',
    name: 'child',
    address: 'crew/child',
    profile: 'shell',
    template: null,
    model: null,
    effort: null,
    cwd: '.',
    agentSessionUuid: null,
    spawnedBy: 'peer-uuid-parent',
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

describe('localizeRemoteSession', () => {
  it('re-keys the session to its address', () => {
    const out = localizeRemoteSession(session(), () => null);
    expect(out.id).toBe('crew/child');
  });

  it('translates the parent id into the address the parent answers to here', () => {
    const out = localizeRemoteSession(session(), (id) =>
      id === 'peer-uuid-parent' ? 'crew/parent' : null,
    );
    expect(out.spawnedBy).toBe('crew/parent');
  });

  it('leaves a parent it does not know as it arrived', () => {
    const out = localizeRemoteSession(session(), () => null);
    expect(out.spawnedBy).toBe('peer-uuid-parent');
  });

  it('keeps a null lineage null', () => {
    const out = localizeRemoteSession(session({ spawnedBy: null }), () => 'crew/parent');
    expect(out.spawnedBy).toBeNull();
  });
});
