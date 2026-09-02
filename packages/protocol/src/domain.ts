import { z } from 'zod';

/** Lifecycle of a PTY-backed session. `stopped` means restored-from-DB but not running. */
export const SessionState = z.enum([
  'starting',
  'running',
  'stopped',
  'exited',
  'failed',
]);
export type SessionState = z.infer<typeof SessionState>;

/** Coarse activity signal shown as a chip on the canvas window. */
export const AgentStatus = z.enum(['idle', 'busy', 'unknown']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const WorkspaceKind = z.enum(['local', 'remote']);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

export const Host = z.object({
  id: z.string(),
  label: z.string(),
  sshHost: z.string(),
  sshUser: z.string(),
  sshPort: z.number().int().positive().default(22),
  hubVersion: z.string().nullable(),
  state: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  lastSeenAt: z.number().nullable(),
  error: z.string().nullable(),
});
export type Host = z.infer<typeof Host>;

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  kind: WorkspaceKind,
  rootPath: z.string(),
  hostId: z.string().nullable(),
  color: z.string(),
  createdAt: z.number(),
  archivedAt: z.number().nullable(),
});
export type Workspace = z.infer<typeof Workspace>;

export const WindowRect = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number(),
  collapsed: z.boolean(),
});
export type WindowRect = z.infer<typeof WindowRect>;

export const Viewport = z.object({
  panX: z.number(),
  panY: z.number(),
  zoom: z.number(),
});
export type Viewport = z.infer<typeof Viewport>;

export const Session = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** Unique within the workspace; `workspace/name` is the routable address. */
  name: z.string(),
  address: z.string(),
  profile: z.string(),
  cwd: z.string(),
  /** The agent CLI's own conversation id (Claude Code `--session-id`). */
  agentSessionUuid: z.string().nullable(),
  /** Parent session that called spawn_agent, for lineage edges. */
  spawnedBy: z.string().nullable(),
  state: SessionState,
  status: AgentStatus,
  /** Free-text label the agent sets via the set_status tool. */
  statusText: z.string().nullable(),
  title: z.string().nullable(),
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  cols: z.number(),
  rows: z.number(),
  /** True when the profile supports being brought back with --resume. */
  resumable: z.boolean(),
  createdAt: z.number(),
  exitedAt: z.number().nullable(),
  lastActiveAt: z.number(),
  window: WindowRect,
});
export type Session = z.infer<typeof Session>;

export const DeliveryState = z.enum(['delivered', 'failed']);
export type DeliveryState = z.infer<typeof DeliveryState>;

export const Message = z.object({
  id: z.string(),
  fromAddr: z.string(),
  toAddr: z.string(),
  body: z.string(),
  sentAt: z.number(),
  deliveredAt: z.number().nullable(),
  deliveryState: DeliveryState,
  error: z.string().nullable(),
});
export type Message = z.infer<typeof Message>;

export const AgentProfileInfo = z.object({
  id: z.string(),
  description: z.string(),
  /** false for plain terminals like the `shell` profile. */
  mcp: z.boolean(),
  resumable: z.boolean(),
});
export type AgentProfileInfo = z.infer<typeof AgentProfileInfo>;
