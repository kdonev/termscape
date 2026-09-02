import { z } from 'zod';
import { Session } from './domain.js';

/**
 * Hub-to-hub RPC, carried over the SSH tunnel.
 *
 * The local hub is the only thing that ever speaks this; agents never see it.
 * A remote agent messaging a local one calls send_message on its own hub,
 * which forwards here.
 */

export const PeerHello = z.object({
  t: z.literal('hello'),
  token: z.string(),
  hubVersion: z.string(),
  schemaVersion: z.number().int(),
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
export const PEER_SCHEMA_VERSION = 1;
