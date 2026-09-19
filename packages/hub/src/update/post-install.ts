/**
 * The step between a hub and its update, for a global install.
 *
 * Started by the supervisor once the old hub has exited - by then nothing
 * holds the package's native modules open, which is what lets Windows replace
 * them. It installs the release, then exits with EXIT_RESTART and a plan to
 * start the hub from the same place it always ran from. If the install fails,
 * the plan starts the old hub again instead, carrying the error so the canvas
 * can say what happened rather than simply not having updated.
 *
 *   node post-install.js <version> <cli.js> [hub args...]
 */
import { spawnSync } from 'node:child_process';
import { EXIT_RESTART, writeRestartPlan } from './restart.js';
import { PACKAGE_NAME, npmCliPath } from './install.js';

const [version, cliPath, ...args] = process.argv.slice(2);
if (!version || !cliPath) {
  console.error('usage: post-install.js <version> <cli.js> [hub args...]');
  process.exit(1);
}

const spec = `${PACKAGE_NAME}@${version}`;
console.log(`[termscape] installing ${spec}`);
const npm = npmCliPath();
const npmArgs = ['install', '-g', '--no-audit', '--no-fund', spec];
const result = npm
  ? spawnSync(process.execPath, [npm, ...npmArgs], { stdio: 'inherit' })
  : spawnSync('npm', npmArgs, { stdio: 'inherit', shell: process.platform === 'win32' });

const failed =
  result.error?.message ??
  (result.status === 0 ? null : `npm install -g exited with ${result.status}`);
if (failed) {
  console.error(`[termscape] update failed: ${failed}; starting the version already installed`);
}

writeRestartPlan({
  command: process.execPath,
  args: [cliPath, ...args],
  ...(failed ? { env: { TERMSCAPE_UPDATE_ERROR: `could not install ${spec}: ${failed}` } } : {}),
});
process.exit(EXIT_RESTART);
