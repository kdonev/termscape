import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { InstallKind } from '@termscape/protocol';

/** What the package is called on the registry. */
export const PACKAGE_NAME = '@kdonev/termscape';

/** A path compared the same way on every platform. */
function norm(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * Whether this file sits inside an installed copy of the published package,
 * as opposed to a checkout. The one thing the supervisor needs to know, and it
 * is decided from the path alone because the supervisor must not spend a
 * second asking npm before the hub has even started.
 */
export function isInstalledPackage(cliPath: string): boolean {
  return norm(cliPath).includes(`/node_modules/${PACKAGE_NAME}/`);
}

/**
 * How this hub came to be running, which is how it can replace itself.
 *
 * A global install is told apart from a copy inside somebody's project by
 * the shim npm puts beside it: `<prefix>/termscape.cmd` on Windows,
 * `<prefix>/bin/termscape` beside `<prefix>/lib/node_modules` elsewhere. The
 * project copy cannot be updated by `npm install -g`, which would install a
 * second copy nothing runs.
 *
 * Read off the disk rather than asked of `npm root -g`, whose answer npm
 * redacts: a path segment that looks like a token, a UUID say, comes back as
 * `***` and then matches nothing.
 */
export function installKind(
  cliPath: string,
  opts: { joined: boolean; exists?: (p: string) => boolean; platform?: NodeJS.Platform },
): InstallKind {
  if (opts.joined) return 'host';
  if (!isInstalledPackage(cliPath)) return 'source';
  if (norm(cliPath).includes('/_npx/')) return 'npx';

  const exists = opts.exists ?? existsSync;
  const slashed = cliPath.replace(/\\/g, '/');
  const at = slashed.toLowerCase().lastIndexOf(`/node_modules/${PACKAGE_NAME}/`);
  const modules = slashed.slice(0, at + '/node_modules'.length);
  const prefix = posix.dirname(modules);
  const global =
    (opts.platform ?? process.platform) === 'win32'
      ? exists(`${prefix}/termscape.cmd`)
      : posix.basename(prefix) === 'lib' && exists(`${posix.dirname(prefix)}/bin/termscape`);
  return global ? 'global' : 'source';
}

/**
 * npm's own entry point, run with this Node rather than through `npm` on the
 * PATH: on Windows that is npm.cmd, which cannot be spawned without a shell,
 * and a shell drags its quoting rules into every argument. Null when npm is
 * not where Node's own distribution puts it.
 */
export function npmCliPath(nodeExe = process.execPath): string | null {
  const dir = dirname(nodeExe);
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX layout
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Run npm and collect its stdout. Rejects with its output on a non-zero exit. */
export function runNpm(args: string[], timeoutMs = 5 * 60_000): Promise<string> {
  const cli = npmCliPath();
  const [cmd, argv, shell] = cli
    ? [process.execPath, [cli, ...args], false]
    : ['npm', args, process.platform === 'win32'];
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      argv,
      { timeout: timeoutMs, shell, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = `${stderr}`.trim().split('\n').slice(-5).join('\n');
          reject(new Error(`npm ${args[0]} failed: ${detail || err.message}`));
          return;
        }
        resolve(`${stdout}`);
      },
    );
  });
}
