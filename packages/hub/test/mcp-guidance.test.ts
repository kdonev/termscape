import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, type AgentApi } from '../src/mcp/server.js';

/**
 * The wording that stops an agent from watching a screen instead of waiting
 * for a reply (issue #10), checked over an in-memory transport - no PTY, no
 * port, no real agent. A stub `AgentApi` is enough: these assertions are
 * about what `listTools()` and connect-time `instructions` say, not about
 * what any tool actually does.
 */

const stubApi: AgentApi = {
  whoami: async () => ({}),
  listAgents: async () => [],
  listTemplates: async () => [],
  sendMessage: async () => ({ delivered: true }),
  spawnAgent: async () => ({}),
  readScreen: async () => ({ address: 'ws/x', running: true, screen: '' }),
  setStatus: async () => ({}),
  stopAgent: async () => ({}),
  proposeTemplate: async () => ({}),
};

async function connectedClient(): Promise<Client> {
  const server = buildMcpServer('caller', stubApi);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'guidance-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('MCP-level guidance against polling read_screen', () => {
  it('drops "prefer this over messaging" from read_screen and says the reply arrives on its own', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const readScreen = tools.find((t) => t.name === 'read_screen')!;
    expect(readScreen.description).not.toMatch(/prefer this over messaging/i);
    expect(readScreen.description).toMatch(/starts your next turn/);
    await client.close();
  });

  it('tells send_message callers to end their turn rather than watch for a reply', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const sendMessage = tools.find((t) => t.name === 'send_message')!;
    expect(sendMessage.description).toMatch(/end your turn/);
    await client.close();
  });

  it('carries server-level instructions, for a client that surfaces them before any brief is read', async () => {
    const client = await connectedClient();
    const instructions = client.getInstructions();
    expect(instructions).toBeTruthy();
    expect(instructions).toMatch(/typed/);
    await client.close();
  });
});
