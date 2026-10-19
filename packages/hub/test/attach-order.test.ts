import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket as WsClient } from 'ws';
import { BinaryFrameKind, decodeBinaryFrame, type ServerMsg } from '@termscape/protocol';
import { Hub } from '../src/hub.js';
import { serve } from '../src/server.js';
import { removeTree } from './tmp.js';

/**
 * What a browser is sent first when it attaches to a busy window.
 *
 * `TerminalView` leans on the answer. It writes the serialized screen only
 * while nothing else has been written yet, because a screen does not start by
 * clearing and would otherwise append a second copy of itself - so if output
 * could overtake the snapshot, a window attaching to a busy agent would come
 * up with no screen at all and keep none until the program next redrew.
 *
 * It cannot, and this says why it cannot: the hub adds the socket to the
 * attached set and sends the snapshot in one synchronous turn, and output
 * reaches only sockets already in that set. An `await` slipped in between
 * those two statements would break it quietly, which is what this is here to
 * catch.
 */

const CLIENT_TOKEN = 'canvas-token-for-attach-order';
const NOISY = 'noisy';

/**
 * A profile that does nothing but fill the screen, as fast as a pty allows.
 *
 * The script goes in a file rather than behind `node -e`: the command line
 * crosses a TOML string and then a pty, and the quoting did not survive both -
 * node reported a syntax error and the window filled with that instead.
 */
function declareNoisy(home: string): void {
  const script = join(home, 'noisy.mjs');
  // Numbered, so a later screen can be told from an earlier one.
  writeFileSync(
    script,
    'let n = 0;\nsetInterval(() => process.stdout.write("line " + ++n + "\\r\\n"), 2);\n',
  );
  writeFileSync(
    join(home, 'agents.toml'),
    [
      `[${NOISY}]`,
      `command = ${JSON.stringify(process.execPath)}`,
      `args = [${JSON.stringify(script)}]`,
      'mcp = false',
      'brief = "flag"',
      'inject = "raw"',
      '',
    ].join('\n'),
  );
}

let home: string;
let hub: Hub;
let app: FastifyInstance;
let origin: string;
let workspaceId: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'termscape-attach-order-'));
  process.env.TERMSCAPE_HOME = home;
  declareNoisy(home);
  hub = new Hub({ dbPath: join(home, 'state.db') });
  ({ app, origin } = await serve({ hub, port: 0, clientToken: CLIENT_TOKEN, headless: true }));
  workspaceId = hub.createWorkspace('attachws', home).id;
});

afterAll(async () => {
  hub.shutdown();
  await app.close();
  await removeTree(home);
  delete process.env.TERMSCAPE_HOME;
});

/** Connect and say hello, resolving once the hub says `ready`. */
function connect(): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const sock = new WsClient(`${origin.replace('http', 'ws')}/ws`);
    sock.on('open', () => sock.send(JSON.stringify({ t: 'hello', token: CLIENT_TOKEN })));
    sock.on('message', function onMsg(raw: Buffer, isBinary: boolean) {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === 'ready') {
        sock.off('message', onMsg);
        resolve(sock);
      } else if (msg.t === 'error') {
        sock.off('message', onMsg);
        sock.close();
        reject(new Error(msg.message));
      }
    });
    sock.on('error', reject);
  });
}

const waitFor = (fn: () => boolean, ms: number, label: string) =>
  new Promise<void>((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });

describe('attaching to a window that is already producing output', () => {
  it('is answered with the screen before any of that output', async () => {
    const session = await hub.startSession({ workspaceId, profile: NOISY, name: 'noisy' });

    // Wait until it has actually drawn something, so the snapshot under test
    // is a real screen and the stream is in full flow by the time we attach.
    await waitFor(
      () => (hub.sessions.snapshotForAttach(session.id)?.serialized.length ?? 0) > 100,
      15_000,
      'the window to draw something',
    );

    const sock = await connect();
    try {
      /** Every frame about this session, in the order it arrived. */
      const got: ('snapshot' | 'output')[] = [];
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) {
          const frame = decodeBinaryFrame(raw);
          if (frame?.kind === BinaryFrameKind.PtyOutput && frame.sessionId === session.id) {
            got.push('output');
          }
          return;
        }
        const msg = JSON.parse(raw.toString()) as ServerMsg;
        if (msg.t === 'snapshot' && msg.sessionId === session.id) got.push('snapshot');
      });

      sock.send(JSON.stringify({ t: 'attach', sessionId: session.id }));
      await waitFor(() => got.length >= 3, 15_000, 'frames for the attached window');

      // The whole point: not merely present, but first.
      expect(got[0]).toBe('snapshot');
      // And said once - a second screen would be a second copy on the terminal.
      expect(got.filter((g) => g === 'snapshot')).toHaveLength(1);
    } finally {
      sock.close();
      hub.sessions.stop(session.id);
    }
  }, 30_000);
});

/** The highest line number a screen mentions, or 0 for a screen with none. */
function drawnUpTo(serialized: string): number {
  const seen = [...serialized.matchAll(/line (\d+)/g)].map((m) => Number(m[1]));
  return seen.length > 0 ? Math.max(...seen) : 0;
}

/**
 * The screen a browser is handed when it comes back after losing its socket.
 *
 * The hub streams only to attached sockets, so everything the window drew
 * while the browser was away is missing from that browser's terminal and
 * cannot be recovered from the stream. What recovers it is the screen the
 * re-attach is answered with, which `TerminalView` applies over a reset. This
 * is the half of that the hub owns: the screen has to be current, not the one
 * the browser was already given before it went away.
 */
describe('re-attaching after the socket went away', () => {
  it('is answered with a screen that has what was drawn in between', async () => {
    const session = await hub.startSession({ workspaceId, profile: NOISY, name: 'reconnect' });
    await waitFor(
      () => drawnUpTo(hub.sessions.snapshotForAttach(session.id)?.serialized ?? '') > 0,
      15_000,
      'the window to draw something',
    );

    // A browser that attaches, is shown the window, and then loses its socket.
    const first = await connect();
    const seen: string[] = [];
    first.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (msg.t === 'snapshot' && msg.sessionId === session.id) seen.push(msg.serialized);
    });
    first.send(JSON.stringify({ t: 'attach', sessionId: session.id }));
    await waitFor(() => seen.length > 0, 15_000, 'the first screen');
    const before = drawnUpTo(seen[0]!);
    // So the comparison at the end is against a real screen, not an empty one.
    expect(before).toBeGreaterThan(0);
    first.close();

    try {
      // The window goes on working with nobody watching.
      await waitFor(
        () => drawnUpTo(hub.sessions.snapshotForAttach(session.id)?.serialized ?? '') > before + 10,
        15_000,
        'the window to draw on without a browser',
      );

      const again = await connect();
      try {
        const resync: string[] = [];
        again.on('message', (raw: Buffer, isBinary: boolean) => {
          if (isBinary) return;
          const msg = JSON.parse(raw.toString()) as ServerMsg;
          if (msg.t === 'snapshot' && msg.sessionId === session.id) resync.push(msg.serialized);
        });
        again.send(JSON.stringify({ t: 'attach', sessionId: session.id }));
        await waitFor(() => resync.length > 0, 15_000, 'the screen for the re-attach');

        // Current, not the screen this browser was given the first time.
        expect(drawnUpTo(resync[0]!)).toBeGreaterThan(before);
      } finally {
        again.close();
      }
    } finally {
      hub.sessions.stop(session.id);
    }
  }, 60_000);
});
