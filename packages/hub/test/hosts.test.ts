import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.js';
import { removeTree } from './tmp.js';

/*
 * `list_hosts`, and `spawn_agent`'s `host`, on a single hub with no machines
 * attached to it. The canvas-machine-with-no-hosts case, and the resolution
 * rules that do not need a second hub to exercise: picking a machine by
 * 'canvas'/'local', an unknown host, workspace disambiguation, and the CLI
 * check. A real second machine — reachability, relaying, and lineage — is
 * peer.test.ts's job.
 */

let dir: string;
let hub: Hub;

const folder = (name: string): string => {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
};

const writeConfig = (toml: string): void => writeFileSync(join(dir, 'agents.toml'), toml);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-hosts-'));
  process.env.TERMSCAPE_HOME = dir;
  hub = new Hub({ dbPath: join(dir, 'state.db') });
});

afterEach(() => {
  hub.shutdown();
  delete process.env.TERMSCAPE_HOME;
  removeTree(dir);
});

describe('list_hosts, with no hosts attached', () => {
  it('reports exactly the canvas machine', async () => {
    const ws = hub.createWorkspace('crew', folder('crew'));
    const me = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });

    const hosts = await hub.listHosts(me.id);

    expect(hosts).toHaveLength(1);
    const canvas = hosts[0]!;
    expect(canvas.id).toBe('');
    expect(canvas.label).toBe('canvas');
    expect(canvas.kind).toBe('canvas');
    expect(canvas.you).toBe(true);
    expect(canvas.workspaces.find((w) => w.name === 'crew')?.rootPath).toBe(ws.rootPath);
    expect(canvas.agents.some((a) => a.id === 'shell' && a.available === true)).toBe(true);
  });

  it("counts a workspace's agents as sessions start", async () => {
    const ws = hub.createWorkspace('crew', folder('crew'));
    const me = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });

    let hosts = await hub.listHosts(me.id);
    expect(hosts[0]!.workspaces.find((w) => w.name === 'crew')?.agents).toBe(1);

    await hub.startSession({ workspaceId: ws.id, profile: 'shell' });
    hosts = await hub.listHosts(me.id);
    expect(hosts[0]!.workspaces.find((w) => w.name === 'crew')?.agents).toBe(2);
  });
});

describe("spawn_agent's host, with no hosts attached", () => {
  it('lands in the caller\'s own workspace for "canvas" and for "local"', async () => {
    const ws = hub.createWorkspace('crew', folder('crew'));
    const me = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });

    const a = await hub.spawnAgent(me.id, { host: 'canvas' });
    expect(a.workspace).toBe('crew');
    expect(a.host).toBe('canvas');

    const b = await hub.spawnAgent(me.id, { host: 'local' });
    expect(b.workspace).toBe('crew');
    expect(b.host).toBe('canvas');
  });

  it('refuses an unknown host, naming what exists', async () => {
    const ws = hub.createWorkspace('crew', folder('crew'));
    const me = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });

    await expect(hub.spawnAgent(me.id, { host: 'nope' })).rejects.toThrow(/unknown host/i);
    await expect(hub.spawnAgent(me.id, { host: 'nope' })).rejects.toThrow(/canvas/);
  });

  it('with no workspace given, picks the caller\'s own by name among several', async () => {
    const home = hub.createWorkspace('home', folder('home'));
    hub.createWorkspace('crewB', folder('crewB'));
    const me = await hub.startSession({ workspaceId: home.id, profile: 'shell' });

    const a = await hub.spawnAgent(me.id, { host: 'canvas' });
    expect(a.workspace).toBe('home');
  });

  // A caller on the canvas targeting `host: 'canvas'` is always itself one of
  // the candidates being disambiguated, so "several workspaces, none of them
  // the caller's own" cannot arise on a single hub — the caller's own
  // workspace is unavoidably in the running. That refusal is exercised in
  // peer.test.ts instead, where the caller lives on a different machine
  // entirely and its workspace name genuinely is not one of the target's.

  it('refuses a host that cannot run the requested CLI, naming what it has', async () => {
    hub.shutdown();
    // No command given: it defaults to the table id itself, which is not a
    // real binary — the same "declared but not installed" shape
    // detect.test.ts drives with an explicit one.
    writeConfig('[missing]\ndescription = "not really here"\n');
    hub = new Hub({ dbPath: join(dir, 'state.db') });
    await hub.agents.refresh();

    const ws = hub.createWorkspace('crew', folder('crew'));
    const me = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });

    await expect(
      hub.spawnAgent(me.id, { host: 'canvas', profile: 'missing' }),
    ).rejects.toThrow(/cannot run "missing"/);
    await expect(
      hub.spawnAgent(me.id, { host: 'canvas', profile: 'missing' }),
    ).rejects.toThrow(/it has:.*shell/);
  });
});
