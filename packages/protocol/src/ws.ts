import { z } from 'zod';
import {
  Host,
  Message,
  Session,
  Viewport,
  Workspace,
  WindowRect,
  AgentProfileInfo,
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
  PtyInput: 0x02,
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

export const ClientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string() }),

  // terminal attach / detach drives the LOD swap on the canvas
  z.object({ t: z.literal('attach'), sessionId: z.string() }),
  z.object({ t: z.literal('detach'), sessionId: z.string() }),
  z.object({ t: z.literal('resize'), sessionId: z.string(), cols: z.number().int().positive(), rows: z.number().int().positive() }),

  // workspaces
  z.object({ t: z.literal('createWorkspace'), name: z.string().min(1), rootPath: z.string().min(1), hostId: z.string().nullable().optional() }),
  z.object({ t: z.literal('removeWorkspace'), workspaceId: z.string() }),

  // sessions
  z.object({
    t: z.literal('startSession'),
    workspaceId: z.string(),
    profile: z.string(),
    name: z.string().optional(),
    cwd: z.string().optional(),
  }),
  z.object({ t: z.literal('stopSession'), sessionId: z.string() }),
  z.object({ t: z.literal('removeSession'), sessionId: z.string() }),
  z.object({ t: z.literal('resumeSession'), sessionId: z.string() }),
  z.object({ t: z.literal('resumeWorkspace'), workspaceId: z.string() }),

  // canvas layout
  z.object({ t: z.literal('moveWindow'), sessionId: z.string(), rect: WindowRect }),
  z.object({ t: z.literal('setViewport'), viewport: Viewport }),

  // hosts
  z.object({
    t: z.literal('addHost'),
    label: z.string(),
    sshHost: z.string(),
    sshUser: z.string(),
    sshPort: z.number().int().positive().default(22),
    privateKeyPath: z.string().optional(),
  }),
  z.object({ t: z.literal('removeHost'), hostId: z.string() }),
  z.object({ t: z.literal('connectHost'), hostId: z.string() }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

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
  hosts: z.array(Host),
  workspaces: z.array(Workspace),
  sessions: z.array(Session),
  messages: z.array(Message),
  viewport: Viewport,
  profiles: z.array(AgentProfileInfo),
});
export type HubState = z.infer<typeof HubState>;

export const ServerMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ready'), state: HubState }),
  z.object({ t: z.literal('sessionUpserted'), session: Session }),
  z.object({ t: z.literal('sessionRemoved'), sessionId: z.string() }),
  z.object({ t: z.literal('workspaceUpserted'), workspace: Workspace }),
  z.object({ t: z.literal('workspaceRemoved'), workspaceId: z.string() }),
  z.object({ t: z.literal('hostUpserted'), host: Host }),
  z.object({ t: z.literal('hostRemoved'), hostId: z.string() }),
  // Deploy progress. A remote install rebuilds native modules and takes
  // minutes; without this the panel is a frozen button.
  z.object({ t: z.literal('hostLog'), hostId: z.string(), line: z.string() }),
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
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
