import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebSocket as WsClient } from 'ws';
import type { Message, ServerMsg } from '@termscape/protocol';
import { Hub } from '../src/hub.js';
import { serve } from '../src/server.js';
import {
  captureConsole,
  clearRecentLog,
  debug,
  recentLog,
  redactFromLog,
  RECENT_LOG_LINES,
} from '../src/debug.js';
import { collectReport, describeMessage, formatReport } from '../src/bug-report.js';
import { removeTree } from './tmp.js';

/*
 * Issue 42: "report a bug" can export logs to a file, for a bug - messages
 * that never arrive - whose evidence is gone by the time anyone notices it.
 * The tracker is public, so what matters as much as what the file holds is
 * what it never holds: message text and tokens.
 */

describe('the in-memory log', () => {
  beforeEach(() => clearRecentLog());

  it('keeps deliver traces with tracing off, and drops input', () => {
    // The suite runs without TERMSCAPE_DEBUG, so neither topic is on.
    debug('deliver', 'message m1: accepted');
    debug('input', 'a mouse report');
    const log = recentLog();
    expect(log.some((l) => l.endsWith('[deliver] message m1: accepted'))).toBe(true);
    expect(log.some((l) => l.includes('mouse report'))).toBe(false);
  });

  it('is bounded, dropping the oldest lines', () => {
    for (let i = 0; i < RECENT_LOG_LINES + 10; i++) debug('deliver', `line ${i}`);
    const log = recentLog();
    expect(log).toHaveLength(RECENT_LOG_LINES);
    expect(log[0]).toContain('line 10');
  });

  it('redacts a secret it was told about', () => {
    redactFromLog('super-secret-token');
    debug('deliver', 'url /?token=super-secret-token');
    expect(recentLog().join('\n')).not.toContain('super-secret-token');
  });
});

describe('a report', () => {
  it('describes a message without its text', () => {
    const m: Message = {
      id: 'm1',
      fromAddr: 'ws/a',
      toAddr: 'ws/b',
      body: 'THE-SECRET-BODY',
      sentAt: 1000,
      deliveredAt: 1250,
      deliveryState: 'delivered',
      error: null,
    };
    const line = describeMessage(m);
    expect(line).toContain('ws/a -> ws/b (15 chars) delivered after 250ms');
    expect(line).not.toContain('THE-SECRET-BODY');
  });

  it('says so when an attached machine does not answer, without waiting on it', async () => {
    const fake = {
      store: {
        listHosts: () => [
          { id: 'h1', label: 'silent', platform: 'linux', state: 'connected', error: null },
          { id: 'h2', label: 'gone', platform: 'win32', state: 'disconnected', error: null },
        ],
      },
      peers: {
        peer: (id: string) =>
          id === 'h1' ? { connected: true, request: () => new Promise(() => {}) } : null,
      },
      sessions: { list: () => [] },
      messages: () => [],
    } as unknown as Hub;

    const t0 = Date.now();
    const text = formatReport(await collectReport(fake, 50));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(text).toContain('== silent (attached, linux)');
    expect(text).toMatch(/no answer - the host did not answer/);
    expect(text).toContain('== gone (attached, win32)');
    expect(text).toContain('not connected (disconnected)');
  });
});

describe('exportLogs over the socket', () => {
  let home: string;
  let hub: Hub;
  let app: FastifyInstance;
  let origin: string;
  let workspaceId: string;
  const CLIENT_TOKEN = 'canvas-token-for-bug-report-tests';

  function connect(token: string): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const sock = new WsClient(`${origin.replace('http', 'ws')}/ws`);
      sock.on('open', () => sock.send(JSON.stringify({ t: 'hello', token })));
      sock.on('message', (raw: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const msg = JSON.parse(raw.toString()) as ServerMsg;
        if (msg.t === 'ready') resolve(sock);
        else if (msg.t === 'error') reject(new Error(msg.message));
      });
      sock.on('error', reject);
    });
  }

  function request(sock: WsClient, msg: Record<string, unknown>): Promise<{ path?: string }> {
    const requestId = `t${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const onMsg = (raw: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        const parsed = JSON.parse(raw.toString());
        if (parsed.t !== 'ack' || parsed.requestId !== requestId) return;
        sock.off('message', onMsg);
        if (parsed.ok) resolve({ path: parsed.path });
        else reject(new Error(parsed.message ?? 'refused'));
      };
      sock.on('message', onMsg);
      sock.send(JSON.stringify({ ...msg, requestId }));
    });
  }

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'termscape-bugreport-'));
    process.env.TERMSCAPE_HOME = home;
    // As main() does, so the banner-style line below really reaches the log.
    captureConsole();
    redactFromLog(CLIENT_TOKEN);
    hub = new Hub({ dbPath: join(home, 'state.db') });
    ({ app, origin } = await serve({ hub, port: 0, clientToken: CLIENT_TOKEN, headless: true }));
    workspaceId = hub.createWorkspace('bugws', home).id;
  });

  afterAll(async () => {
    hub.shutdown();
    await app.close();
    await removeTree(home);
    delete process.env.TERMSCAPE_HOME;
  });

  it('writes a file with the delivery, and without the text or the token', async () => {
    const from = await hub.startSession({ workspaceId, profile: 'shell', name: 'sender' });
    const to = await hub.startSession({ workspaceId, profile: 'shell', name: 'receiver' });
    const marker = 'MARKER-THAT-MUST-NOT-LEAK';
    hub.router.send(from.address, to.address, `echo ${marker}`);
    console.log(`the banner would print ${origin}/?token=${CLIENT_TOKEN}`);

    const sock = await connect(CLIENT_TOKEN);
    try {
      const { path } = await request(sock, { t: 'exportLogs' });
      expect(path).toBeTruthy();
      expect(dirname(path!)).toBe(join(home, 'bug-reports'));
      const text = readFileSync(path!, 'utf8');
      expect(text).toContain('== this machine (canvas)');
      expect(text).toContain(`${from.address} -> ${to.address}`);
      expect(text).toContain('[deliver]');
      expect(text).not.toContain(marker);
      expect(text).toContain('the banner would print');
      expect(text).not.toContain(CLIENT_TOKEN);
    } finally {
      sock.close();
    }
  });

  it('is refused on a shared-session link', async () => {
    const s = await hub.startSession({ workspaceId, profile: 'shell', name: 'shared' });
    const sock = await connect(hub.shareSession(s.id));
    try {
      await expect(request(sock, { t: 'exportLogs' })).rejects.toThrow(/not permitted/);
    } finally {
      sock.close();
    }
  });
});
