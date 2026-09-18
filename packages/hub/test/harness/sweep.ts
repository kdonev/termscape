/**
 * Kills worker hubs a previous live run left behind, before and after this one.
 *
 * The harness already cleans up after itself twice - `afterAll` and a
 * `process.once('exit')` hook. Neither survives the case this file exists for:
 * a run killed with Ctrl+C, or a vitest fork terminated outright, where no
 * handler in that process gets to run at all. A worker hub that outlives its
 * canvas does not stop on its own - `joinCanvas` reconnects forever - so it
 * sits there holding a port and a `claude` process until someone notices.
 *
 * Scoped by pid file, never by name. It looks only inside the temp
 * directories the harness itself created, reads the pid the hub wrote there,
 * and kills it only if that process's command line still points at the same
 * directory. So a developer's real hub under ~/.termscape cannot be caught by
 * this, whatever it is called - which is the hazard the equivalent code in
 * `remote/join-script.ts` warns about at length.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree } from '../tmp.js';

/**
 * The prefixes the harness gives its temp directories. Keep in step with
 * `startLiveCanvas`.
 *
 * All of them, not just the worker homes: a killed run also strands the
 * canvas home, the workspace roots, and - the one that matters most - the
 * throwaway Claude Code config, which holds a copy of the OAuth token. None of
 * that should outlive the run that made it.
 */
const LIVE_TAG = 'termscape-live';
/** Worker homes specifically: the only ones with a hub process to stop. */
const WORKER_TAG = 'termscape-live-worker';

export async function setup(): Promise<void> {
  await sweep('before');
}

export async function teardown(): Promise<void> {
  await sweep('after');
}

async function sweep(when: string): Promise<void> {
  const dirs = findLiveDirs();
  if (dirs.length === 0) return;

  // Worker homes first: a directory cannot be removed while the hub inside it
  // still holds its database open.
  const commandLines = processTable();
  let killed = 0;
  for (const dir of dirs) {
    if (!dir.startsWith(join(tmpdir(), WORKER_TAG))) continue;
    const pid = readPid(dir);
    // A directory with no live hub in it is just litter; remove it below.
    if (pid !== null && ownsDirectory(commandLines, pid, dir)) {
      treeKill(pid);
      killed += 1;
    }
  }
  for (const dir of dirs) await removeTree(dir);

  console.log(
    `[live-sweep] ${when}: removed ${dirs.length} leftover director${dirs.length === 1 ? 'y' : 'ies'}` +
      (killed > 0 ? `, stopped ${killed} stray worker hub(s)` : ''),
  );
}

function findLiveDirs(): string[] {
  const root = tmpdir();
  try {
    return readdirSync(root)
      .filter((name) => name.startsWith(LIVE_TAG))
      .map((name) => join(root, name));
  } catch {
    // No temp directory to read is not a failure worth stopping a test run for.
    return [];
  }
}

function readPid(home: string): number | null {
  const file = join(home, 'hub.pid');
  if (!existsSync(file)) return null;
  const pid = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Every running process's command line, by pid.
 *
 * One call rather than one per candidate: the point is to check the pid has
 * not been reused by something unrelated since the hub wrote it down, and a
 * single snapshot answers that for all of them.
 */
function processTable(): Map<number, string> {
  const out = new Map<number, string>();
  const run =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8', windowsHide: true },
        )
      : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });

  for (const line of (run.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)[\t ]+(.*)$/.exec(line);
    if (match) out.set(Number(match[1]), match[2]!);
  }
  return out;
}

/** Whether the process holding this pid is still the hub that wrote it. */
function ownsDirectory(table: Map<number, string>, pid: number, home: string): boolean {
  const command = table.get(pid);
  if (command === undefined) return false;
  return command.includes(home) || command.includes(WORKER_TAG);
}

function treeKill(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      // The harness starts workers detached, so the pid is its group leader.
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Gone between the snapshot and now, which is the outcome we wanted.
  }
}
