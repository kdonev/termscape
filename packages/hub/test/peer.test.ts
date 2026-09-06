import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Host } from '@termscape/protocol';
import { Hub, HUB_VERSION } from '../src/hub.js';
import { serve } from '../src/server.js';
import { removeTree } from './tmp.js';

/**
 * Cross-host behaviour without SSH.
 *
 * The SSH layer only produces a loopback port that forwards to a remote hub's
 * /peer endpoint. Running a second hub in --headless mode on a local port is
 * therefore the same thing from the peer protocol's point of view, and it
 * exercises the real protocol rather than a mock. Only the deployment and
 * tunnel setup go untested here; the routing does not.
 */

let homeA: string;
let homeB: string;
let hubA: Hub;
let hubB: Hub;
let appA: FastifyInstance;
let appB: FastifyInstance;
let originA: string;
let wsA: string;
let wsB: string;
/** B's peer endpoint, so a test can re-dial it after dropping the link. */
let peerUrlB: string;

const PEER_TOKEN = 'peer-token-for-tests';
const outputB = new Map<string, string>();
const outputA = new Map<string, string>();

function waitFor(fn: () => boolean, ms = 15_000, label = 'condition'): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Same as waitFor, for a condition that has to be awaited to be asked. */
async function waitForAsync(
  fn: () => Promise<boolean>,
  ms = 15_000,
  label = 'condition',
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function mcpAs(hub: Hub, origin: string, sessionId: string): Promise<Client> {
  const token = hub.tokens.get(sessionId)!;
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: 'peer-test', version: '0' });
  await c.connect(transport);
  return c;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

beforeAll(async () => {
  homeA = mkdtempSync(join(tmpdir(), 'termscape-A-'));
  homeB = mkdtempSync(join(tmpdir(), 'termscape-B-'));
  process.env.TERMSCAPE_HOME = homeA;

  // Hub B stands in for the remote machine.
  hubB = new Hub({ dbPath: join(homeB, 'state.db') });
  hubB.on('data', (id: string, chunk: string) =>
    outputB.set(id, (outputB.get(id) ?? '') + chunk),
  );
  ({ app: appB } = await serve({
    hub: hubB,
    port: 0,
    clientToken: PEER_TOKEN,
    headless: true,
  }));
  const portB = (appB.server.address() as { port: number }).port;

  hubA = new Hub({ dbPath: join(homeA, 'state.db') });
  hubA.on('data', (id: string, chunk: string) =>
    outputA.set(id, (outputA.get(id) ?? '') + chunk),
  );
  ({ app: appA, origin: originA } = await serve({
    hub: hubA,
    port: 0,
    clientToken: 'client-token',
    headless: true,
  }));

  wsB = hubB.createWorkspace('remotews', homeB).id;
  wsA = hubA.createWorkspace('localws', homeA).id;

  // Register B as a host of A, exactly as the SSH deployer would once its
  // tunnel is up: a loopback URL plus the peer token.
  const host: Host = {
    id: randomUUID(),
    label: 'test-remote',
    kind: 'ssh',
    sshHost: '127.0.0.1',
    sshUser: 'test',
    sshPort: 22,
    platform: null,
    hubVersion: null,
    state: 'disconnected',
    lastSeenAt: null,
    error: null,
  };
  hubA.store.upsertHost(host);
  peerUrlB = `ws://127.0.0.1:${portB}/peer`;
  hubA.peers.add(host, peerUrlB, PEER_TOKEN);

  await waitFor(() => hubA.peers.peer(host.id)?.connected === true, 15_000, 'peer link');
}, 60_000);

afterAll(async () => {
  hubA.shutdown();
  hubB.shutdown();
  await appA.close();
  await appB.close();
  removeTree(homeA);
  removeTree(homeB);
  delete process.env.TERMSCAPE_HOME;
});

describe('peer link', () => {
  it('handshakes and reports the remote hub version', () => {
    const host = hubA.store.listHosts()[0]!;
    expect(host.state).toBe('connected');
    expect(host.hubVersion).toBe(HUB_VERSION);
  });

  it('surfaces the peer\'s sessions in the local directory', async () => {
    await hubB.startSession({ workspaceId: wsB, profile: 'shell', name: 'worker' });
    await waitFor(
      () => hubA.peers.sessions().some((s) => s.address === 'remotews/worker'),
      15_000,
      'remote session to appear locally',
    );

    const remote = hubA.peers.sessions().find((s) => s.address === 'remotews/worker')!;
    // Re-keyed by address so the browser and the router agree on one id.
    expect(remote.id).toBe('remotews/worker');
    expect(hubA.allSessions().map((s) => s.address)).toContain('remotews/worker');
  });

  it('keeps remote window layout locally, not on the peer', () => {
    const rect = { x: 42, y: 84, w: 800, h: 500, z: 3, collapsed: false };
    expect(hubA.peers.saveLayout('remotews/worker', rect)).toBe(true);

    // Stored in A's database...
    expect(hubA.store.getRemoteWindows().get('remotews/worker')).toEqual(rect);
    // ...and B knows nothing about it, because layout is not B's business.
    expect(hubB.store.getRemoteWindows().size).toBe(0);
  });
});

describe('cross-host messaging', () => {
  it('delivers a message from a local agent into a remote terminal', async () => {
    const local = await hubA.startSession({
      workspaceId: wsA,
      profile: 'shell',
      name: 'sender',
    });
    const remote = hubB.sessions.getByAddress('remotews/worker')!;
    await waitFor(() => (outputB.get(remote.id)?.length ?? 0) > 0, 15_000, 'remote shell boot');

    const client = await mcpAs(hubA, originA, local.id);

    // The sender addresses a remote agent exactly as it would a local one.
    const agents = parse(await client.callTool({ name: 'list_agents', arguments: {} }));
    const remoteEntry = agents.find((a: any) => a.address === 'remotews/worker');
    expect(remoteEntry).toBeDefined();
    expect(remoteEntry.host).toBe('test-remote');

    const marker = `XHOST_${Date.now()}`;
    const sent = parse(
      await client.callTool({
        name: 'send_message',
        arguments: { to: 'remotews/worker', text: marker },
      }),
    );
    expect(sent.delivered).toBe(true);

    // It arrives as typed input on the other hub, attributed to the origin.
    await waitFor(
      () => (outputB.get(remote.id) ?? '').includes(marker),
      15_000,
      'marker in remote terminal',
    );
    expect(outputB.get(remote.id)).toContain('[from localws/sender]');

    // Both hubs record it: A the origin attempt, B the actual delivery.
    expect(hubA.messages().some((m) => m.body === marker && m.deliveryState === 'delivered')).toBe(true);
    expect(hubB.messages().some((m) => m.body === marker)).toBe(true);

    await client.close();
  });

  it('reads a remote screen without interrupting it', async () => {
    const local = hubA.sessions.getByAddress('localws/sender')!;
    const client = await mcpAs(hubA, originA, local.id);
    const r = parse(
      await client.callTool({
        name: 'read_screen',
        arguments: { address: 'remotews/worker', lines: 10 },
      }),
    );
    expect(r.address).toBe('remotews/worker');
    expect(r.running).toBe(true);
    expect(typeof r.screen).toBe('string');
    await client.close();
  });

  it('fails cleanly for an address on no hub at all', async () => {
    const local = hubA.sessions.getByAddress('localws/sender')!;
    const client = await mcpAs(hubA, originA, local.id);
    const res: any = await client.callTool({
      name: 'send_message',
      arguments: { to: 'nowhere/nobody', text: 'hello?' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no agent at address/i);
    await client.close();
  });
});

describe('remote window removal', () => {
  it('removes the session on the hub that owns it', async () => {
    await hubB.startSession({ workspaceId: wsB, profile: 'shell', name: 'doomed' });
    await waitFor(
      () => hubA.peers.sessions().some((s) => s.address === 'remotews/doomed'),
      15_000,
      'remote session to appear locally',
    );
    hubA.peers.saveLayout('remotews/doomed', {
      x: 10, y: 20, w: 720, h: 460, z: 0, collapsed: false,
    });

    expect(await hubA.peers.removeSession('remotews/doomed')).toBe(true);

    // Gone where it actually lives, not merely hidden here.
    expect(hubB.sessions.getByAddress('remotews/doomed')).toBeNull();
    expect(hubA.peers.sessions().some((s) => s.address === 'remotews/doomed')).toBe(false);
    // The saved layout goes too, or a session of the same name inherits it.
    expect(hubA.store.getRemoteWindows().has('remotews/doomed')).toBe(false);
    expect(hubA.store.pendingRemovals()).toEqual([]);
  });

  it('replays a removal requested while the host was unreachable', async () => {
    const host = hubA.store.listHosts()[0]!;
    await hubB.startSession({ workspaceId: wsB, profile: 'shell', name: 'ghost' });
    await waitFor(
      () => hubA.peers.sessions().some((s) => s.address === 'remotews/ghost'),
      15_000,
      'remote session to appear locally',
    );

    hubA.peers.peer(host.id)!.close();
    expect(await hubA.peers.removeSession('remotews/ghost')).toBe(true);

    // The window goes now — the user closed it — and the instruction waits.
    expect(hubA.peers.sessions().some((s) => s.address === 'remotews/ghost')).toBe(false);
    expect(hubA.store.pendingRemovals().map((p) => p.address)).toEqual(['remotews/ghost']);
    expect(hubB.sessions.getByAddress('remotews/ghost')).not.toBeNull();

    // Reconnecting is what makes it stick. This is the restart path: the queue
    // outlived the link, so the session cannot come back with it.
    hubA.peers.add(host, peerUrlB, PEER_TOKEN);
    await waitFor(
      () => hubB.sessions.getByAddress('remotews/ghost') === null,
      15_000,
      'deferred removal to reach the host',
    );
    await waitFor(
      () => hubA.store.pendingRemovals().length === 0,
      10_000,
      'the queue to drain',
    );
    expect(hubA.peers.sessions().some((s) => s.address === 'remotews/ghost')).toBe(false);
  });

  it('takes the agents of a remote workspace with it when it goes', async () => {
    const host = hubA.store.listHosts()[0]!;
    // The whole path as the canvas walks it: a workspace row here pointed at
    // a host, and an agent started through it that runs over there.
    const ws = hubA.createWorkspace('doomedws', process.cwd(), host.id);
    const agent = await hubA.startSession({ workspaceId: ws.id, profile: 'shell' });
    await waitFor(
      () => hubB.sessions.getByAddress(agent.address) !== null,
      15_000,
      'the agent to start on the host',
    );

    await hubA.removeWorkspace(ws.id);

    // Without this the peer keeps running it, and the next resync brings it
    // back as a window belonging to a workspace that no longer exists.
    await waitFor(
      () => hubB.sessions.getByAddress(agent.address) === null,
      15_000,
      'the removal to reach the host',
    );
    expect(hubA.peers.sessions().some((s) => s.address === agent.address)).toBe(false);
    // Everything else on that host is left alone.
    expect(hubB.sessions.getByAddress('remotews/worker')).not.toBeNull();
  });
});

/**
 * The link carries knowledge in one direction on its own: the canvas asks a
 * host for its sessions. These are the frames that carry it back, without
 * which an agent on an attached machine can neither see nor reach anything
 * beyond that machine.
 */
describe('an agent on an attached machine', () => {
  it('sees the agents on the machine that owns the canvas', async () => {
    const here = await hubA.startSession({ workspaceId: wsA, profile: 'shell', name: 'here' });
    const there = await hubB.startSession({ workspaceId: wsB, profile: 'shell', name: 'there' });

    await waitForAsync(
      async () => (await hubB.listAgents(there.id)).some((a) => a.address === here.address),
      15_000,
      'the canvas to announce itself',
    );

    const agents = await hubB.listAgents(there.id);
    const seen = agents.find((a) => a.address === here.address)!;
    // Named by the machine it is on, so an agent can tell where a peer lives.
    expect(seen.host).toBe('canvas');
    expect(seen.workspace).toBe('localws');

    // Its own agents come from its own session list. Announcing them back
    // would have every one of them listed twice.
    expect(agents.filter((a) => a.address === there.address)).toHaveLength(1);
    expect(agents.find((a) => a.address === there.address)!.isYou).toBe(true);
  });

  it('messages one of them, and it lands in the real terminal', async () => {
    const here = hubA.sessions.getByAddress('localws/here')!;
    const there = hubB.sessions.getByAddress('remotews/there')!;

    // Only the canvas knows where an address lives, so this goes up the link
    // and comes back with a verdict rather than being routed here.
    const r = await hubB.sendMessage(there.id, here.address, 'ping from the other side');
    expect(r.delivered).toBe(true);

    await waitFor(
      () => (outputA.get(here.id) ?? '').includes('ping from the other side'),
      15_000,
      'the message to reach the terminal on the canvas machine',
    );
    // Attribution survives the extra hop, and is the sender's real address.
    expect(outputA.get(here.id)).toContain(`[from ${there.address}]`);

    // Recorded on the machine that sent it, so its own log is complete.
    const logged = hubB.store.listMessages().find((m) => m.body.includes('other side'));
    expect(logged?.deliveryState).toBe('delivered');
  });

  it('reads the screen of one of them', async () => {
    const there = hubB.sessions.getByAddress('remotews/there')!;
    // list_agents advertises these addresses now, so every tool that takes an
    // address has to reach them - not just the one that sends messages.
    // Delivery types the message into the other terminal, so the screen
    // catches up a beat after the send resolves - and on the slower ConPTY
    // of a Windows runner the first read can still be only the shell banner.
    let screen = await hubB.readScreen(there.id, 'localws/here');
    const deadline = Date.now() + 10_000;
    while (!screen.screen.includes('other side') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      screen = await hubB.readScreen(there.id, 'localws/here');
    }
    expect(screen.address).toBe('localws/here');
    expect(screen.running).toBe(true);
    // Dumped on failure: vitest truncates the received value, and what the
    // terminal actually rendered is the whole question when platforms
    // disagree - a long prompt wrapping this message is how read_screen was
    // caught splitting words at the window edge.
    expect(screen.screen, `read_screen returned:
${screen.screen}`).toContain(
      'other side',
    );
  });

  it('reports a failure rather than swallowing it', async () => {
    const there = hubB.sessions.getByAddress('remotews/there')!;
    await expect(
      hubB.sendMessage(there.id, 'localws/nobody', 'into the void'),
    ).rejects.toThrow(/no agent/);
  });
});

describe('peer loss', () => {
  it('reports remote sessions as stopped when the link is down', async () => {
    const host = hubA.store.listHosts()[0]!;
    hubA.peers.peer(host.id)!.close();

    await waitFor(
      () => hubA.peers.sessions().every((s) => s.state !== 'running'),
      10_000,
      'remote sessions to go offline',
    );

    // The window survives with its position: layout is local, so losing the
    // host must not lose the user's arrangement.
    const still = hubA.peers.sessions().find((s) => s.address === 'remotews/worker');
    expect(still).toBeDefined();
    expect(still!.window.x).toBe(42);
    expect(still!.state).toBe('stopped');
  });
});
