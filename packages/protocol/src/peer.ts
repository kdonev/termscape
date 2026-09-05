import { z } from 'zod';
import { Session } from './domain.js';

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
 */

/**
 * Opens the link, in either direction.
 *
 * The dialer always sends this and always receives `welcome`; what flips
 * between the two attach models is only who dials. An SSH-deployed hub is
 * dialled by us and `enroll` is absent. A host that ran the join installer
 * dials us, and introduces itself here — we have never seen it before, so this
 * frame is the only place its identity can come from.
 */
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
  z.object({
    t: z.literal('startSession'),
    id: z.string(),
    workspaceName: z.string(),
    rootPath: z.string(),
    profile: z.string(),
    name: z.string().optional(),
    spawnedByAddress: z.string().nullable(),
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
  z.object({ t: z.literal('sessionUpserted'), session: Session }),
  z.object({ t: z.literal('sessionRemoved'), address: z.string() }),
  z.object({ t: z.literal('output'), address: z.string(), data: z.string() }),
]);
export type PeerResponse = z.infer<typeof PeerResponse>;

/**
 * Bumped whenever the peer protocol or the DB schema changes shape. Hubs
 * refuse to connect across a mismatch rather than corrupting each other.
 */
export const PEER_SCHEMA_VERSION = 4;
