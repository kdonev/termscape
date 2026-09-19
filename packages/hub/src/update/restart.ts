import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';

/**
 * The exit code a supervised hub uses to say "start me again, as the restart
 * plan says". 75 is EX_TEMPFAIL: nothing else in the hub exits with it.
 */
export const EXIT_RESTART = 75;

/** What the supervisor runs next, written by the hub on its way out. */
export interface RestartPlan {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function restartFile(): string {
  return join(paths.home(), 'restart.json');
}

export function writeRestartPlan(plan: RestartPlan): void {
  writeFileSync(restartFile(), JSON.stringify(plan));
}

/** Read and remove the plan, so a stale one can never start anything twice. */
export function takeRestartPlan(): RestartPlan | null {
  const file = restartFile();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  try {
    const plan = JSON.parse(raw) as RestartPlan;
    if (typeof plan.command !== 'string' || !Array.isArray(plan.args)) return null;
    return plan;
  } catch {
    return null;
  }
}

const PINNED = ['--port', '--token'];

/**
 * The command line the updated hub starts with: the one this hub was given,
 * pinned to the port and token it actually ended up with.
 *
 * Pinned because a canvas already open - in the app window about to be
 * replaced, in a browser tab, on a phone - holds a URL with both in it, and
 * reconnects to that URL on its own if the new hub is where the old one was.
 * A browser tab needs no second tab opened beside it, so `--browser` becomes
 * `--no-open` too; the app window closes with the hub that owned it and the
 * new hub opens its own.
 */
export function restartArgs(argv: readonly string[], pin: { port: number; token: string }): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.split('=')[0]!;
    if (PINNED.includes(name)) {
      if (!arg.includes('=')) i++; // `--port 7777`: skip the value too
      continue;
    }
    out.push(arg);
  }
  if (out.includes('--browser') && !out.includes('--no-open')) out.push('--no-open');
  out.push(`--port=${pin.port}`, `--token=${pin.token}`);
  return out;
}
