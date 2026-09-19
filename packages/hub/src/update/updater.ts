import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNewer, type InstallKind, type UpdateInfo } from '@termscape/protocol';
import { debug } from '../debug.js';
import { PACKAGE_NAME, runNpm } from './install.js';
import type { RestartPlan } from './restart.js';

/** The first look waits for the hub to settle; the rest are far apart. */
const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

export interface UpdaterOptions {
  currentVersion: string;
  kind: InstallKind;
  /** Whether a supervisor is there to start the new version. */
  canRestart: boolean;
  /** This hub's own cli.js, which a global update leaves where it is. */
  cliPath: string;
  /** The command line the next hub should get. Read at restart, not before. */
  restartArgs: () => string[];
  /** Hand the plan to whoever owns the process, and exit into it. */
  restart: (plan: RestartPlan) => void;
  /** A failure the previous hub hit on its way out, reported by this one. */
  initialError?: string | null;
  /** Tests stand in for npm and the registry. */
  fetchLatest?: () => Promise<string>;
  prepare?: (kind: InstallKind, version: string) => Promise<RestartPlan>;
}

/**
 * Whether a newer termscape is out, and installing it on request.
 *
 * Checking is automatic and silent: a machine with no network, or a registry
 * having a bad minute, costs nothing but a button that does not appear. What
 * is never automatic is the restart. That takes every agent on this machine
 * down with it, so it waits for someone to press the button.
 */
export class Updater extends EventEmitter {
  private latest: string | null = null;
  private state: UpdateInfo['state'];
  private error: string | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: UpdaterOptions) {
    super();
    this.error = opts.initialError ?? null;
    this.state = this.error ? 'failed' : 'idle';
  }

  info(): UpdateInfo {
    return {
      latest: this.latest,
      kind: this.opts.kind,
      canRestart: this.opts.canRestart,
      state: this.state,
      error: this.error,
    };
  }

  start(): void {
    if (this.timer) return;
    const tick = (): void => {
      void this.check();
      this.timer = setTimeout(tick, CHECK_EVERY_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(tick, FIRST_CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    try {
      const latest = await (this.opts.fetchLatest ?? fetchLatest)();
      if (latest === this.latest) return;
      this.latest = latest;
      debug('update', `latest ${latest}, running ${this.opts.currentVersion}`);
      this.changed();
    } catch (err) {
      debug('update', `check failed: ${(err as Error).message}`);
    }
  }

  /**
   * Fetch the new release while this hub keeps running, then hand over.
   * Throws - into the ack of whoever pressed the button - for anything that
   * stops short of the restart.
   */
  async apply(): Promise<void> {
    const { kind, canRestart, currentVersion } = this.opts;
    const target = this.latest;
    if (target === null || !isNewer(target, currentVersion)) {
      throw new Error('already up to date');
    }
    if (kind !== 'npx' && kind !== 'global') {
      throw new Error('this hub was not installed from npm; update it the way it was installed');
    }
    if (!canRestart) {
      throw new Error(
        'this hub cannot restart itself; stop it and start termscape again once to enable updates',
      );
    }
    if (this.state === 'downloading' || this.state === 'restarting') {
      throw new Error('an update is already under way');
    }

    this.state = 'downloading';
    this.error = null;
    this.changed();
    let plan: RestartPlan;
    try {
      plan = await (this.opts.prepare ?? ((k, v) => this.prepare(k, v)))(kind, target);
    } catch (err) {
      this.state = 'failed';
      this.error = (err as Error).message;
      this.changed();
      throw err;
    }
    this.state = 'restarting';
    this.changed();
    // A moment for the ack and the broadcast to leave before the sockets go.
    setTimeout(() => this.opts.restart(plan), 300);
  }

  private async prepare(kind: InstallKind, version: string): Promise<RestartPlan> {
    const args = this.opts.restartArgs();
    if (kind === 'npx') {
      const cli = await fetchIntoNpxCache(version);
      return { command: process.execPath, args: [cli, ...args] };
    }
    // A global install replaces files this hub holds open, which Windows
    // refuses, so the install runs between this hub and the next one - from
    // a script beside this file, started by the supervisor.
    const script = join(dirname(fileURLToPath(import.meta.url)), 'post-install.js');
    return {
      command: process.execPath,
      args: [script, version, this.opts.cliPath, ...args],
    };
  }

  private changed(): void {
    this.emit('change', this.info());
  }
}

/** The newest release on the registry. */
export async function fetchLatest(): Promise<string> {
  const registry = (process.env.TERMSCAPE_UPDATE_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/$/, '');
  const res = await fetch(`${registry}/${PACKAGE_NAME}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== 'string') throw new Error('registry sent no version');
  return body.version;
}

/**
 * Where a package fetched by `npm exec` lives, read off the PATH npm built
 * for the command it ran: npm puts the package's own .bin on it, inside the
 * npx cache. Null when no entry there holds this version.
 */
export function findNpxCli(pathVar: string, version: string): string | null {
  for (const entry of pathVar.split(delimiter)) {
    if (!/[\\/]_npx[\\/]/.test(entry) || !/[\\/]\.bin[\\/]?$/.test(entry)) continue;
    const pkgDir = join(entry, '..', ...PACKAGE_NAME.split('/'));
    const cli = join(pkgDir, 'dist', 'cli.js');
    if (!existsSync(cli)) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
        version?: string;
      };
      if (manifest.version === version) return cli;
    } catch {
      // Not this one; keep looking.
    }
  }
  return null;
}

/**
 * Put a release into npx's cache and return the path of its cli.js.
 *
 * `npm exec` is what `npx` is, so this lands exactly where a fresh
 * `npx @kdonev/termscape@<v>` would have. The new hub is then started with
 * plain `node`, not through npm, which would otherwise sit between the
 * supervisor and the hub for the rest of the session.
 */
async function fetchIntoNpxCache(version: string): Promise<string> {
  const out = await runNpm([
    'exec',
    '--yes',
    `--package=${PACKAGE_NAME}@${version}`,
    '--',
    'node',
    '-p',
    'process.env.PATH',
  ]);
  const lines = out.trim().split(/\r?\n/);
  const cli = findNpxCli(lines[lines.length - 1] ?? '', version);
  if (!cli) {
    throw new Error(`npm fetched ${PACKAGE_NAME}@${version} but it is not in the npx cache`);
  }
  return cli;
}
