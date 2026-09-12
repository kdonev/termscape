import { z } from 'zod';
import {
  Host,
  Message,
  Session,
  Viewport,
  Workspace,
  WindowRect,
  AgentProfileInfo,
  AgentTemplateInfo,
  TemplateProposal,
} from './domain.js';

/* ------------------------------------------------------------------ *
 * Binary framing for PTY traffic.
 *
 * Control messages are JSON text frames; terminal bytes ride in binary
 * frames so we never base64 the hot path. Layout:
 *   [0]      frame kind
 *   [1]      session id length (utf8 bytes, <= 255)
 *   [2..n]   session id
 *   [n..]    raw payload
 * ------------------------------------------------------------------ */

export const BinaryFrameKind = {
  PtyOutput: 0x01,
  /** Payload is UTF-8 text: keystrokes, pastes, escape sequences. */
  PtyInput: 0x02,
  /**
   * Payload is exact bytes, written to the PTY unchanged.
   *
   * Mouse reports in the default (X10) encoding are the reason this exists.
   * They spell a coordinate as `32 + n`, so anything past column or row 95 is
   * a byte above 0x7f - and a byte above 0x7f is not UTF-8 text. Sent as
   * `PtyInput` it was re-encoded on the way through and arrived at the program
   * as two bytes instead of one, which is how moving the mouse over a wide
   * terminal typed garbage into it. Nothing on this path may decode it.
   */
  PtyInputRaw: 0x03,
} as const;
export type BinaryFrameKind =
  (typeof BinaryFrameKind)[keyof typeof BinaryFrameKind];

export function encodeBinaryFrame(
  kind: BinaryFrameKind,
  sessionId: string,
  payload: Uint8Array,
): Uint8Array {
  const id = new TextEncoder().encode(sessionId);
  if (id.length > 255) throw new Error('session id too long for binary frame');
  const out = new Uint8Array(2 + id.length + payload.length);
  out[0] = kind;
  out[1] = id.length;
  out.set(id, 2);
  out.set(payload, 2 + id.length);
  return out;
}

export interface DecodedBinaryFrame {
  kind: number;
  sessionId: string;
  payload: Uint8Array;
}

export function decodeBinaryFrame(buf: Uint8Array): DecodedBinaryFrame {
  if (buf.length < 2) throw new Error('binary frame too short');
  const kind = buf[0]!;
  const idLen = buf[1]!;
  if (buf.length < 2 + idLen) throw new Error('binary frame truncated');
  const sessionId = new TextDecoder().decode(buf.subarray(2, 2 + idLen));
  return { kind, sessionId, payload: buf.subarray(2 + idLen) };
}

/* ------------------------------------------------------------------ *
 * Control messages
 * ------------------------------------------------------------------ */

/**
 * Correlates one mutation with its answer.
 *
 * A form that fires and forgets can only report failure as a toast in the
 * corner, arriving after it has closed and next to nothing that explains it.
 * A dialog carries a requestId, and the hub answers that id with an `ack`
 * whether it worked or not — so the dialog can stay open, put the message
 * beside the field that caused it, and close only on success.
 */
const requestId = z.string().optional();

export const ClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string() }),

  // terminal attach / detach drives the LOD swap on the canvas
  z.object({ t: z.literal('attach'), sessionId: z.string() }),
  z.object({ t: z.literal('detach'), sessionId: z.string() }),
  z.object({ t: z.literal('resize'), sessionId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }),

  // workspaces
  /**
   * Whether a folder makes sense on the machine a workspace would live on,
   * asked before that workspace is created. `hostId` absent or null means
   * this machine; either way the answer comes from `Hub.checkHostFolder`,
   * which resolves and stats the path on whichever machine actually owns it
   * instead of this hub's own process guessing in its own platform's
   * flavour. A failure here is the dialog's only signal — there is no
   * separate success payload, since the dialog already knows the path it
   * asked about.
   */
  z.object({
    t: z.literal('checkFolder'),
    requestId,
    hostId: z.string().nullable().optional(),
    path: z.string().min(1),
  }),
  z.object({ t: z.literal('createWorkspace'), requestId, name: z.string().min(1), rootPath: z.string().min(1), hostId: z.string().nullable().optional() }),
  /**
   * Rename a workspace or repoint it at another folder. Both are optional and
   * only what is given changes, so the dialog sends the whole form and the hub
   * decides what actually moved.
   */
  z.object({
    t: z.literal('updateWorkspace'),
    requestId,
    workspaceId: z.string(),
    name: z.string().min(1).optional(),
    rootPath: z.string().min(1).optional(),
  }),
  z.object({ t: z.literal('removeWorkspace'), requestId, workspaceId: z.string() }),

  // templates
  /**
   * Make a template, or edit one.
   *
   * One message for both, because a template is identified by the name a
   * person picked and there is no separate id to rename around: saving the
   * dialog means "let `id` be this". The hub refuses an id `agents.toml` has
   * claimed rather than shadowing it, and refuses a model or an effort the
   * named agent cannot spell - the same rule the loader applies, so the
   * dialog gets the refusal instead of the list quietly gaining a broken row.
   *
   * The whole form is sent every time. A template is four fields, and a patch
   * API would only make clearing a model harder to say than setting one.
   */
  z.object({
    t: z.literal('saveTemplate'),
    requestId,
    id: z.string().min(1),
    agent: z.string().min(1),
    description: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    /** Extra environment for the agent process. Absent means "leave as is". */
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ t: z.literal('removeTemplate'), requestId, id: z.string() }),
  /**
   * Answer an agent's proposal.
   *
   * The fields ride along because this is a proposal rather than a yes/no
   * question: the likeliest outcome is a human who keeps the idea and changes
   * the name or the model, so what is accepted is what the dialog shows, not
   * what the agent asked for. Omitted on a rejection.
   */
  z.object({
    t: z.literal('resolveTemplateProposal'),
    requestId,
    proposalId: z.string(),
    accept: z.boolean(),
    id: z.string().min(1).optional(),
    agent: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    /**
     * Only ever the human's own. A proposal carries no environment: an agent
     * that could name variables for every future launch of a template would
     * be choosing what the next agent's credentials are, which is not a thing
     * to ask a human to review one dialog at a time.
     */
    env: z.record(z.string(), z.string()).optional(),
  }),

  // sessions
  z.object({
    t: z.literal('startSession'),
    requestId,
    workspaceId: z.string(),
    /**
     * A template id. Still called `profile` on the wire, and still resolved
     * as a profile id when no template has that name, so a client from before
     * templates existed keeps working — every agent has a bare template under
     * its own name, so the two agree for all the old values.
     */
    profile: z.string(),
    /** Overrides for what the template already decided, from the dialog. */
    model: z.string().optional(),
    effort: z.string().optional(),
    prompt: z.string().optional(),
    name: z.string().optional(),
    cwd: z.string().optional(),
  }),
  z.object({ t: z.literal('stopSession'), sessionId: z.string() }),
  z.object({ t: z.literal('removeSession'), requestId, sessionId: z.string() }),
  z.object({ t: z.literal('resumeSession'), sessionId: z.string() }),
  z.object({ t: z.literal('resumeWorkspace'), workspaceId: z.string() }),

  /**
   * Grant or revoke a link that opens one session, and nothing else, in
   * another browser. Minted lazily: sharing a session that already has a
   * token returns the same one rather than invalidating whatever tab already
   * holds it.
   */
  z.object({ t: z.literal('shareSession'), requestId, sessionId: z.string() }),
  /**
   * Revoking closes every socket already scoped to the token, not merely
   * the row that let it in - an open reviewer tab is the one case revocation
   * exists for, and "revoked" would otherwise be untrue for it.
   */
  z.object({ t: z.literal('unshareSession'), requestId, sessionId: z.string() }),

  // canvas layout
  z.object({ t: z.literal('moveWindow'), sessionId: z.string(), rect: WindowRect }),
  z.object({ t: z.literal('setViewport'), viewport: Viewport }),

  // hosts
  z.object({
    t: z.literal('addHost'),
    requestId,
    label: z.string(),
    sshHost: z.string(),
    sshUser: z.string(),
    sshPort: z.number().int().positive().default(22),
    privateKeyPath: z.string().optional(),
  }),
  /**
   * Fix a host's details after the fact. An enrolled host has no ssh fields to
   * correct - it dialled us - so for one of those only the label applies, and
   * the hub refuses the rest rather than storing details nothing will read.
   */
  z.object({
    t: z.literal('updateHost'),
    requestId,
    hostId: z.string(),
    label: z.string().optional(),
    sshHost: z.string().optional(),
    sshUser: z.string().optional(),
    sshPort: z.number().int().positive().optional(),
    /** Empty string clears it back to using the ssh agent. */
    privateKeyPath: z.string().optional(),
  }),
  z.object({ t: z.literal('removeHost'), requestId, hostId: z.string() }),
  z.object({ t: z.literal('connectHost'), hostId: z.string() }),

  /** Re-probe what is installed, here and on every attached machine. */
  z.object({ t: z.literal('refreshAgents') }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

/**
 * The mutations a dialog drives, plus `checkFolder` — a pre-flight question
 * rather than a mutation, but a dialog awaits it exactly the same way, so it
 * belongs in the same list rather than a second one.
 *
 * Listed by name rather than derived from the presence of `requestId`,
 * because every message is structurally assignable to "might have a
 * requestId" and the derived version would quietly include all of them.
 */
export type AckableMsg = Extract<
  ClientMsg,
  {
    t:
      | 'checkFolder'
      | 'createWorkspace'
      | 'updateWorkspace'
      | 'removeWorkspace'
      | 'saveTemplate'
      | 'removeTemplate'
      | 'resolveTemplateProposal'
      | 'startSession'
      | 'removeSession'
      | 'addHost'
      | 'updateHost'
      | 'removeHost'
      | 'shareSession'
      | 'unshareSession';
  }
>;

/** A share link, as the wire carries it: the token, not a finished URL. */
export const ShareInfo = z.object({ sessionId: z.string(), token: z.string() });
export type ShareInfo = z.infer<typeof ShareInfo>;

export const HubState = z.object({
  hubVersion: z.string(),
  /**
   * Where another machine can reach this hub's join page, or null when the
   * hub is bound to loopback and nothing else can see it.
   */
  enrollUrl: z.string().nullable(),
  /**
   * The same page by IP, when the primary uses this machine's name. A name
   * only resolves if the other machine's network can resolve it, so the
   * numeric form is always offered rather than assumed unnecessary.
   */
  enrollAltUrl: z.string().nullable(),
  /**
   * Where another machine can reach this hub at all, or null when it is
   * bound to loopback. `serve()` already computes this for the join page,
   * but a share link needs the reachable origin whether or not enrollment is
   * on - it is a different grant with a different audience.
   */
  lanOrigin: z.string().nullable(),
  /** The same origin by IP, when `lanOrigin` uses this machine's name. */
  lanAltOrigin: z.string().nullable(),
  hosts: z.array(Host),
  workspaces: z.array(Workspace),
  sessions: z.array(Session),
  messages: z.array(Message),
  viewport: Viewport,
  /** What this machine has. */
  profiles: z.array(AgentProfileInfo),
  /** What the picker offers: agents plus the models and efforts already chosen. */
  templates: z.array(AgentTemplateInfo),
  /**
   * Proposals waiting on a human. Sent with the rest of the state because a
   * browser that was closed when one arrived would otherwise never see it, and
   * the agent that asked is still waiting.
   */
  templateProposals: z.array(TemplateProposal),
  /**
   * What each attached machine has, by host id. Separate from `profiles`
   * because the answer is per machine: a host has its own PATH, and the
   * picker for a workspace over there has to offer that machine's agents
   * rather than this one's.
   */
  hostProfiles: z.record(z.string(), z.array(AgentProfileInfo)),
  /**
   * Which sessions are shared. Empty on a socket scoped to a share token: a
   * reviewer holding one link has no business learning that others exist.
   */
  shares: z.array(ShareInfo),
});
export type HubState = z.infer<typeof HubState>;

export const ServerMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), state: HubState }),
  z.object({ t: z.literal('sessionUpserted'), session: Session }),
  z.object({ t: z.literal('sessionRemoved'), sessionId: z.string() }),
  z.object({ t: z.literal('workspaceUpserted'), workspace: Workspace }),
  /**
   * The whole list, not one row.
   *
   * A per-row upsert cannot say what actually happens here: removing a stored
   * template that shadowed a bare one does not remove a row, it reveals the
   * derived one underneath, and adding one to `agents.toml` changes an
   * existing row's source. The list is a handful of small records and is
   * recomputed anyway, so sending it whole is both simpler and the only shape
   * that can express the result.
   */
  z.object({ t: z.literal('templatesChanged'), templates: z.array(AgentTemplateInfo) }),
  z.object({ t: z.literal('templateProposed'), proposal: TemplateProposal }),
  z.object({ t: z.literal('templateProposalResolved'), proposalId: z.string() }),
  z.object({ t: z.literal('workspaceRemoved'), workspaceId: z.string() }),
  z.object({ t: z.literal('hostUpserted'), host: Host }),
  z.object({ t: z.literal('hostRemoved'), hostId: z.string() }),
  /** The whole list, for the same reason `templatesChanged` sends its whole list. */
  z.object({ t: z.literal('sharesChanged'), shares: z.array(ShareInfo) }),
  // Deploy progress. A remote install rebuilds native modules and takes
  // minutes; without this the panel is a frozen button.
  z.object({ t: z.literal('hostLog'), hostId: z.string(), line: z.string() }),
  /**
   * Detection finishing, here or on a peer. It runs after the hub is already
   * serving - never before, so it can never hold up a page load - which means
   * the first `ready` usually arrives with nothing probed yet and this is what
   * fills the picker in.
   */
  z.object({
    t: z.literal('agentsDetected'),
    /** null for this machine. */
    hostId: z.string().nullable(),
    profiles: z.array(AgentProfileInfo),
  }),
  z.object({ t: z.literal('messageSent'), message: Message }),
  // sent on attach: serialized screen, replayed before the live stream
  z.object({
    t: z.literal('snapshot'),
    sessionId: z.string(),
    serialized: z.string(),
    cols: z.number(),
    rows: z.number(),
  }),
  z.object({ t: z.literal('error'), message: z.string(), sessionId: z.string().optional() }),
  /**
   * The answer to a mutation that carried a requestId. A failure arrives here
   * and *not* as an `error`, so it lands in the dialog that asked rather than
   * in the corner of the screen.
   */
  z.object({
    t: z.literal('ack'),
    requestId: z.string(),
    ok: z.boolean(),
    message: z.string().optional(),
    /**
     * What the mutation created, when it created anything: the dialog that
     * started an agent wants to focus the window it just brought into being,
     * and the broadcast alone does not tell it which session was its own.
     */
    sessionId: z.string().optional(),
  }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
