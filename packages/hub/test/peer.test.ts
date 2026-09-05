import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Host } from '@aicanvas/protocol';
import { Hub, HUB_VERSION } from '../src/hub.js';
import { serve } from '../src/server.js';

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

const PEER_TOKEN = 'peer-token-for-tests';
const outputB = new Map<string, string>();

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
  homeA = mkdtempSync(join(tmpdir(), 'aicanvas-A-'));
  homeB = mkdtempSync(join(tmpdir(), 'aicanvas-B-'));
  process.env.AICANVAS_HOME = homeA;

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
  hubA.peers.add(host, `ws://127.0.0.1:${portB}/peer`, PEER_TOKEN);

  await waitFor(() => hubA.peers.peer(host.id)?.connected === true, 15_000, 'peer link');
}, 60_000);

afterAll(async () => {
  hubA.shutdown();
  hubB.shutdown();
  await appA.close();
  await appB.close();
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
  delete process.env.AICANVAS_HOME;
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
