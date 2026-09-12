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

/**
 * How the link to a host was established. `ssh` hosts are deployed and dialled
 * by this hub; `enrolled` hosts ran the join installer and dialled in to us.
 * The peer protocol is identical either way — only who opens the socket differs.
 */
export const HostKind = z.enum(['ssh', 'enrolled']);
export type HostKind = z.infer<typeof HostKind>;

export const Host = z.object({
  id: z.string(),
  label: z.string(),
  kind: HostKind.default('ssh'),
  // Null for enrolled hosts: they reached us, so we hold no credentials
  // for reaching them.
  sshHost: z.string().nullable(),
  sshUser: z.string().nullable(),
  sshPort: z.number().int().positive().default(22),
  /** `linux-x64`, `darwin-arm64`, ... as reported by an enrolling host. */
  platform: z.string().nullable(),
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

/** The four preset paper colours a note can be. No custom colour picker. */
export const NoteColor = z.enum(['yellow', 'pink', 'green', 'blue']);
export type NoteColor = z.infer<typeof NoteColor>;

/**
 * A sticky note on the canvas.
 *
 * Free-floating: unlike a `Session`, it belongs to no workspace and is never
 * sent to a peer hub - it is a canvas object, like the viewport, not a piece
 * of an agent's world. The client mints `id` with `crypto.randomUUID()` on
 * creation, so a note never needs the hub's permission to exist.
 */
export const Note = z.object({
  id: z.string(),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number(),
  /** Plain text, no formatting. Bounded so a pasted essay cannot bloat the db. */
  text: z.string().max(20_000),
  color: NoteColor,
  updatedAt: z.number(),
});
export type Note = z.infer<typeof Note>;

export const Session = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** Unique within the workspace; `workspace/name` is the routable address. */
  name: z.string(),
  address: z.string(),
  profile: z.string(),
  /**
   * The template this session was started from, and what it resolved to.
   *
   * Recorded here rather than looked up at resume time. Resume deliberately
   * rebuilds argv instead of replaying it, so without these the model and
   * effort are quietly lost the first time a machine restarts — and an agent
   * coming back on a different model than it left with is worse than one that
   * does not come back. A template is editable, too: the answer belongs to
   * the session that used it.
   *
   * The opening instruction is deliberately absent. It is how the session
   * started, not what it is, and it must not repeat on resume.
   */
  template: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
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

/**
 * Where a model list came from, because the two are not equally trustworthy.
 *
 * `listed` was enumerated by the CLI itself and is complete. `declared` is a
 * static list written into the profile for a CLI with no listing command, so
 * it is a starting point rather than the whole truth - Claude Code accepts a
 * full model name as readily as one of the three aliases it documents.
 */
export const ModelSource = z.enum(['listed', 'declared', 'none']);
export type ModelSource = z.infer<typeof ModelSource>;

/**
 * A template as the picker sees it: an agent, and what it has already decided.
 *
 * The picker offers these rather than CLIs. One that names only an agent is
 * exactly the old behaviour, which is why every agent gets one for free.
 */
/**
 * Where a template came from, which is what decides whether it can be edited.
 *
 * `derived` is the free one every agent gets under its own name; `stored` was
 * made from the panel; `file` was declared in `~/.termscape/agents.toml` and
 * is read-only, because the hub does not write that file.
 */
export const TemplateSource = z.enum(['derived', 'stored', 'file']);
export type TemplateSource = z.infer<typeof TemplateSource>;

export const AgentTemplateInfo = z.object({
  id: z.string(),
  description: z.string(),
  /** The agent (profile) id it launches. */
  agent: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  prompt: z.string().nullable(),
  /**
   * Extra environment for the agent process, on top of what its profile sets.
   *
   * The one thing a template could not say. Two agents differing only in an
   * API key, a proxy, or a feature flag were two entries in agents.toml with
   * no way to express the difference, so the difference lived in whatever
   * shell the hub happened to be started from — which is not a per-template
   * answer at all. Empty for a template that sets none.
   */
  env: z.record(z.string(), z.string()),
  /**
   * Why it cannot be used. A template asking for an effort on an agent with
   * no effort setting is a configuration error, and it stays in the list
   * saying so rather than vanishing as if the config had been ignored.
   */
  error: z.string().nullable(),
  source: TemplateSource,
});
export type AgentTemplateInfo = z.infer<typeof AgentTemplateInfo>;

/**
 * A template an agent has asked for and a human has not yet answered.
 *
 * Live rather than durable: it is held in memory and dies with the hub, which
 * is right because the agent waiting on the answer dies with the hub too. A
 * proposal that outlived both would be a dialog about a template nobody can be
 * told the outcome of.
 */
export const TemplateProposal = z.object({
  /** The proposal, not the template. */
  id: z.string(),
  /** Which agent is asking. Nobody can judge "an agent wants a template". */
  fromAddr: z.string(),
  proposedAt: z.number(),
  template: z.object({
    id: z.string(),
    agent: z.string(),
    description: z.string().nullable(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    prompt: z.string().nullable(),
  }),
});
export type TemplateProposal = z.infer<typeof TemplateProposal>;

export const AgentProfileInfo = z.object({
  id: z.string(),
  description: z.string(),
  /** false for plain terminals like the `shell` profile. */
  mcp: z.boolean(),
  resumable: z.boolean(),
  /** The command looked for on PATH. Shown when it was not found. */
  command: z.string(),
  /** Where it was found, or null when it was not. */
  commandPath: z.string().nullable(),
  /**
   * null means "not probed yet", which is a real state and not a failure:
   * detection runs after the hub is already serving, so the first page load
   * can arrive before any of it has answered.
   */
  available: z.boolean().nullable(),
  /** Whatever the CLI printed for its version, verbatim. */
  version: z.string().nullable(),
  /** Why it is unavailable, when it is. */
  detail: z.string().nullable(),
  models: z.array(z.string()),
  modelSource: ModelSource,
  /**
   * Whether this agent declares how to spell a model, or an effort, on the
   * command line. A template holds a *value*; the agent says how to write it
   * down, and one that says nothing takes neither — so the dialog offers the
   * field only where there is somewhere for the value to go.
   */
  takesModel: z.boolean(),
  takesEffort: z.boolean(),
  /** The effort levels this agent documents, when it takes one. */
  efforts: z.array(z.string()),
});
export type AgentProfileInfo = z.infer<typeof AgentProfileInfo>;

export const HostWorkspaceInfo = z.object({
  name: z.string(),
  /** Null for a workspace only seen through a running agent's address: the
   *  canvas holds no row for it and cannot spawn into it. */
  rootPath: z.string().nullable(),
  agents: z.number().int(),
});
export type HostWorkspaceInfo = z.infer<typeof HostWorkspaceInfo>;

/**
 * A machine on the canvas, as `list_hosts` reports it: enough to pick one by
 * name, know whether it can be reached, and see what it could run something
 * with.
 */
export const HostInfo = z.object({
  /** '' for the canvas-owning machine, which has no host row. */
  id: z.string(),
  label: z.string(),
  kind: z.enum(['canvas', 'ssh', 'enrolled']),
  state: z.enum(['disconnected', 'connecting', 'connected', 'error']),
  /** True for the machine the *calling* agent is running on. */
  you: z.boolean(),
  platform: z.string().nullable(),
  error: z.string().nullable(),
  workspaces: z.array(HostWorkspaceInfo),
  /**
   * The agent CLIs that machine has, as it last reported them. An empty list
   * means "no `agents` frame yet", never "has none" — see resolution rule 5
   * in spawn_agent's `host` handling, which is the only place this is acted
   * on and where the invariant is spelled out.
   */
  agents: z.array(
    z.object({
      id: z.string(),
      available: z.boolean().nullable(),
      version: z.string().nullable(),
      detail: z.string().nullable(),
    }),
  ),
});
export type HostInfo = z.infer<typeof HostInfo>;
