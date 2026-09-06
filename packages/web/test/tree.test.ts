import { describe, expect, it } from 'vitest';
import type { Host, Session, Workspace } from '@termscape/protocol';
import { buildTree, sessionsIn } from '../src/state/tree.js';
import { workspaceBounds } from '../src/canvas/viewport.js';

const workspace = (over: Partial<Workspace>): Workspace => ({
  id: 'w1',
  name: 'api',
  kind: 'local',
  rootPath: '/srv/api',
  hostId: null,
  color: '#888',
  createdAt: 0,
  archivedAt: null,
  ...over,
});

const session = (over: Partial<Session>): Session => ({
  id: 's1',
  workspaceId: 'w1',
  name: 'claude-1',
  address: 'api/claude-1',
  profile: 'claude',
  cwd: '/srv/api',
  agentSessionUuid: null,
  spawnedBy: null,
  state: 'running',
  status: 'idle',
  statusText: null,
  title: null,
  pid: 1,
  exitCode: null,
  cols: 80,
  rows: 24,
  resumable: true,
  createdAt: 0,
  exitedAt: null,
  lastActiveAt: 0,
  window: { x: 0, y: 0, w: 100, h: 100, z: 1, collapsed: false },
  ...over,
});

const host = (over: Partial<Host>): Host => ({
  id: 'h1',
  label: 'studio',
  kind: 'enrolled',
  sshHost: null,
  sshUser: null,
  sshPort: 22,
  platform: 'darwin-arm64',
  hubVersion: '0.1.0',
  state: 'connected',
  lastSeenAt: null,
  error: null,
  ...over,
});

describe('buildTree', () => {
  it('always leads with this machine, hosts or no hosts', () => {
    const tree = buildTree([], [], []);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe('');
    expect(tree[0]!.state).toBe('connected');
  });

  it('files a workspace under the machine its folder is on', () => {
    const local = workspace({ id: 'w1', name: 'here' });
    const remote = workspace({ id: 'w2', name: 'there', hostId: 'h1', kind: 'remote' });
    const tree = buildTree([host({})], [local, remote], []);

    expect(tree[0]!.workspaces.map((w) => w.workspace.id)).toEqual(['w1']);
    expect(tree[1]!.workspaces.map((w) => w.workspace.id)).toEqual(['w2']);
  });

  it('describes an ssh host by where it is dialled', () => {
    const h = host({
      kind: 'ssh',
      sshUser: 'kd',
      sshHost: 'box',
      sshPort: 2222,
      platform: null,
      hubVersion: null,
    });
    expect(buildTree([h], [], [])[1]!.sub).toBe('kd@box:2222');
  });

  it('describes an enrolled host by what it told us, version included', () => {
    expect(buildTree([host({})], [], [])[1]!.sub).toBe('darwin-arm64 · hub 0.1.0');
  });

  it('says a host joined even when it named no platform', () => {
    expect(buildTree([host({ platform: null, hubVersion: null })], [], [])[1]!.sub).toBe('joined');
  });
});

describe('sessionsIn', () => {
  it('matches a local session by workspace id', () => {
    const w = workspace({});
    expect(sessionsIn(w, [session({})])).toHaveLength(1);
    expect(sessionsIn(w, [session({ workspaceId: 'other', address: 'other/a' })])).toHaveLength(0);
  });

  // A peer stamps its own workspace row's id on the sessions it owns, and that
  // id is not a row in this database at all. The address is what travels.
  it('matches a remote session by the workspace half of its address', () => {
    const w = workspace({ id: 'local-uuid', name: 'api', hostId: 'h1', kind: 'remote' });
    const remote = session({ id: 's9', workspaceId: 'peer-uuid', address: 'api/claude-1' });
    expect(sessionsIn(w, [remote])).toHaveLength(1);
  });

  it('does not claim a remote session for a workspace on this machine', () => {
    const local = workspace({ id: 'local-uuid', name: 'api', hostId: null });
    const remote = session({ id: 's9', workspaceId: 'peer-uuid', address: 'api/claude-1' });
    expect(sessionsIn(local, [remote])).toHaveLength(0);
  });
});

// The canvas asks the same question to decide where to draw a workspace frame,
// so this is that expression exactly.
describe('the frame drawn around a workspace', () => {
  it('encloses the windows of a workspace running on another machine', () => {
    const w = workspace({ id: 'local-uuid', name: 'api', hostId: 'h1', kind: 'remote' });
    const members = [
      session({ id: 'api/one', workspaceId: 'peer-uuid', address: 'api/one' }),
      session({
        id: 'api/two',
        workspaceId: 'peer-uuid',
        address: 'api/two',
        window: { x: 800, y: 0, w: 100, h: 100, z: 1, collapsed: false },
      }),
    ];

    const box = workspaceBounds(sessionsIn(w, members).map((s) => s.window));
    expect(box).not.toBeNull();
    // Both windows inside it, which is the whole point of the frame.
    expect(box!.x).toBeLessThanOrEqual(0);
    expect(box!.x + box!.w).toBeGreaterThanOrEqual(900);
  });

  it('draws nothing for a workspace with no windows', () => {
    const w = workspace({ id: 'empty' });
    expect(workspaceBounds(sessionsIn(w, []).map((s) => s.window))).toBeNull();
  });
});
