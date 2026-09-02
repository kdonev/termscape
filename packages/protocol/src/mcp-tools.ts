import { z } from 'zod';

/**
 * MCP tool schemas. The *caller* is never a parameter: the hub derives the
 * sender from the per-agent bearer token, so `from` cannot be spoofed by an
 * agent that has been talked into lying about who it is.
 */

export const WhoamiInput = z.object({});

export const ListAgentsInput = z.object({
  workspace: z
    .string()
    .optional()
    .describe('Limit to one workspace. Defaults to all workspaces on all hosts.'),
});

export const SendMessageInput = z.object({
  to: z
    .string()
    .describe('Target agent address, "workspace/name". Use list_agents to discover.'),
  text: z.string().min(1).max(8000).describe('Message body, injected into the target terminal.'),
});

export const SpawnAgentInput = z.object({
  profile: z.string().optional().describe('Agent profile id. Defaults to your own profile.'),
  name: z.string().optional().describe('Name for the new agent. Auto-generated if omitted.'),
  workspace: z
    .string()
    .optional()
    .describe('Workspace to spawn into. Defaults to your own workspace.'),
  prompt: z
    .string()
    .optional()
    .describe('First instruction, injected once the new agent is ready.'),
});

export const ReadScreenInput = z.object({
  address: z.string().describe('Agent address to inspect.'),
  lines: z.number().int().positive().max(200).optional().describe('Trailing lines to return (default 40).'),
});

export const SetStatusInput = z.object({
  text: z.string().max(120).describe('Short status shown under your window title on the canvas.'),
});

export const StopAgentInput = z.object({
  address: z.string().describe('Agent to stop. You may only stop agents you spawned.'),
});

export type WhoamiInput = z.infer<typeof WhoamiInput>;
export type ListAgentsInput = z.infer<typeof ListAgentsInput>;
export type SendMessageInput = z.infer<typeof SendMessageInput>;
export type SpawnAgentInput = z.infer<typeof SpawnAgentInput>;
export type ReadScreenInput = z.infer<typeof ReadScreenInput>;
export type SetStatusInput = z.infer<typeof SetStatusInput>;
export type StopAgentInput = z.infer<typeof StopAgentInput>;

/** Max bytes accepted in a single send_message body (mirrors the zod cap). */
export const MAX_MESSAGE_BYTES = 8000;
/** Per-sender delivery budget, enforced by the router. */
export const MESSAGE_RATE_LIMIT = { windowMs: 10_000, max: 20 } as const;
