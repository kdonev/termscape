import { spawn } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';

/**
 * Update a machine joined to a canvas, to the build that canvas runs.
 *
 * It runs the canvas's own join installer again, which already knows how to
 * do every part of this - stop the hub that is running (this one), swap the
 * install while keeping the dependency tree where it can, start the new hub
 * and wait for it to rejoin. The installer carries a fresh join key, but the
 * host token already on disk is tried first, so this machine comes back as
 * itself rather than as a second machine.
 *
 * The installer is started detached, because it outlives this process by
 * design: the first thing it does is stop it. Its output goes to
 * update.log beside the hub's own, which is the one place to look when a
 * machine was told to update and never came back.
 *
 * Resolves once the installer is fetched and running.
 */
export async function runHostUpdate(
  hubUrl: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const windows = platform === 'win32';
  const origin = new URL(hubUrl).origin;
  const res = await fetch(`${origin}/${windows ? 'join.ps1' : 'join.sh'}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`the canvas answered ${res.status} for its installer`);
  const script = await res.text();

  const home = paths.home();
  const file = join(home, windows ? 'update.ps1' : 'update.sh');
  writeFileSync(file, script, { mode: 0o700 });

  const log = openSync(join(home, 'update.log'), 'w');
  try {
    const [command, args] = windows
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]]
      : ['sh', [file]];
    const child = spawn(command, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      // The installer reads TERMSCAPE_HOME to find the install it replaces.
      env: { ...process.env, TERMSCAPE_HOME: home },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
    child.unref();
  } finally {
    closeSync(log);
  }
}
