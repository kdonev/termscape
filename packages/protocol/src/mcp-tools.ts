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

/**
 * Note the verb. This asks; it does not do. A template changes how *future*
 * agents are launched, on every machine, with nobody necessarily watching, so
 * a human confirms it before it exists. The tool returns as soon as the
 * proposal is put in front of them, and the answer arrives in your terminal.
 *
 * The name is about the mechanism, and the description has to make up for it.
 * The commonest case is not an agent volunteering a template - it is a human
 * saying "add a template", which an agent will otherwise read as a change to
 * Termscape's own source code and go looking for a checkout. So the
 * description leads with that, and says plainly that a Termscape template is
 * made here rather than in a repository.
 */
export const ProposeTemplateInput = z.object({
  id: z
    .string()
    .min(1)
    .max(60)
    .describe('Name for the template, as it will appear in the picker, e.g. "reviewer".'),
  agent: z
    .string()
    .min(1)
    .describe('Agent profile id it launches, e.g. "claude". Use list_agents to see what exists.'),
  description: z
    .string()
    .max(200)
    .optional()
    .describe('One line shown beside the name in the picker.'),
  model: z
    .string()
    .optional()
    .describe('Model to launch on. Refused if that agent takes no model on the command line.'),
  effort: z
    .string()
    .optional()
    .describe('Reasoning effort. Refused if that agent has no effort setting.'),
  prompt: z
    .string()
    .max(4000)
    .optional()
    .describe('First instruction, typed in once the agent is up.'),
});

export type WhoamiInput = z.infer<typeof WhoamiInput>;
export type ListAgentsInput = z.infer<typeof ListAgentsInput>;
export type SendMessageInput = z.infer<typeof SendMessageInput>;
export type SpawnAgentInput = z.infer<typeof SpawnAgentInput>;
export type ReadScreenInput = z.infer<typeof ReadScreenInput>;
export type SetStatusInput = z.infer<typeof SetStatusInput>;
export type StopAgentInput = z.infer<typeof StopAgentInput>;
export type ProposeTemplateInput = z.infer<typeof ProposeTemplateInput>;

/** Max bytes accepted in a single send_message body (mirrors the zod cap). */
export const MAX_MESSAGE_BYTES = 8000;
/** Per-sender delivery budget, enforced by the router. */
export const MESSAGE_RATE_LIMIT = { windowMs: 10_000, max: 20 } as const;
/**
 * How many proposals one agent may have waiting at once.
 *
 * Bounded for the reason send_message is: a confused agent must not be able to
 * bury the canvas in dialogs. Small, because a human answers these one at a
 * time and an agent with three unanswered questions does not need a fourth.
 */
export const MAX_PENDING_PROPOSALS = 3;
