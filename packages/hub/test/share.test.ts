import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket as WsClient } from 'ws';
import {
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type ServerMsg,
} from '@termscape/protocol';
import { Hub } from '../src/hub.js';
import { serve } from '../src/server.js';
import { removeTree } from './tmp.js';

/*
 * Issue 14: a WebSocket can be scoped to a single session. `/ws` already
 * authenticates with `hello{token}`; a share token is the second accepted
 * family, and the session id it resolves to becomes the socket's scope -
 * consulted in four places: the filtered `ready`, the broadcast filter, the
 * binary-input gate, and the dispatch allowlist. Each gets its own test here,
 * plus revocation and persistence across a restart.
 */

let home: string;
let hub: Hub;
let app: FastifyInstance;
let origin: string;
let workspaceId: string;

const CLIENT_TOKEN = 'canvas-token-for-share-tests';

function waitFor(fn: () => boolean, ms = 10_000, label = 'condition'): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

interface Connected {
  sock: WsClient;
  ready: Extract<ServerMsg, { t: 'ready' }>;
  /** Everything received after `ready`, for asserting what a scope withheld. */
  messages: ServerMsg[];
}

/** Connect a raw browser socket, say hello with `token`, and wait for the answer. */
function connect(token: string): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const sock = new WsClient(`${origin.replace('http', 'ws')}/ws`);
    const messages: ServerMsg[] = [];
    let settled = false;
    sock.on('open', () => sock.send(JSON.stringify({ t: 'hello', token })));
    sock.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      if (settled) {
        messages.push(msg);
        return;
      }
      if (msg.t === 'ready') {
        settled = true;
        resolve({ sock, ready: msg, messages });
      } else if (msg.t === 'error') {
        settled = true;
        sock.close();
        reject(new Error(msg.message));
      }
    });
    sock.on('error', reject);
  });
}

/** Send an ackable mutation on an already-connected socket and await its ack. */
function request(sock: WsClient, msg: Record<string, unknown>): Promise<{ sessionId?: string }> {
  const requestId = `t${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const onMsg = (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = JSON.parse(raw.toString());
      if (parsed.t !== 'ack' || parsed.requestId !== requestId) return;
      sock.off('message', onMsg);
      if (parsed.ok) resolve({ sessionId: parsed.sessionId });
      else reject(new Error(parsed.message ?? 'refused'));
    };
    sock.on('message', onMsg);
    sock.send(JSON.stringify({ ...msg, requestId }));
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'termscape-share-'));
  process.env.TERMSCAPE_HOME = home;
  hub = new Hub({ dbPath: join(home, 'state.db') });
  ({ app, origin } = await serve({ hub, port: 0, clientToken: CLIENT_TOKEN, headless: true }));
  workspaceId = hub.createWorkspace('sharews', home).id;
});

afterAll(async () => {
  hub.shutdown();
  await app.close();
  removeTree(home);
  delete process.env.TERMSCAPE_HOME;
});

describe('a share-scoped socket', () => {
  it('gets a ready that carries only its own session and workspace', async () => {
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'reviewed' });
    const other = await hub.startSession({ workspaceId, profile: 'shell', name: 'onlooker' });
    const token = hub.shareSession(shared.id);

    const conn = await connect(token);
    try {
      const state = conn.ready.state;
      expect(state.sessions.map((s) => s.id)).toEqual([shared.id]);
      expect(state.workspaces.every((w) => w.id === shared.workspaceId)).toBe(true);
      expect(state.hosts).toEqual([]);
      expect(state.messages).toEqual([]);
      expect(state.templates).toEqual([]);
      expect(state.templateProposals).toEqual([]);
      expect(state.shares).toEqual([]);
      expect(state.hostProfiles).toEqual({});
    } finally {
      conn.sock.close();
      hub.sessions.remove(shared.id);
      hub.sessions.remove(other.id);
    }
  });

  it('is streamed its own session’s output once it attaches', async () => {
    // The path the whole feature rests on and the one the other tests step
    // around: `attached` is keyed by socket, not by scope, so a share socket
    // reaching the output loop at all is worth asserting rather than
    // assuming. A link that types fine but shows nothing is still useless.
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'watchable' });
    const token = hub.shareSession(shared.id);
    const conn = await connect(token);

    const chunks: string[] = [];
    conn.sock.on('message', (raw: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const f = decodeBinaryFrame(new Uint8Array(raw));
      if (f.kind === BinaryFrameKind.PtyOutput && f.sessionId === shared.id) {
        chunks.push(Buffer.from(f.payload).toString('utf8'));
      }
    });

    try {
      conn.sock.send(JSON.stringify({ t: 'attach', sessionId: shared.id }));
      conn.sock.send(
        encodeBinaryFrame(
          BinaryFrameKind.PtyInput,
          shared.id,
          new TextEncoder().encode('echo shared-output-marker\n'),
        ),
        { binary: true },
      );
      await waitFor(
        () => chunks.join('').includes('shared-output-marker'),
        15_000,
        'the shell’s output to reach the share socket',
      );
    } finally {
      conn.sock.close();
      hub.sessions.remove(shared.id);
    }
  });

  it('delivers a PtyInput frame addressed to its own session', async () => {
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'typeable' });
    const token = hub.shareSession(shared.id);
    const conn = await connect(token);

    const seen: string[] = [];
    const real = hub.sessions.write.bind(hub.sessions);
    hub.sessions.write = (id: string, data: string) => {
      if (id === shared.id) seen.push(data);
      real(id, data);
    };
    try {
      conn.sock.send(
        encodeBinaryFrame(BinaryFrameKind.PtyInput, shared.id, new TextEncoder().encode('echo hi\n')),
        { binary: true },
      );
      await waitFor(() => seen.length > 0, 5_000, 'the input to reach the pty');
      expect(seen[0]).toBe('echo hi\n');
    } finally {
      hub.sessions.write = real;
      conn.sock.close();
      hub.sessions.remove(shared.id);
    }
  });

  it('drops a frame addressed to a different session', async () => {
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'scoped-a' });
    const other = await hub.startSession({ workspaceId, profile: 'shell', name: 'scoped-b' });
    const token = hub.shareSession(shared.id);
    const conn = await connect(token);

    const seen: string[] = [];
    const real = hub.sessions.write.bind(hub.sessions);
    hub.sessions.write = (id: string, data: string) => {
      seen.push(id);
      real(id, data);
    };
    try {
      conn.sock.send(
        encodeBinaryFrame(BinaryFrameKind.PtyInput, other.id, new TextEncoder().encode('nope\n')),
        { binary: true },
      );
      // Nothing to wait for - the point is that nothing happens - so this
      // outlasts the previous test's own wait for the positive case, then
      // checks nothing landed for either session.
      await new Promise((r) => setTimeout(r, 300));
      expect(seen).toEqual([]);
    } finally {
      hub.sessions.write = real;
      conn.sock.close();
      hub.sessions.remove(shared.id);
      hub.sessions.remove(other.id);
    }
  });

  it('refuses removeSession and startSession', async () => {
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'guarded' });
    const token = hub.shareSession(shared.id);
    const conn = await connect(token);
    try {
      await expect(request(conn.sock, { t: 'removeSession', sessionId: shared.id })).rejects.toThrow();
      await expect(
        request(conn.sock, { t: 'startSession', workspaceId, profile: 'shell' }),
      ).rejects.toThrow();
      // Still there and still running: the refusal did not partly apply.
      expect(hub.sessions.get(shared.id)?.state).toBe('running');
    } finally {
      conn.sock.close();
      hub.sessions.remove(shared.id);
    }
  });

  it('refuses a resize even of its own session', async () => {
    // Not an oversight in the allowlist: a share view follows the owner's
    // grid and never asks for one of its own, so the only thing accepting
    // this could do is let a viewer resize the PTY out from under the
    // owner's window - the exact corruption `grid: 'follow'` exists to
    // prevent. Pinned so it cannot drift back in as a convenience.
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'unsizable' });
    const before = hub.sessions.get(shared.id)!;
    const token = hub.shareSession(shared.id);
    const conn = await connect(token);
    try {
      conn.sock.send(
        JSON.stringify({ t: 'resize', sessionId: shared.id, cols: 999, rows: 999 }),
      );
      await new Promise((r) => setTimeout(r, 300));
      const after = hub.sessions.get(shared.id)!;
      expect([after.cols, after.rows]).toEqual([before.cols, before.rows]);
    } finally {
      conn.sock.close();
      hub.sessions.remove(shared.id);
    }
  });

  it('is not told about another session changing', async () => {
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'quiet' });
    const other = await hub.startSession({ workspaceId, profile: 'shell', name: 'noisy' });
    const token = hub.shareSession(shared.id);
    const conn = await connect(token);
    try {
      hub.sessions.setStatusText(other.id, 'doing something');
      await new Promise((r) => setTimeout(r, 300));
      expect(
        conn.messages.some((m) => m.t === 'sessionUpserted' && m.session.id === other.id),
      ).toBe(false);
    } finally {
      conn.sock.close();
      hub.sessions.remove(shared.id);
      hub.sessions.remove(other.id);
    }
  });

  it('is closed by revocation, and a fresh hello with the same token is then refused', async () => {
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'revocable' });
    const token = hub.shareSession(shared.id);
    const conn = await connect(token);

    const closed = new Promise<void>((resolve) => conn.sock.on('close', () => resolve()));
    hub.unshareSession(shared.id);
    await closed;

    await expect(connect(token)).rejects.toThrow(/unauthorized/);
    hub.sessions.remove(shared.id);
  });

  it('still resolves after the hub is torn down and rebuilt on the same database', async () => {
    const shared = await hub.startSession({ workspaceId, profile: 'shell', name: 'durable' });
    const token = hub.shareSession(shared.id);

    hub.shutdown();
    await app.close();

    hub = new Hub({ dbPath: join(home, 'state.db') });
    ({ app, origin } = await serve({ hub, port: 0, clientToken: CLIENT_TOKEN, headless: true }));

    expect(hub.resolveShareToken(token)).toBe(shared.id);
    const conn = await connect(token);
    expect(conn.ready.state.sessions[0]?.id).toBe(shared.id);
    conn.sock.close();
  });
});
