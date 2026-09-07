import { z } from 'zod';
import { AgentProfileInfo, AgentStatus, Session, SessionState } from './domain.js';

/**
 * Hub-to-hub RPC.
 *
 * The local hub is the only thing that ever speaks this; agents never see it.
 * A remote agent messaging a local one calls send_message on its own hub,
 * which forwards here.
 *
 * Two things are asymmetric about the link and they are independent: which
 * side opens the socket, and which side issues requests. The hub that owns the
 * canvas always issues requests. It dials an SSH-deployed host through the
 * tunnel, and is dialled by a host that ran the join installer. The frames
 * below are the same in both cases.
 *
 * Knowledge, though, has to travel both ways, or an agent on an attached
 * machine cannot see or reach the agents on the canvas machine. Two frames
 * carry it without disturbing who asks whom: `directory` is the canvas telling
 * a host who else is on the canvas, and `relay` is a host asking the canvas to
 * act on an address it cannot resolve itself — because only the canvas knows
 * where every address on it lives.
 */

/** One agent as another hub needs to see it: enough to list and address it. */
export const PeerAgent = z.object({
  address: z.string(),
  workspace: z.string().nullable(),
  profile: z.string(),
  state: SessionState,
  status: AgentStatus,
  statusText: z.string().nullable(),
  /** Label of the machine it runs on, as the canvas knows that machine. */
  host: z.string(),
});
export type PeerAgent = z.infer<typeof PeerAgent>;

/**
 * Opens the link, in either direction.
 *
 * The dialer always sends this and always receives `welcome`; what flips
 * between the two attach models is only who dials. An SSH-deployed hub is
 * dialled by us and `enroll` is absent. A host that ran the join installer
 * dials us, and introduces itself here — we have never seen it before, so this
 * frame is the only place its identity can come from.
 */
/**
 * What an attached hub asks its canvas to do for it.
 *
 * Everything here is something it could do unaided for its own agents and
 * cannot do for anyone else's: the address belongs to a machine it has no link
 * to. The canvas resolves the address and performs it, wherever that lands.
 */
export const PeerRelayAsk = z.discriminatedUnion('t', [
  // `from` was authenticated by the asking hub from the sender's own bearer
  // token, exactly as `deliver` is trusted in the other direction.
  z.object({
    t: z.literal('deliver'),
    from: z.string(),
    to: z.string(),
    body: z.string(),
  }),
  z.object({
    t: z.literal('readScreen'),
    address: z.string(),
    lines: z.number().int().positive().optional(),
  }),
]);
export type PeerRelayAsk = z.infer<typeof PeerRelayAsk>;

export const PeerHello = z.object({
  t: z.literal('hello'),
  /**
   * For an SSH host, the token we minted for the deploy. For an enrolling
   * host, its single-use enrollment token on the first connection and its
   * durable host token on every one after.
   */
  token: z.string(),
  hubVersion: z.string(),
  schemaVersion: z.number().int(),
  enroll: z
    .object({
      label: z.string(),
      platform: z.string(),
      arch: z.string(),
      homeDir: z.string(),
    })
    .optional(),
});

export const PeerRequest = z.discriminatedUnion('t', [
  PeerHello,
  z.object({ t: z.literal('listSessions'), id: z.string() }),
  /**
   * What agent CLIs that machine has. Asked rather than assumed: a host has
   * its own PATH, and starting an agent over there sends a profile id which
   * it resolves against its own config - so an agent it does not have fails
   * at launch with a spawn error the canvas could have predicted.
   */
  z.object({ t: z.literal('listAgents'), id: z.string() }),
  z.object({
    t: z.literal('startSession'),
    id: z.string(),
    workspaceName: z.string(),
    rootPath: z.string(),
    /** The *agent* id, resolved from the template before it crossed. */
    profile: z.string(),
    /**
     * Resolved values rather than a template id.
     *
     * A template is config, and the two machines do not share config: a name
     * that means "opus, high effort" here may mean nothing over there, or
     * something else. Resolving before the request crosses is the smaller
     * change and the only one that works when the two disagree. The template
     * id travels only so the window can say which one was picked.
     */
    template: z.string().nullable().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    prompt: z.string().optional(),
    name: z.string().optional(),
    spawnedByAddress: z.string().nullable(),
    /**
     * The id the canvas has already chosen for the child.
     *
     * The child's first upsert crosses before the start request's reply does,
     * and the canvas keeps the lineage — who spawned this — keyed on this id,
     * so it can stamp that first upsert no matter what the child ends up
     * being called. Without it the canvas could only guess the address from a
     * name that may not even have been given.
     */
    sessionId: z.string().optional(),
  }),
  z.object({ t: z.literal('stopSession'), id: z.string(), address: z.string() }),
  // Closing a window has to reach the hub that owns the PTY. Handled locally
  // it would only hide the session until that peer's next resync, which is
  // exactly what a restart triggers. Idempotent on purpose: a removal deferred
  // while the host was down may replay one that already went through.
  z.object({ t: z.literal('removeSession'), id: z.string(), address: z.string() }),
  // Sent when the canvas drops this host: the hub over there is a daemon we
  // asked someone to start, so removing it here has to stop it there too,
  // otherwise it lingers holding its files open and its next install fails.
  z.object({ t: z.literal('shutdown'), id: z.string() }),
  z.object({ t: z.literal('resumeSession'), id: z.string(), address: z.string() }),
  // The canvas telling a host who else is on it. Sent whenever that set
  // changes, and it is the whole set minus the receiving host's own agents,
  // which it already knows about and would otherwise list twice.
  z.object({ t: z.literal('directory'), id: z.string(), agents: z.array(PeerAgent) }),
  // The answer to a `relay`, matched by the id the host chose for it. A
  // separate frame rather than an `ok`, because the two ends do not share a
  // request channel: the canvas asks, the host answers, and this is the canvas
  // answering something the host asked.
  z.object({
    t: z.literal('relayResult'),
    id: z.string(),
    relayId: z.string(),
    ok: z.boolean(),
    result: z.unknown(),
    error: z.string().nullable(),
  }),
  // The forwarded delivery: `from` is the *originating agent's* address, which
  // the sending hub already authenticated. A peer is trusted to report it.
  z.object({
    t: z.literal('deliver'),
    id: z.string(),
    from: z.string(),
    to: z.string(),
    body: z.string(),
  }),
  z.object({
    t: z.literal('readScreen'),
    id: z.string(),
    address: z.string(),
    lines: z.number().int().positive().optional(),
  }),
  z.object({ t: z.literal('attach'), id: z.string(), address: z.string() }),
  z.object({ t: z.literal('detach'), id: z.string(), address: z.string() }),
  z.object({
    t: z.literal('input'),
    id: z.string(),
    address: z.string(),
    data: z.string(),
  }),
  z.object({
    t: z.literal('resize'),
    id: z.string(),
    address: z.string(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
]);
export type PeerRequest = z.infer<typeof PeerRequest>;

export const PeerResponse = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    hubVersion: z.string(),
    schemaVersion: z.number().int(),
    /**
     * Issued once, in reply to a hello carrying an enrollment token. The
     * enrolling host stores it and presents it on every later connection, so a
     * reboot rejoins without another trip to the download page.
     */
    hostToken: z.string().optional(),
  }),
  z.object({ t: z.literal('ok'), id: z.string(), result: z.unknown() }),
  z.object({ t: z.literal('err'), id: z.string(), message: z.string() }),
  // Unsolicited: the peer pushing state changes and terminal output.
  z.object({ t: z.literal('sessions'), sessions: z.array(Session) }),
  // Unsolicited as well as in reply: that machine's detection finishes after
  // it connects, and again whenever it is refreshed over there.
  z.object({ t: z.literal('agents'), agents: z.array(AgentProfileInfo) }),
  z.object({ t: z.literal('sessionUpserted'), session: Session }),
  z.object({ t: z.literal('sessionRemoved'), address: z.string() }),
  z.object({ t: z.literal('output'), address: z.string(), data: z.string() }),
  // A host asking the canvas to act on an address it cannot resolve itself.
  // Its own agents it handles directly; anything else it can only reach
  // through the hub that knows where addresses live.
  z.object({ t: z.literal('relay'), relayId: z.string(), ask: PeerRelayAsk }),
]);
export type PeerResponse = z.infer<typeof PeerResponse>;

/**
 * Bumped whenever the peer protocol or the DB schema changes shape. Hubs
 * refuse to connect across a mismatch rather than corrupting each other.
 */
export const PEER_SCHEMA_VERSION = 5;
