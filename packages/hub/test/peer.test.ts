import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { WebSocket as WsClient } from 'ws';
import { BinaryFrameKind, encodeBinaryFrame, type Host } from '@termscape/protocol';
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

  it('answers a canvas-initiated remote start with a canvas-keyed session', async () => {
    // The dialog's ack names what it created, and the canvas flies to it. A
    // reply still carrying the peer's internal uuid would send the selection
    // to an id no window answers to.
    const host = hubA.store.listHosts()[0]!;
    const ws = hubA.createWorkspace('remote-start', homeB, host.id);
    const s = await hubA.startSession({
      workspaceId: ws.id,
      profile: 'shell',
      name: 'spawned',
    });

    expect(s.address).toBe('remote-start/spawned');
    expect(s.id).toBe(s.address);
    // Its layout was minted locally on arrival, so the sessionUpserted
    // broadcast that follows resolves this same rect rather than a rival one.
    expect(hubA.store.getRemoteWindows().get(s.address)).toBeDefined();
  });

  it('keeps lineage when a canvas-hub agent spawns into a remote workspace', async () => {
    // The spawner lives here, the child's PTY lands on the peer; the only id
    // both hubs agree on is the spawner's address, and the registry has to
    // translate it back — otherwise the canvas cannot frame the pair.
    const host = hubA.store.listHosts()[0]!;
    const ws = hubA.createWorkspace('spawn-remote', homeB, host.id);
    const parent = await hubA.startSession({
      workspaceId: wsA,
      profile: 'shell',
      name: 'spawner',
    });

    await hubA.spawnAgent(parent.id, { workspace: ws.name, name: 'far-child' });
    await waitFor(
      () =>
        hubA.peers.sessions().find((s) => s.address === 'spawn-remote/far-child')
          ?.spawnedBy === parent.id,
      15_000,
      'remote child carrying its local parent id',
    );
  });

  it('keeps lineage for an unnamed remote spawn, whose first upsert races the reply', async () => {
    // The default path: spawn_agent with no name. Nothing about the child is
    // predictable from here — which is why its id is chosen on this side of
    // the link, so the lineage can be keyed on it before any frame moves.
    const host = hubA.store.listHosts()[0]!;
    const ws = hubA.createWorkspace('spawn-remote-2', homeB, host.id);
    const parent = await hubA.startSession({
      workspaceId: wsA,
      profile: 'shell',
      name: 'spawner-2',
    });

    await hubA.spawnAgent(parent.id, { workspace: ws.name });
    await waitFor(
      () =>
        // Unnamed: the peer names the child after the agent, so match the
        // workspace by address prefix rather than by our own workspace id,
        // which the re-keyed session does not carry.
        hubA.peers.sessions().some(
          (s) => s.address.startsWith('spawn-remote-2/') && s.spawnedBy === parent.id,
        ),
      15_000,
      'unnamed remote child carrying its local parent id',
    );
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

/**
 * `list_hosts`, and `spawn_agent`'s `host`, across a real second machine:
 * the one thing hosts.test.ts's single hub cannot exercise — reachability,
 * relaying an ask through `relayResult`, an attached hub learning its own
 * label, and the lineage gap spawning across the link deliberately leaves
 * open.
 */
describe("list_hosts and spawn_agent's host, across the link", () => {
  let hostId: string;
  let hostWsName: string;

  beforeAll(async () => {
    hostId = hubA.store.listHosts()[0]!.id;
    // A row the canvas actually holds for the host, so it is something
    // spawn_agent can target rather than a rowless entry list_hosts can only
    // show. Reused from an earlier test would work too, but a name of its
    // own keeps this block independent of what ran before it.
    hostWsName = hubA.createWorkspace('hostcrew', homeB, hostId).name;

    // B needs to have learned its own label from the canvas before a spawn
    // naming it by that label can take the local shortcut rather than
    // relaying to itself — see spawn_agent's `host: 'test-remote'` test below.
    await waitForAsync(
      async () =>
        (await hubB.listAgents(hubB.sessions.getByAddress('remotews/there')!.id)).find(
          (a) => a.address === 'remotews/there',
        )?.host === 'test-remote',
      15_000,
      "B to learn its own label from the canvas's directory",
    );
  }, 30_000);

  it('lists both machines from the canvas, marking test-remote as itself only from over there', async () => {
    const here = hubA.sessions.getByAddress('localws/here')!;
    const hosts = await hubA.listHosts(here.id);

    expect(hosts).toHaveLength(2);
    const canvas = hosts.find((h) => h.id === '')!;
    expect(canvas.label).toBe('canvas');
    expect(canvas.you).toBe(true);

    const remote = hosts.find((h) => h.id === hostId)!;
    expect(remote.label).toBe('test-remote');
    expect(remote.you).toBe(false);
    expect(remote.state).toBe('connected');
    expect(remote.workspaces.some((w) => w.name === hostWsName)).toBe(true);
    expect(remote.agents.some((a) => a.id === 'shell' && a.available === true)).toBe(true);
  });

  it('relays from the attached side, marking test-remote as itself there instead', async () => {
    const there = hubB.sessions.getByAddress('remotews/there')!;
    const hosts = await hubB.listHosts(there.id);

    expect(hosts).toHaveLength(2);
    // The assertion that proves `host.id` survives the trip through
    // registry.ts's relay event: without it every relayed caller looks like
    // nobody in particular, and this could never be true from over here.
    expect(hosts.find((h) => h.id === '')!.you).toBe(false);
    expect(hosts.find((h) => h.label === 'test-remote')!.you).toBe(true);
  });

  it('spawns onto a named host from the canvas', async () => {
    const here = hubA.sessions.getByAddress('localws/here')!;
    const result = await hubA.spawnAgent(here.id, {
      host: 'test-remote',
      workspace: hostWsName,
      name: 'byhost',
    });
    expect(result.host).toBe('test-remote');
    expect(hubB.sessions.getByAddress(`${hostWsName}/byhost`)).not.toBeNull();
  });

  it('refuses an unknown host from the canvas, naming what exists', async () => {
    const here = hubA.sessions.getByAddress('localws/here')!;
    await expect(hubA.spawnAgent(here.id, { host: 'nope' })).rejects.toThrow(/unknown host/i);
  });

  it('refuses to guess between several workspaces on the canvas when the caller is elsewhere', async () => {
    const there = hubB.sessions.getByAddress('remotews/there')!;
    // Neither name has anything to do with 'remotews', the caller's own —
    // the one case a single-hub rig cannot produce, because a caller there
    // is always itself one of the candidates being disambiguated.
    mkdirSync(join(homeA, 'ambigA'), { recursive: true });
    mkdirSync(join(homeA, 'ambigB'), { recursive: true });
    hubA.createWorkspace('ambigA', join(homeA, 'ambigA'));
    hubA.createWorkspace('ambigB', join(homeA, 'ambigB'));

    await expect(hubB.spawnAgent(there.id, { host: 'canvas' })).rejects.toThrow(
      /several workspaces/,
    );
  });

  it('spawns onto the canvas from the attached side, with the prompt attributed once', async () => {
    const there = hubB.sessions.getByAddress('remotews/there')!;
    const result = await hubB.spawnAgent(there.id, {
      host: 'canvas',
      workspace: 'localws',
      name: 'fromb',
      prompt: 'hello from the attached side',
    });
    expect(result.host).toBe('canvas');

    await waitFor(
      () => hubA.sessions.getByAddress('localws/fromb') !== null,
      15_000,
      'the relayed spawn to land on the canvas',
    );
    const child = hubA.sessions.getByAddress('localws/fromb')!;

    await waitFor(
      () => (outputA.get(child.id) ?? '').includes('hello from the attached side'),
      15_000,
      'the prompt to reach the new terminal',
    );
    const text = outputA.get(child.id) ?? '';
    expect(text.split(`[from ${there.address}]`).length - 1).toBe(1);
  });

  it(
    'spawns onto its own machine by label and stays local — the regression guard for the ' +
      'lineage gap',
    async () => {
      const there = hubB.sessions.getByAddress('remotews/there')!;
      const result = await hubB.spawnAgent(there.id, { host: 'test-remote', name: 'ownlabel' });
      expect(result.host).toBe('test-remote');

      const child = hubB.sessions.getByAddress('remotews/ownlabel')!;
      // A relayed spawn cannot keep this — see the known gap on spawn_agent's
      // `host` — so proving it survives here is what shows the self-shortcut
      // actually took the local path rather than relaying to itself.
      expect(child.spawnedBy).toBe(there.id);
      expect((await hubB.stopAgent(there.id, child.address)).stopped).toBe(child.address);
    },
  );

  it("propagates the canvas's own refusal through relayResult", async () => {
    const there = hubB.sessions.getByAddress('remotews/there')!;
    await expect(hubB.spawnAgent(there.id, { host: 'nope' })).rejects.toThrow(/unknown host/i);
  });

  it('spawns with no host at all without ever touching the link', async () => {
    const there = hubB.sessions.getByAddress('remotews/there')!;
    hubA.peers.peer(hostId)!.close();
    try {
      const result = await hubB.spawnAgent(there.id, { name: 'nolink' });
      expect(result.workspace).toBe('remotews');
      expect(hubB.sessions.getByAddress('remotews/nolink')).not.toBeNull();
    } finally {
      // Reconnect for everything after this block, mirroring the recovery
      // pattern the peer-loss tests further down use themselves.
      hubA.peers.add(hubA.store.listHosts()[0]!, peerUrlB, PEER_TOKEN);
      await waitFor(() => hubA.peers.peer(hostId)?.connected === true, 15_000, 'peer link');
    }
  });
});

/*
 * A mouse report is the one kind of terminal input that cannot survive being
 * treated as text, and a remote session is the one path that has to spell it
 * as text to cross a JSON link. This is where those two meet.
 *
 * The assertion is deliberately at the far hub's pty boundary rather than at
 * the program: what a shell does with a wheel report is its own business, and
 * the question here is only whether the bytes the browser encoded are the
 * bytes that arrive on the other machine.
 */
describe('remote terminal input', () => {
  /** A browser socket on hub A, authenticated and ready to send frames. */
  async function browser(): Promise<WsClient> {
    const sock = new WsClient(`${originA.replace('http', 'ws')}/ws`);
    await new Promise<void>((res, rej) => {
      sock.on('open', () => res());
      sock.on('error', rej);
    });
    sock.send(JSON.stringify({ t: 'hello', token: 'client-token' }));
    // `ready` is the hub saying the token was accepted; frames sent before it
    // are dropped as unauthenticated.
    await new Promise<void>((res) => {
      sock.on('message', function onMsg(raw: Buffer) {
        if (JSON.parse(raw.toString()).t === 'ready') {
          sock.off('message', onMsg);
          res();
        }
      });
    });
    return sock;
  }

  it('carries a wheel report to the far pty byte for byte', async () => {
    await hubB.startSession({ workspaceId: wsB, profile: 'shell', name: 'wheelie' });
    await waitFor(
      () => hubA.peers.find('remotews/wheelie') !== null,
      15_000,
      'remote session to reach the canvas',
    );

    /*
     * Column 120 and row 40, which is the case that matters: the default
     * encoding spells a coordinate as `32 + n`, so 120 is 0x98 - past the
     * ASCII range, and not valid UTF-8 on its own. Encoded as text anywhere
     * on this path it would arrive as two bytes and decode as a different
     * button somewhere else entirely.
     */
    const report = Buffer.from([0x1b, 0x5b, 0x4d, 32 + 64, 32 + 120, 32 + 40]);

    const seen: Buffer[] = [];
    const real = hubB.sessions.writeBytes.bind(hubB.sessions);
    hubB.sessions.writeBytes = (id: string, data: Buffer) => {
      seen.push(Buffer.from(data));
      real(id, data);
    };

    const sock = await browser();
    try {
      sock.send(
        encodeBinaryFrame(BinaryFrameKind.PtyInputRaw, 'remotews/wheelie', report),
        { binary: true },
      );
      await waitFor(() => seen.length > 0, 10_000, 'the report to reach the far pty');
    } finally {
      hubB.sessions.writeBytes = real;
      sock.close();
    }

    expect(seen[0]!.equals(report)).toBe(true);
  });

  it('keeps text input on the text path, so it is not latin1-mangled', async () => {
    const seen: string[] = [];
    const real = hubB.sessions.write.bind(hubB.sessions);
    hubB.sessions.write = (id: string, data: string) => {
      seen.push(data);
      real(id, data);
    };

    const sock = await browser();
    try {
      sock.send(
        encodeBinaryFrame(
          BinaryFrameKind.PtyInput,
          'remotews/wheelie',
          Buffer.from('héllo', 'utf8'),
        ),
        { binary: true },
      );
      await waitFor(() => seen.length > 0, 10_000, 'text to reach the far pty');
    } finally {
      hubB.sessions.write = real;
      sock.close();
    }

    // Non-ASCII text still arrives as the character, not as its two bytes -
    // the raw path must not have swallowed the ordinary one on its way in.
    expect(seen[0]).toBe('héllo');
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
