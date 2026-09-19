import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { compareVersions, isNewer, type UpdateInfo } from '@termscape/protocol';
import { installKind, isInstalledPackage } from '../src/update/install.js';
import { EXIT_RESTART, restartArgs } from '../src/update/restart.js';
import { findNpxCli, Updater, type UpdaterOptions } from '../src/update/updater.js';
import { runHubs, shouldSupervise } from '../src/supervisor.js';
import { WebSocketServer } from 'ws';
import type { Hub } from '../src/hub.js';
import type { PeerServer } from '../src/remote/peer-serve.js';
import { joinCanvas } from '../src/remote/join.js';
import { removeTree } from './tmp.js';

describe('comparing versions', () => {
  it('orders releases numerically, not as strings', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('counts a prerelease as older than its release', () => {
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.2.0-beta.1')).toBeGreaterThan(0);
  });

  it('never offers an update it cannot read', () => {
    expect(isNewer('garbage', '0.1.9')).toBe(false);
    expect(isNewer(null, '0.1.9')).toBe(false);
    expect(isNewer('0.1.8', '0.1.9')).toBe(false);
    expect(isNewer('0.2.0', '0.1.9')).toBe(true);
  });
});

describe('how this hub was installed', () => {
  const npx = '/home/u/.npm/_npx/a1b2/node_modules/@kdonev/termscape/dist/cli.js';
  const global = '/usr/local/lib/node_modules/@kdonev/termscape/dist/cli.js';
  const project = '/work/app/node_modules/@kdonev/termscape/dist/cli.js';
  const checkout = '/src/termscape/packages/hub/dist/cli.js';

  // A global prefix has npm's shim beside it; a project's node_modules does not.
  const shims = new Set(['/usr/local/bin/termscape', 'C:/Users/u/AppData/Roaming/npm/termscape.cmd']);
  const exists = (p: string) => shims.has(p);

  it('tells npx from a global install from a checkout', () => {
    const posix = { joined: false, exists, platform: 'linux' as const };
    expect(installKind(npx, posix)).toBe('npx');
    expect(installKind(global, posix)).toBe('global');
    expect(installKind(checkout, posix)).toBe('source');
  });

  it('does not take a copy inside some project for the global one', () => {
    // `npm install -g` would update a copy nothing runs.
    expect(installKind(project, { joined: false, exists, platform: 'linux' })).toBe('source');
  });

  it('finds the Windows shim beside a global install', () => {
    const win = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@kdonev\\termscape\\dist\\cli.js';
    expect(installKind(win, { joined: false, exists, platform: 'win32' })).toBe('global');
  });

  it('leaves a joined machine to its canvas', () => {
    expect(installKind(npx, { joined: true })).toBe('host');
  });

  it('reads Windows paths too', () => {
    const win = 'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\ab\\node_modules\\@kdonev\\termscape\\dist\\cli.js';
    expect(isInstalledPackage(win)).toBe(true);
    expect(installKind(win, { joined: false })).toBe('npx');
  });
});

describe('the supervisor', () => {
  const installed = '/x/node_modules/@kdonev/termscape/dist/cli.js';

  it('runs an installed hub that has a canvas', () => {
    expect(shouldSupervise({}, installed, {})).toBe(true);
  });

  it('stays out of the way of everything else', () => {
    expect(shouldSupervise({}, '/src/packages/hub/dist/cli.js', {})).toBe(false);
    expect(shouldSupervise({ headless: true }, installed, {})).toBe(false);
    expect(shouldSupervise({ join: 'http://x' }, installed, {})).toBe(false);
    expect(shouldSupervise({ version: true }, installed, {})).toBe(false);
    // The hub it starts must not start a supervisor of its own.
    expect(shouldSupervise({}, installed, { TERMSCAPE_SUPERVISED: '1' })).toBe(false);
    expect(shouldSupervise({}, installed, { TERMSCAPE_NO_SUPERVISOR: '1' })).toBe(false);
  });

  describe('restarting', () => {
    let home: string;
    beforeAll(() => {
      home = mkdtempSync(join(tmpdir(), 'termscape-supervise-'));
    });
    afterAll(() => removeTree(home));

    it('starts what the hub left behind, and exits with the last hub', async () => {
      // A stand-in hub: the first run asks to be replaced by a second, which
      // exits with a code of its own that the supervisor must pass on.
      const fake = join(home, 'fake-cli.mjs');
      writeFileSync(
        fake,
        [
          "import { writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const second = process.argv.includes('second');",
          "console.log(`run ${second ? 'second' : 'first'} supervised=${process.env.TERMSCAPE_SUPERVISED}`);",
          'if (second) process.exit(3);',
          'writeFileSync(join(process.env.TERMSCAPE_HOME, "restart.json"), JSON.stringify({',
          '  command: process.execPath,',
          "  args: [process.argv[1], 'second'],",
          '}));',
          `process.exit(${EXIT_RESTART});`,
        ].join('\n'),
      );
      const before = process.env.TERMSCAPE_HOME;
      process.env.TERMSCAPE_HOME = home;
      let out = '';
      try {
        const code = await runHubs(
          { command: process.execPath, args: [fake] },
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            onChild: (child) => {
              child?.stdout?.on('data', (d: Buffer) => (out += d.toString()));
              child?.stderr?.on('data', (d: Buffer) => (out += d.toString()));
            },
          },
        );
        expect(code).toBe(3);
      } finally {
        process.env.TERMSCAPE_HOME = before;
      }
      expect(out).toContain('run first supervised=1');
      expect(out).toContain('run second supervised=1');
    }, 30_000);

    it('stops a hub that said it was exiting and then never did', async () => {
      // What the real hub was caught doing on Windows: state saved, restart
      // plan written, and process.exit never returning.
      const fake = join(home, 'stuck-cli.mjs');
      writeFileSync(
        fake,
        [
          "import { writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "if (process.argv.includes('second')) process.exit(4);",
          'writeFileSync(join(process.env.TERMSCAPE_HOME, "restart.json"), JSON.stringify({',
          "  command: process.execPath, args: [process.argv[1], 'second'],",
          '}));',
          `process.send({ t: 'exiting', code: ${EXIT_RESTART} });`,
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      const before = process.env.TERMSCAPE_HOME;
      process.env.TERMSCAPE_HOME = home;
      try {
        const code = await runHubs(
          { command: process.execPath, args: [fake] },
          { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        expect(code).toBe(4);
      } finally {
        process.env.TERMSCAPE_HOME = before;
      }
    }, 30_000);
  });
});

describe('a joined hub meeting a newer canvas', () => {
  let server: WebSocketServer;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'termscape-outdated-'));
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTree(dir);
  });

  it('says it can update, and stays on the line when kept as outdated', async () => {
    // A canvas a schema ahead that keeps this hub on the line anyway.
    const hellos: any[] = [];
    server.on('connection', (ws) =>
      ws.on('message', (raw: Buffer) => {
        const hello = JSON.parse(raw.toString('utf8'));
        hellos.push(hello);
        ws.send(
          JSON.stringify({
            t: 'welcome',
            hubVersion: '9.9.9',
            schemaVersion: hello.schemaVersion + 1,
            outdated: true,
          }),
        );
      }),
    );
    const tokenFile = join(dir, 'host-token');
    writeFileSync(tokenFile, 'host-token-value');
    const hub = new EventEmitter();
    let failed: string | null = null;
    hub.on('joinFailed', (m: string) => (failed = m));
    let served = false;
    const lines: string[] = [];
    const { port } = server.address() as AddressInfo;

    const link = joinCanvas({
      hub: hub as unknown as Hub,
      peerServer: { serve: () => void (served = true) } as unknown as PeerServer,
      hubUrl: `http://127.0.0.1:${port}`,
      tokenFile,
      machineIdFile: join(dir, 'machine-id'),
      log: (line) => lines.push(line),
    });
    try {
      const t0 = Date.now();
      while (!served && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 20));
    } finally {
      link.stop();
    }

    expect(hellos[0]).toMatchObject({ canUpdate: true, token: 'host-token-value' });
    expect(served).toBe(true);
    expect(failed).toBeNull();
    expect(lines.some((l) => l.includes('TERMSCAPE_JOINED='))).toBe(true);
  });
});

describe('the restart command line', () => {
  it('pins the port and token the canvas is already open on', () => {
    expect(restartArgs(['--port', '4242', '--token=abc', '--listen', 'loopback'], {
      port: 7777,
      token: 'tok',
    })).toEqual(['--listen', 'loopback', '--port=7777', '--token=tok']);
  });

  it('does not open a second browser tab beside the one reconnecting', () => {
    expect(restartArgs(['--browser'], { port: 1, token: 't' })).toEqual([
      '--browser',
      '--no-open',
      '--port=1',
      '--token=t',
    ]);
  });
});

describe('finding a release in the npx cache', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'termscape-npx-'));
  });
  afterAll(() => removeTree(root));

  it('reads it off the PATH npm built, and checks the version', () => {
    const modules = join(root, '_npx', 'abc123', 'node_modules');
    const pkg = join(modules, '@kdonev', 'termscape');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    mkdirSync(join(modules, '.bin'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'cli.js'), '');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: '0.2.0' }));
    const pathVar = ['/usr/bin', join(modules, '.bin'), '/bin'].join(delimiter);

    expect(findNpxCli(pathVar, '0.2.0')).toBe(join(pkg, 'dist', 'cli.js'));
    expect(findNpxCli(pathVar, '0.3.0')).toBeNull();
  });
});

describe('the updater', () => {
  function updater(overrides: Partial<UpdaterOptions> = {}) {
    const restarts: unknown[] = [];
    const changes: UpdateInfo[] = [];
    const u = new Updater({
      currentVersion: '0.1.9',
      kind: 'npx',
      canRestart: true,
      cliPath: '/x/cli.js',
      restartArgs: () => ['--port=1'],
      restart: (plan) => restarts.push(plan),
      fetchLatest: async () => '0.2.0',
      prepare: async (_k, v) => ({ command: 'node', args: [`cli@${v}`] }),
      ...overrides,
    });
    u.on('change', (i: UpdateInfo) => changes.push(i));
    return { u, restarts, changes };
  }

  it('says when there is something newer', async () => {
    const { u, changes } = updater();
    await u.check();
    expect(u.info().latest).toBe('0.2.0');
    expect(changes).toHaveLength(1);
  });

  it('keeps quiet about a registry it cannot reach', async () => {
    const { u, changes } = updater({
      fetchLatest: async () => {
        throw new Error('offline');
      },
    });
    await u.check();
    expect(u.info().latest).toBeNull();
    expect(changes).toHaveLength(0);
  });

  it('fetches, then restarts into what it fetched', async () => {
    const { u, restarts, changes } = updater();
    await u.check();
    await u.apply();
    expect(changes.map((c) => c.state)).toEqual(['idle', 'downloading', 'restarting']);
    await new Promise((r) => setTimeout(r, 400));
    expect(restarts).toEqual([{ command: 'node', args: ['cli@0.2.0'] }]);
  });

  it('reports a failed download and does not restart', async () => {
    const { u, restarts } = updater({
      prepare: async () => {
        throw new Error('npm said no');
      },
    });
    await u.check();
    await expect(u.apply()).rejects.toThrow('npm said no');
    expect(u.info()).toMatchObject({ state: 'failed', error: 'npm said no' });
    await new Promise((r) => setTimeout(r, 400));
    expect(restarts).toHaveLength(0);
  });

  it('refuses what it cannot finish', async () => {
    const upToDate = updater({ fetchLatest: async () => '0.1.9' });
    await upToDate.u.check();
    await expect(upToDate.u.apply()).rejects.toThrow(/up to date/);

    const checkout = updater({ kind: 'source' });
    await checkout.u.check();
    await expect(checkout.u.apply()).rejects.toThrow(/not installed from npm/);

    const unsupervised = updater({ canRestart: false });
    await unsupervised.u.check();
    await expect(unsupervised.u.apply()).rejects.toThrow(/cannot restart itself/);
  });

  it('carries a failure the last hub hit on its way out', () => {
    const { u } = updater({ initialError: 'could not install' });
    expect(u.info()).toMatchObject({ state: 'failed', error: 'could not install' });
  });
});
