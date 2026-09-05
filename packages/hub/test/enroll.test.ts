import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { PEER_SCHEMA_VERSION } from '@aicanvas/protocol';
import { Hub } from '../src/hub.js';
import { serve, type ServeResult } from '../src/server.js';
import { registerEnrollment } from '../src/remote/enroll.js';
import { joinCanvas, type JoinLink } from '../src/remote/join.js';
import { hostname } from 'node:os';
import {
  advertisedHost,
  coversLoopback,
  isLoopback,
  preferredHostname,
  resolveBindHost,
} from '../src/remote/lan.js';

/**
 * Enrollment: a machine fetches the installer, runs it, and dials in.
 *
 * Everything but the installer script itself is exercised for real — two hubs,
 * two databases, the actual peer protocol over an actual socket. What differs
 * from production is only that hub B is started in-process instead of by
 * join.sh, which is the same seam peer.test.ts uses for the SSH path.
 */

let homeA: string;
let homeB: string;
let hubA: Hub;
let hubB: Hub;
let servedA: ServeResult;
let servedB: ServeResult;
let link: JoinLink | null = null;
let originA: string;
/** Hub B's durable host token, kept out of the shared AICANVAS_HOME. */
let tokenFileB: string;

const outputB = new Map<string, string>();

function waitFor(fn: () => boolean, ms = 15_000, label = 'condition'): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return res();
      if (Date.now() - t0 > ms) return rej(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const parse = (res: any) => JSON.parse(res.content[0].text);

async function mcpAs(hub: Hub, origin: string, sessionId: string): Promise<Client> {
  const token = hub.tokens.get(sessionId)!;
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: 'enroll-test', version: '0' });
  await c.connect(transport);
  return c;
}

beforeAll(async () => {
  homeA = mkdtempSync(join(tmpdir(), 'aicanvas-enroll-A-'));
  homeB = mkdtempSync(join(tmpdir(), 'aicanvas-enroll-B-'));
  tokenFileB = join(homeB, 'host-token');
  process.env.AICANVAS_HOME = homeA;

  hubA = new Hub({ dbPath: join(homeA, 'state.db') });
  servedA = await serve({ hub: hubA, port: 0, clientToken: 'client-token-a', headless: true });
  originA = servedA.origin;

  // Hub B stands in for the machine that ran the join installer.
  hubB = new Hub({ dbPath: join(homeB, 'state.db') });
  hubB.on('data', (id: string, chunk: string) =>
    outputB.set(id, (outputB.get(id) ?? '') + chunk),
  );
  servedB = await serve({ hub: hubB, port: 0, clientToken: 'client-token-b', headless: true });
}, 60_000);

afterAll(async () => {
  link?.stop();
  hubA.shutdown();
  hubB.shutdown();
  await servedA.app.close();
  await servedB.app.close();
  rmSync(homeA, { recursive: true, force: true });
  rmSync(homeB, { recursive: true, force: true });
  delete process.env.AICANVAS_HOME;
});

describe('bind address', () => {
  it('advertises nothing while bound to loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(advertisedHost('127.0.0.1')).toBeNull();
    expect(advertisedHost('::1')).toBeNull();
    // A hub that nobody else can reach must not claim it has a join page.
    expect(servedA.enrollOrigin).toBeNull();
  });

  it('binds the wildcard for lan so loopback keeps answering', () => {
    // The browser opens the canvas on 127.0.0.1 and every agent's generated
    // MCP config points there. Binding the LAN address alone would take both
    // offline, so `lan` must widen the bind, not narrow it.
    expect(resolveBindHost('lan')).toBe('0.0.0.0');
    expect(coversLoopback('0.0.0.0')).toBe(true);
    expect(coversLoopback('127.0.0.1')).toBe(true);
    // An explicit single interface genuinely does not answer on loopback.
    expect(coversLoopback('192.168.1.40')).toBe(false);
    expect(resolveBindHost('192.168.1.40')).toBe('192.168.1.40');
  });

  it('advertises the address it was told to bind', () => {
    expect(advertisedHost('192.168.1.40')).toBe('192.168.1.40');
    expect(advertisedHost('fd00::1')).toBe('[fd00::1]');
  });
});

describe('advertising this machine by name', () => {
  const IP = '192.168.1.40';
  const me = hostname();

  it('uses the bare name when it resolves to the bound address', async () => {
    const asked: string[] = [];
    const name = await preferredHostname(IP, async (n) => {
      asked.push(n);
      return n === me ? [IP] : [];
    });
    expect(name).toBe(me);
    // The bare name is nicer to type, so it must be tried before .local.
    expect(asked).toEqual([me]);
  });

  it('falls back to the mDNS name when the bare one does not resolve', async () => {
    const name = await preferredHostname(IP, async (n) =>
      n === `${me}.local` ? [IP] : [],
    );
    expect(name).toBe(`${me}.local`);
  });

  it('refuses a name that resolves somewhere else', async () => {
    // A name pointing at 127.0.0.1 - common in /etc/hosts - is useless to the
    // machine trying to reach us, so it must not be advertised.
    expect(await preferredHostname(IP, async () => ['127.0.0.1'])).toBeNull();
  });

  it('falls back to the IP when the name does not resolve at all', async () => {
    expect(
      await preferredHostname(IP, async () => {
        throw new Error('ENOTFOUND');
      }),
    ).toBeNull();
  });
});

describe('the join page', () => {
  let app: FastifyInstance;
  const ORIGIN = 'http://10.9.8.7:7333';

  beforeAll(async () => {
    // Routes only, against a stub origin: this asserts what the page hands
    // out without putting a real listener on a network interface.
    app = Fastify({ logger: false });
    await app.register(websocket);
    registerEnrollment(app, { hub: hubA, enrollOrigin: () => ORIGIN });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('shows the command to run on the other machine', async () => {
    const res = await app.inject({ method: 'GET', url: '/join' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`${ORIGIN}/join.sh`);
    expect(res.body).toContain(`${ORIGIN}/join.ps1`);
    // Nothing is cached: every load must be able to hand out a live token.
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('bakes a distinct single-use token into every installer download', async () => {
    const one = await app.inject({ method: 'GET', url: '/join.sh' });
    const two = await app.inject({ method: 'GET', url: '/join.sh' });
    expect(one.statusCode).toBe(200);

    const tokenOf = (body: string) => body.match(/JOIN_TOKEN='([^']+)'/)?.[1];
    expect(tokenOf(one.body)).toBeTruthy();
    expect(tokenOf(two.body)).toBeTruthy();
    expect(tokenOf(one.body)).not.toBe(tokenOf(two.body));

    expect(one.body).toContain(`HUB_URL='${ORIGIN}'`);
  });

  it('provisions Node itself rather than telling you to', async () => {
    // A machine with no Node is the common case for a box you are adding, so
    // the installer has to be able to get itself out of that hole.
    const sh = (await app.inject({ method: 'GET', url: '/join.sh' })).body;
    const ps = (await app.inject({ method: 'GET', url: '/join.ps1' })).body;

    for (const script of [sh, ps]) {
      expect(script).toContain('nodejs.org/dist/latest-v22.x');
      // Verified, because this is a binary the script then executes.
      expect(script).toContain('SHASUMS256.txt');
      expect(script.toLowerCase()).toContain('checksum mismatch');
    }
    // Private copy, so no admin rights and no PATH surgery are needed.
    expect(ps).toContain(String.raw`Join-Path $HomeDir 'node\node.exe'`);
    expect(sh).toContain('$HOME_DIR/node/bin/node');
  });

  it('reports progress through the steps that take a minute', async () => {
    // Downloading ~30MB of Node and running npm install are long enough that
    // a silent terminal is indistinguishable from a hung one.
    const sh = (await app.inject({ method: 'GET', url: '/join.sh' })).body;
    const ps = (await app.inject({ method: 'GET', url: '/join.ps1' })).body;

    for (const script of [sh, ps]) {
      for (const step of ['1/4', '2/4', '3/4', '4/4']) expect(script).toContain(step);
      expect(script).toContain('a minute or two on a first run');
    }
    // Each long step ticks rather than going quiet.
    expect(sh).toContain('run_ticking');
    expect(ps).toContain('Invoke-Ticking');
  });

  it('keeps a dependency tree that is still the right one', async () => {
    const sh = (await app.inject({ method: 'GET', url: '/join.sh' })).body;
    const ps = (await app.inject({ method: 'GET', url: '/join.ps1' })).body;

    // Re-running the join command is the supported way to update or repair a
    // machine, so it is the ordinary path - and npm install was the slowest
    // step in it, every time, even with nothing about the tree changed.
    for (const script of [sh, ps]) {
      expect(script).toContain('deps.fingerprint');
      expect(script).toContain('deps.stamp');
      // The ABI, not only the dependency versions: these are compiled modules
      // and a Node upgrade invalidates them without changing a version.
      expect(script).toContain('process.platform');
      // A stamp is a claim, not proof. The modules have to actually load.
      expect(script).toContain('node-pty');
    }

    // Nothing to keep unless node_modules survives the install being replaced.
    for (const script of [sh, ps]) expect(script).toContain('node_modules.kept');
    expect(sh.indexOf('mv "$HOME_DIR/hub/node_modules"')).toBeLessThan(
      sh.indexOf('rm -rf "$HOME_DIR/hub"'),
    );

    // PowerShell drops a double quote out of an argument on its way to a
    // native command, which once handed node an unparseable expression and
    // made the check fail open into a full install every run.
    expect(ps).toContain("require('node-pty')");
    expect(ps).not.toContain('require("node-pty")');
  });

  it('runs npm without routing its stderr through a PowerShell stream', async () => {
    const ps = (await app.inject({ method: 'GET', url: '/join.ps1' })).body;
    // PS 5.1 wraps a native command's stderr in an ErrorRecord, so "npm *> log"
    // turns a healthy npm notice into a terminating error.
    const NL = String.fromCharCode(10);
    const code = ps
      .split(NL)
      .filter((l) => !l.trim().startsWith('#'))
      .join(NL);
    expect(code).not.toContain('*>');
    // node running npm-cli.js: no .cmd, which CreateProcess cannot launch once
    // redirection has turned off UseShellExecute.
    expect(ps).toContain('npm-cli.js');
    expect(ps).toContain('-RedirectStandardError');
    // Start-Process -PassThru reports a null ExitCode unless the handle is
    // cached first, which once made a successful install look like a failure.
    expect(ps).toContain('$null = $p.Handle');
  });

  it('waits for the join, not merely for the hub to start', async () => {
    const sh = (await app.inject({ method: 'GET', url: '/join.sh' })).body;
    const ps = (await app.inject({ method: 'GET', url: '/join.ps1' })).body;

    for (const script of [sh, ps]) {
      // A hub that is listening has not necessarily been let in. Reporting
      // success on AICANVAS_PORT is how you tell someone they are connected
      // when the canvas refused them.
      expect(script).toContain('AICANVAS_JOINED=');
      expect(script).toContain('AICANVAS_JOIN_FAILED=');
      expect(script).toContain('refused this machine');
    }
  });

  it('stops a hub already running here before replacing its files', async () => {
    const sh = (await app.inject({ method: 'GET', url: '/join.sh' })).body;
    const ps = (await app.inject({ method: 'GET', url: '/join.ps1' })).body;

    // Re-joining a machine that still has a hub running must take over, not
    // fail: on Windows a loaded .node cannot be deleted at all.
    expect(sh).toContain('stop_running_hub');
    expect(ps).toContain('Stop-RunningHub');
    for (const script of [sh, ps]) expect(script).toContain('hub.pid');

    // The launch names cli.js absolutely so a later run can find this hub in
    // the process list by the install it came from.
    expect(ps).toContain("Join-Path $hubDir 'dist/cli.js'");
    expect(sh).toContain('"$HOME_DIR/hub/dist/cli.js"');
  });

  it('keeps regex escapes intact through template generation', async () => {
    // A lone backslash in a TS template literal is silently swallowed, which
    // once turned this version check into /^v(d+)./ and made the installer
    // re-download Node on every run.
    const ps = (await app.inject({ method: 'GET', url: '/join.ps1' })).body;
    expect(ps).toContain(String.raw`'^v(\d+)\.'`);
    expect(ps).toContain(String.raw`-win-$arch\.zip`);
    const sh = (await app.inject({ method: 'GET', url: '/join.sh' })).body;
    expect(sh).toContain(String.raw`\.tar\.gz`);
  });

  it('offers a PowerShell installer for a Windows host', async () => {
    const res = await app.inject({ method: 'GET', url: '/join.ps1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/\$JoinToken = '[^']+'/);
    expect(res.body).toContain('--join');
  });
});

describe('enrolling a host', () => {
  it('creates a connected host from one dial-in', async () => {
    const token = servedA.enrollment.mint();

    link = joinCanvas({
      hub: hubB,
      peerServer: servedB.peerServer,
      hubUrl: originA,
      joinToken: token,
      label: 'joined-box',
      tokenFile: tokenFileB,
      log: () => {},
    });

    await waitFor(
      () => hubA.store.listHosts().some((h) => h.state === 'connected'),
      15_000,
      'host to connect',
    );

    const host = hubA.store.listHosts().find((h) => h.label === 'joined-box')!;
    expect(host).toBeDefined();
    expect(host.kind).toBe('enrolled');
    // We hold no way to reach it: it reached us.
    expect(host.sshHost).toBeNull();
    expect(host.sshUser).toBeNull();
    expect(host.platform).toMatch(/-/);
  });

  it('issues a durable token so the machine rejoins on its own', async () => {
    // The host goes green the moment we adopt its socket, which is a tick
    // before it has processed our welcome and written the token.
    await waitFor(() => existsSync(tokenFileB), 10_000, 'host token on disk');
    const stored = readFileSync(tokenFileB, 'utf8').trim();
    expect(stored.length).toBeGreaterThan(20);
    // The stored token is what identifies this host from now on.
    expect(hubA.store.hostByToken(stored)?.label).toBe('joined-box');
  });

  it('refuses a second use of the same enrollment token', async () => {
    const token = servedA.enrollment.mint();
    expect(await handshake(originA, token)).toMatchObject({ t: 'welcome' });

    const second = await handshake(originA, token);
    expect(second.t).toBe('err');
    expect(second.message).toMatch(/unknown or expired/i);
  });

  it('refuses a peer speaking a different schema version', async () => {
    const token = servedA.enrollment.mint();
    const res = await handshake(originA, token, { schemaVersion: PEER_SCHEMA_VERSION + 1 });
    expect(res.t).toBe('err');
    expect(res.message).toMatch(/schema mismatch/i);
  });

  it('refuses a token it never minted', async () => {
    const res = await handshake(originA, 'not-a-token-we-issued');
    expect(res.t).toBe('err');
  });
});

describe('running agents on an enrolled host', () => {
  let hostId: string;

  beforeAll(() => {
    // By label, not by state: the refusal tests above leave short-lived
    // probe rows behind, and one of those could be momentarily connected.
    hostId = hubA.store.listHosts().find((h) => h.label === 'joined-box')!.id;
  });

  it('starts the agent on the host, not here', async () => {
    const ws = hubA.createWorkspace('joinedws', homeB, hostId);
    expect(ws.kind).toBe('remote');

    const session = await hubA.startSession({
      workspaceId: ws.id,
      profile: 'shell',
      name: 'worker',
    });
    expect(session.address).toBe('joinedws/worker');

    // The PTY belongs to B. A never spawned a process for it.
    expect(hubB.sessions.getByAddress('joinedws/worker')).toBeTruthy();
    expect(hubA.sessions.getByAddress('joinedws/worker')).toBeFalsy();

    // And it shows up on A's canvas, keyed by address.
    await waitFor(
      () => hubA.allSessions().some((s) => s.id === 'joinedws/worker'),
      15_000,
      'remote session on the canvas',
    );
  }, 30_000);

  it('carries a message across the inbound link', async () => {
    const local = await hubA.startSession({
      workspaceId: hubA.createWorkspace('homews', homeA).id,
      profile: 'shell',
      name: 'sender',
    });
    const remote = hubB.sessions.getByAddress('joinedws/worker')!;
    await waitFor(() => (outputB.get(remote.id)?.length ?? 0) > 0, 15_000, 'remote shell boot');

    const client = await mcpAs(hubA, originA, local.id);

    const agents = parse(await client.callTool({ name: 'list_agents', arguments: {} }));
    const entry = agents.find((a: any) => a.address === 'joinedws/worker');
    expect(entry).toBeDefined();
    expect(entry.host).toBe('joined-box');

    const marker = `ENROLLED_${Date.now()}`;
    const sent = parse(
      await client.callTool({
        name: 'send_message',
        arguments: { to: 'joinedws/worker', text: marker },
      }),
    );
    expect(sent.delivered).toBe(true);

    await waitFor(
      () => (outputB.get(remote.id) ?? '').includes(marker),
      15_000,
      'marker in the enrolled host terminal',
    );
    expect(outputB.get(remote.id)).toContain('[from homews/sender]');

    await client.close();
  }, 30_000);

  it('reads a screen on the enrolled host', async () => {
    const local = hubA.sessions.getByAddress('homews/sender')!;
    const client = await mcpAs(hubA, originA, local.id);
    const r = parse(
      await client.callTool({
        name: 'read_screen',
        arguments: { address: 'joinedws/worker', lines: 10 },
      }),
    );
    expect(r.address).toBe('joinedws/worker');
    expect(r.running).toBe(true);
    await client.close();
  });

  it('will not try to dial a host that dials us', async () => {
    await expect(hubA.connectHost(hostId)).rejects.toThrow(/enrolled itself/i);
  });
});

describe('losing the link', () => {
  it('comes back on the stored token, without enrolling twice', async () => {
    const before = hubA.store.listHosts().length;
    const host = hubA.store.listHosts().find((h) => h.label === 'joined-box')!;

    // Drop it the way a network blip would, from the canvas hub's end.
    hubA.peers.peer(host.id)!.close();
    await waitFor(
      () => hubA.store.listHosts().find((h) => h.id === host.id)?.state !== 'connected',
      10_000,
      'host to go down',
    );

    // The session is still B's and still running; only our view of it lapsed.
    expect(hubB.sessions.getByAddress('joinedws/worker')?.state).toBe('running');

    // No redial from here — the host reaches us, on its own backoff.
    await waitFor(
      () => hubA.store.listHosts().find((h) => h.id === host.id)?.state === 'connected',
      20_000,
      'host to rejoin',
    );

    // Same row: the durable token identified it, so nothing was re-enrolled.
    expect(hubA.store.listHosts().length).toBe(before);
    await waitFor(
      () => hubA.allSessions().some((s) => s.id === 'joinedws/worker'),
      15_000,
      'remote session back on the canvas',
    );
  }, 45_000);
});

/** One handshake against /peer-in, resolved with whatever came back. */
function handshake(
  origin: string,
  token: string,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const url = origin.replace(/^http/, 'ws') + '/peer-in';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('handshake timed out'));
    }, 10_000);

    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          t: 'hello',
          token,
          hubVersion: '0.0.0-test',
          schemaVersion: PEER_SCHEMA_VERSION,
          enroll: {
            label: 'probe',
            platform: 'linux',
            arch: 'x64',
            homeDir: '/home/probe',
          },
          ...overrides,
        }),
      ),
    );
    ws.on('message', (raw: Buffer) => {
      clearTimeout(timer);
      const msg = JSON.parse(raw.toString('utf8'));
      ws.close();
      resolve(msg);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('a refused join', () => {
  it('reports the reason and gives up instead of retrying', async () => {
    const failure = new Promise<string>((resolve) =>
      hubB.once('joinFailed', (m: string) => resolve(m)),
    );

    const link = joinCanvas({
      hub: hubB,
      peerServer: servedB.peerServer,
      hubUrl: originA,
      joinToken: 'a-token-that-was-never-minted',
      label: 'rejected-box',
      // A path of its own: the real host token must not be consulted here.
      tokenFile: join(homeB, 'rejected-token'),
      log: () => {},
    });

    const reason = await failure;
    expect(reason).toMatch(/unknown or expired/i);
    // Nothing was written for a machine that was turned away.
    expect(existsSync(join(homeB, 'rejected-token'))).toBe(false);
    link.stop();
  }, 20_000);
});

describe('a peer refusing a request', () => {
  it('rejects without becoming a process-level fault', async () => {
    // Typing into a remote terminal whose PTY has exited is ordinary. The
    // peer rejects; unhandled, that rejection reaches the process and takes
    // the whole canvas down with every agent on it.
    const host = hubA.store.listHosts().find((h) => h.label === 'joined-box')!;
    const peer = hubA.peers.peer(host.id)!;

    // Stop the remote session, then act on it as the browser would.
    await hubA.peers.stopSession('joinedws/worker');
    await waitFor(
      () => hubB.sessions.getByAddress('joinedws/worker')?.state !== 'running',
      15_000,
      'remote session to stop',
    );

    await expect(
      peer.request({
        t: 'input',
        id: randomUUID(),
        address: 'joinedws/worker',
        data: 'hello?',
      }),
    ).rejects.toThrow(/is not running/i);

    // The link itself is unharmed: the refusal was about one session.
    expect(peer.connected).toBe(true);
    expect(hubA.store.listHosts().find((h) => h.id === host.id)?.state).toBe('connected');
  }, 30_000);
});

describe('re-joining a machine the canvas has forgotten', () => {
  it('falls back to the fresh key instead of failing on a stale one', async () => {
    const tokenFile = join(homeB, 'forgotten-token');

    // Enrol once, the ordinary way.
    const first = joinCanvas({
      hub: hubB,
      peerServer: servedB.peerServer,
      hubUrl: originA,
      joinToken: servedA.enrollment.mint(),
      label: 'forgetful-box',
      tokenFile,
      log: () => {},
    });
    await waitFor(() => existsSync(tokenFile), 15_000, 'host token written');
    const staleToken = readFileSync(tokenFile, 'utf8').trim();
    first.stop();

    // Drop it from the canvas, the way the hosts panel does. The machine is
    // still holding a credential that now means nothing.
    const host = hubA.store.listHosts().find((h) => h.label === 'forgetful-box')!;
    await hubA.removeHost(host.id);
    expect(hubA.store.hostByToken(staleToken)).toBeNull();
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(staleToken);

    // Re-running the join command hands it a fresh key. The stale token must
    // not be allowed to fail the whole thing while that key sits unused.
    const second = joinCanvas({
      hub: hubB,
      peerServer: servedB.peerServer,
      hubUrl: originA,
      joinToken: servedA.enrollment.mint(),
      label: 'forgetful-box',
      tokenFile,
      log: () => {},
    });

    await waitFor(
      () => hubA.store.listHosts().some((h) => h.label === 'forgetful-box'),
      20_000,
      'machine to enrol again',
    );
    await waitFor(
      () => readFileSync(tokenFile, 'utf8').trim() !== staleToken,
      10_000,
      'a new host token',
    );
    second.stop();
    await hubA.removeHost(
      hubA.store.listHosts().find((h) => h.label === 'forgetful-box')!.id,
    );
  }, 45_000);
});

describe('dropping a host', () => {
  it('asks the machine to stop its hub, not just forgets it', async () => {
    // The hub over there is a daemon someone started on their own machine.
    // Forgetting it here would leave it running, holding its own install
    // open - which on Windows makes the next join fail outright.
    const stopped = new Promise<void>((resolve) => hubB.once('peerShutdown', resolve));

    const host = hubA.store.listHosts().find((h) => h.label === 'joined-box')!;
    await hubA.removeHost(host.id);

    await stopped;
    expect(hubA.store.listHosts().some((h) => h.id === host.id)).toBe(false);
  }, 20_000);
});
