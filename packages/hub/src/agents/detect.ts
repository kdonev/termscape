import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { platform } from 'node:process';
import type { AgentProfileInfo } from '@termscape/protocol';
import { which } from './resolve.js';
import type { AgentProfile, ProfileRegistry } from './profiles.js';

/**
 * What is actually installed on this machine, and what each one can be
 * pointed at.
 *
 * The picker used to offer whatever agents.toml declared, whether or not the
 * command existed, and said nothing about models. Two things make that worse
 * than it sounds. A declared agent that is not installed fails at launch,
 * inside a terminal window on the canvas, where the error reads like the hub
 * is broken. And a model has to be typed from memory, which is how you find
 * out that the CLI spells it differently than you thought.
 *
 * This answers both, per machine - and per machine is the point, because a
 * host has its own PATH and this hub's answer says nothing about it.
 */

/**
 * How long any one probe gets before it is killed.
 *
 * Generous on purpose, and measured rather than guessed. `opencode models` was
 * about 16 seconds on Windows through the .cmd shim npm installs when this was
 * written; on opencode 1.18.29 it is nearer 38, which is how the old 30-second
 * bound came to report a CLI with no models at all rather than its 367.
 *
 * That is the argument for erring long, not for chasing the number: a tighter
 * bound does not make anything faster, it just turns a working CLI into one
 * that reports no version and no models. Nothing waits on detection - it
 * starts after the hub is already serving and the browser is told when each
 * answer lands - so the only thing a long timeout costs is a late answer from
 * a CLI that was never going to reply.
 */
const PROBE_TIMEOUT_MS = 90_000;

/** Nobody scrolls a dropdown past this, and 395 lines is a real answer. */
const MAX_MODELS = 500;

/**
 * A CLI is asked its version and its models at most once per install. The
 * version doubles as the cache key: a CLI that updated underneath us gets
 * re-listed, and one that did not is answered from here rather than by
 * spawning a process while somebody waits for a dropdown to open.
 */
interface CacheEntry {
  /** Absolute path plus version - either changing invalidates the models. */
  key: string;
  models: string[];
  source: AgentProfileInfo['modelSource'];
}

export class AgentDetector extends EventEmitter {
  private known = new Map<string, AgentProfileInfo>();
  private readonly cache = new Map<string, CacheEntry>();
  private running: Promise<AgentProfileInfo[]> | null = null;

  constructor(private readonly profiles: ProfileRegistry) {
    super();
  }

  /**
   * What is known right now, without probing anything.
   *
   * Never async, and never empty: a profile that has not been probed yet is
   * reported with `available: null`, which the panel draws as "checking".
   * Detection must not be able to hold up a hub starting or a page loading.
   */
  snapshot(): AgentProfileInfo[] {
    return this.profiles.list().map((p) => this.known.get(p.id) ?? unprobed(p));
  }

  /**
   * Probe every profile. Safe to call from anywhere, including on a timer or
   * from the browser; concurrent calls share the one run in flight rather
   * than spawning every CLI twice.
   */
  refresh(): Promise<AgentProfileInfo[]> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<AgentProfileInfo[]> {
    // In parallel: each of these is a process spawn that mostly sits waiting,
    // and doing them in series makes the first load as slow as their sum.
    const found = await Promise.all(this.profiles.list().map((p) => this.probe(p)));
    const next = new Map(found.map((info) => [info.id, info]));
    const changed = !same(this.known, next);
    this.known = next;
    if (changed) this.emit('changed', found);
    return found;
  }

  private async probe(profile: AgentProfile): Promise<AgentProfileInfo> {
    const base = unprobed(profile);
    const path = which(profile.command);
    if (!path) {
      // Stays in the list rather than vanishing: a declared agent that
      // silently disappeared looks like the config was ignored, and the
      // command that was not found is the thing worth showing.
      return {
        ...base,
        available: false,
        detail: `not found on PATH: ${profile.command}`,
      };
    }

    const version = profile.versionArgs
      ? await run(path, profile.versionArgs, profile.probeEnv).catch(() => null)
      : null;

    const key = `${path}|${version ?? ''}`;
    const cached = this.cache.get(profile.id);
    if (cached?.key === key) {
      return {
        ...base,
        available: true,
        commandPath: path,
        version,
        models: cached.models,
        modelSource: cached.source,
      };
    }

    const listed = profile.modelsArgs
      ? await run(path, profile.modelsArgs, profile.probeEnv).catch(() => null)
      : null;

    let models: string[] = [];
    let source: AgentProfileInfo['modelSource'] = 'none';
    if (listed !== null) {
      models = listed
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(0, MAX_MODELS);
      source = 'listed';
    }
    if (models.length === 0 && profile.models?.length) {
      // Either the CLI has no listing command, or its command failed. The
      // declared list is the answer in both cases.
      models = profile.models;
      source = 'declared';
    }

    this.cache.set(profile.id, { key, models, source });
    return {
      ...base,
      available: true,
      commandPath: path,
      version,
      models,
      modelSource: source,
    };
  }
}

/**
 * A profile before anything has been asked of it.
 *
 * `shell` is the exception that is born answered: it is whatever COMSPEC or
 * SHELL points at, it is always there, and there is nothing to probe.
 */
function unprobed(p: AgentProfile): AgentProfileInfo {
  const detectable = p.versionArgs !== undefined || p.modelsArgs !== undefined;
  return {
    id: p.id,
    description: p.description,
    mcp: p.mcp,
    resumable: !!p.resumeArgs,
    command: p.command,
    commandPath: null,
    available: detectable ? null : true,
    version: null,
    detail: null,
    models: p.models ?? [],
    modelSource: p.models?.length ? 'declared' : 'none',
    takesModel: p.modelArgs !== undefined,
    takesEffort: p.effortArgs !== undefined,
    efforts: p.efforts ?? [],
  };
}

/**
 * Run one probe and return its stdout.
 *
 * Timed and killed rather than awaited indefinitely: the whole promise of
 * this file is that a CLI which hangs on `--version` costs a slow dropdown
 * and not a hub that will not boot. Windows shims (.cmd/.bat) are not
 * executable images, so they go through cmd.exe exactly as spawning an agent
 * does - `shell: true` would be the short version and would also hand the
 * command line to a shell that reinterprets it.
 */
function run(path: string, args: string[], env?: Record<string, string>): Promise<string> {
  const ext = extname(path).toLowerCase();
  const viaCmd = platform === 'win32' && (ext === '.cmd' || ext === '.bat');
  const file = viaCmd ? (process.env.COMSPEC ?? 'cmd.exe') : path;
  const argv = viaCmd ? ['/c', path, ...args] : args;

  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // Inherited and then overlaid: a probe still needs PATH and HOME to
        // find and run anything at all.
        env: env ? { ...process.env, ...env } : process.env,
      },
      (err, stdout) => {
        // Some CLIs print their version and exit non-zero, or write it to
        // stderr and nothing to stdout. Stdout with content wins over the
        // exit code; nothing on stdout is a failure whatever the code said.
        const out = stdout.trim();
        if (out) resolve(out);
        else reject(err ?? new Error('no output'));
      },
    );
  });
}

/** Whether two detection results are the same, so nothing is broadcast. */
function same(
  a: Map<string, AgentProfileInfo>,
  b: Map<string, AgentProfileInfo>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y || JSON.stringify(x) !== JSON.stringify(y)) return false;
  }
  return true;
}
