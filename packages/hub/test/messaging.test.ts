import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { Hub } from '../src/hub.js';
import { serve } from '../src/server.js';

/**
 * End-to-end proof of the core idea, with no LLM in the loop: two real PTYs
 * running plain shells, an agent calling the hub's MCP endpoint, and the
 * message landing as typed input in the other terminal.
 */

let home: string;
let hub: Hub;
let app: FastifyInstance;
let origin: string;
let workspaceId: string;

/** Everything each session has printed, so we can assert on what was typed. */
const output = new Map<string, string>();

function waitFor(fn: () => boolean, ms = 15_000, label = 'condition'): Promise<void> {
  return new Promise((res, rej) => {
    const started = Date.now();
    const tick = () => {
      if (fn()) return res();
      if (Date.now() - started > ms) return rej(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function mcpClient(sessionId: string): Promise<Client> {
  const token = hub.tokens.get(sessionId);
  if (!token) throw new Error(`no token minted for ${sessionId}`);
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'termscape-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** Tool results come back as JSON in a text block. */
function parseResult(res: any): any {
  const text = res?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('tool returned no text content');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'termscape-home-'));
  process.env.TERMSCAPE_HOME = home;

  hub = new Hub({ dbPath: join(home, 'state.db') });
  hub.on('data', (id: string, chunk: string) => {
    output.set(id, (output.get(id) ?? '') + chunk);
  });

  ({ app, origin } = await serve({
    hub,
    port: 0,
    clientToken: 'test-client-token',
    headless: true,
  }));

  workspaceId = hub.createWorkspace('testws', home).id;
});

afterAll(async () => {
  hub.shutdown();
  await app.close();
  rmSync(home, { recursive: true, force: true });
  delete process.env.TERMSCAPE_HOME;
});

describe('agent-to-agent messaging', () => {
  it('delivers a message as typed input in the target terminal', async () => {
    const a = await hub.startSession({ workspaceId, profile: 'shell', name: 'alpha' });
    const b = await hub.startSession({ workspaceId, profile: 'shell', name: 'beta' });

    // Wait for both shells to actually be up and printing.
    await waitFor(() => (output.get(a.id)?.length ?? 0) > 0, 15_000, 'alpha to boot');
    await waitFor(() => (output.get(b.id)?.length ?? 0) > 0, 15_000, 'beta to boot');

    const client = await mcpClient(a.id);

    const agents = parseResult(
      await client.callTool({ name: 'list_agents', arguments: {} }),
    );
    expect(agents.map((x: any) => x.address).sort()).toEqual([
      'testws/alpha',
      'testws/beta',
    ]);
    expect(agents.find((x: any) => x.address === 'testws/alpha').isYou).toBe(true);

    const marker = `PING_${Date.now()}`;
    const sent = parseResult(
      await client.callTool({
        name: 'send_message',
        arguments: { to: 'testws/beta', text: marker },
      }),
    );
    expect(sent.delivered).toBe(true);

    // The message is typed into beta's terminal, attributed to alpha.
    await waitFor(
      () => (output.get(b.id) ?? '').includes(marker),
      15_000,
      'marker to appear in beta',
    );
    expect(output.get(b.id)).toContain('[from testws/alpha]');

    // ...and it did NOT go to the sender's own terminal.
    expect(output.get(a.id) ?? '').not.toContain(marker);

    // The attempt is recorded with its outcome.
    const logged = hub.messages().find((m) => m.body === marker)!;
    expect(logged).toBeDefined();
    expect(logged.fromAddr).toBe('testws/alpha');
    expect(logged.toAddr).toBe('testws/beta');
    expect(logged.deliveryState).toBe('delivered');
    expect(logged.deliveredAt).toBeGreaterThan(0);

    await client.close();
  });

  it('records a failure rather than silently dropping an undeliverable message', async () => {
    const a = hub.sessions.getByAddress('testws/alpha')!;
    const client = await mcpClient(a.id);

    await expect(
      client.callTool({
        name: 'send_message',
        arguments: { to: 'testws/nobody', text: 'anyone there' },
      }),
    ).resolves.toMatchObject({ isError: true });

    const logged = hub.messages().find((m) => m.toAddr === 'testws/nobody')!;
    expect(logged.deliveryState).toBe('failed');
    expect(logged.error).toMatch(/no agent/i);

    await client.close();
  });

  it('refuses to let an agent message itself', async () => {
    const a = hub.sessions.getByAddress('testws/alpha')!;
    const client = await mcpClient(a.id);
    const res: any = await client.callTool({
      name: 'send_message',
      arguments: { to: 'testws/alpha', text: 'hello me' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/yourself/i);
    await client.close();
  });

  it('reports identity from the token, not from arguments', async () => {
    const b = hub.sessions.getByAddress('testws/beta')!;
    const client = await mcpClient(b.id);
    const me = parseResult(await client.callTool({ name: 'whoami', arguments: {} }));
    expect(me.address).toBe('testws/beta');
    expect(me.workspace).toBe('testws');
    await client.close();
  });
});

describe('spawning', () => {
  it('spawns a child into the caller workspace and records lineage', async () => {
    const a = hub.sessions.getByAddress('testws/alpha')!;
    const client = await mcpClient(a.id);

    const spawned = parseResult(
      await client.callTool({
        name: 'spawn_agent',
        arguments: { profile: 'shell', name: 'worker' },
      }),
    );
    expect(spawned.address).toBe('testws/worker');

    const child = hub.sessions.getByAddress('testws/worker')!;
    expect(child.spawnedBy).toBe(a.id);
    expect(child.workspaceId).toBe(workspaceId);
    // Placed below-right of its parent so the lineage reads on the canvas.
    expect(child.window.y).toBeGreaterThan(a.window.y);

    await client.close();
  });

  it('only lets the spawner stop a spawned agent', async () => {
    const beta = hub.sessions.getByAddress('testws/beta')!;
    const alpha = hub.sessions.getByAddress('testws/alpha')!;

    // beta did not spawn worker, so it may not stop it.
    const betaClient = await mcpClient(beta.id);
    const denied: any = await betaClient.callTool({
      name: 'stop_agent',
      arguments: { address: 'testws/worker' },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/not spawned by you/i);
    await betaClient.close();

    // alpha did, so it may.
    const alphaClient = await mcpClient(alpha.id);
    const allowed = parseResult(
      await alphaClient.callTool({
        name: 'stop_agent',
        arguments: { address: 'testws/worker' },
      }),
    );
    expect(allowed.stopped).toBe('testws/worker');
    expect(hub.sessions.getByAddress('testws/worker')!.state).toBe('stopped');
    await alphaClient.close();
  });
});

describe('mcp auth', () => {
  it('rejects a request with no token', async () => {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const res = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });
});
