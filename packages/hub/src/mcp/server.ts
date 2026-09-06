import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListAgentsInput,
  ReadScreenInput,
  SendMessageInput,
  SetStatusInput,
  SpawnAgentInput,
  StopAgentInput,
  WhoamiInput,
} from '@termscape/protocol';

/**
 * Operations the MCP tools need. Implemented by the Hub; kept as an interface
 * so the tool layer has no idea whether a target agent is local or on a peer.
 */
export interface AgentApi {
  whoami(sessionId: string): Promise<unknown>;
  listAgents(sessionId: string, workspace?: string): Promise<unknown>;
  sendMessage(sessionId: string, to: string, text: string): Promise<unknown>;
  spawnAgent(
    sessionId: string,
    opts: { profile?: string; name?: string; workspace?: string; prompt?: string },
  ): Promise<unknown>;
  readScreen(sessionId: string, address: string, lines?: number): Promise<unknown>;
  setStatus(sessionId: string, text: string): Promise<unknown>;
  stopAgent(sessionId: string, address: string): Promise<unknown>;
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

/** Wrap a handler so a thrown error becomes a tool error, not a 500. */
async function guard(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail((err as Error).message);
  }
}

/**
 * Build an MCP server bound to one calling agent.
 *
 * A fresh server and transport are created per request (stateless mode). That
 * is the right shape here because the caller's identity comes from the bearer
 * token on each request, so there is no cross-request session state worth
 * keeping, and no way for one agent's connection to be reused by another.
 */
export function buildMcpServer(callerSessionId: string, api: AgentApi): McpServer {
  const server = new McpServer(
    { name: 'termscape', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'whoami',
    {
      description: 'Your own agent address, workspace and working directory.',
      inputSchema: WhoamiInput.shape,
    },
    () => guard(() => api.whoami(callerSessionId)),
  );

  server.registerTool(
    'list_agents',
    {
      description:
        'List every agent on the canvas: address, profile, whether it is idle or busy, and what it is doing.',
      inputSchema: ListAgentsInput.shape,
    },
    ({ workspace }) => guard(() => api.listAgents(callerSessionId, workspace)),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to another agent. It is typed directly into their terminal, immediately, even if they are mid-task. Your address is attached automatically and cannot be forged.',
      inputSchema: SendMessageInput.shape,
    },
    ({ to, text }) => guard(() => api.sendMessage(callerSessionId, to, text)),
  );

  server.registerTool(
    'spawn_agent',
    {
      description:
        'Start a new agent, by default in your own workspace, and optionally give it a first instruction. Use this to delegate work you want done in parallel.',
      inputSchema: SpawnAgentInput.shape,
    },
    (opts) => guard(() => api.spawnAgent(callerSessionId, opts)),
  );

  server.registerTool(
    'read_screen',
    {
      description:
        "Read the last lines of another agent's terminal without interrupting it. Prefer this over messaging when you only want to check progress.",
      inputSchema: ReadScreenInput.shape,
    },
    ({ address, lines }) => guard(() => api.readScreen(callerSessionId, address, lines)),
  );

  server.registerTool(
    'set_status',
    {
      description:
        'Set a short status label shown under your window on the canvas, so the human can see what you are doing.',
      inputSchema: SetStatusInput.shape,
    },
    ({ text }) => guard(() => api.setStatus(callerSessionId, text)),
  );

  server.registerTool(
    'stop_agent',
    {
      description: 'Stop an agent you spawned.',
      inputSchema: StopAgentInput.shape,
    },
    ({ address }) => guard(() => api.stopAgent(callerSessionId, address)),
  );

  return server;
}

export function buildMcpTransport(): StreamableHTTPServerTransport {
  // Stateless: no server-assigned MCP session ids. Identity is the token.
  return new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
}
