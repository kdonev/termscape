import { rmSync } from 'node:fs';

/**
 * Delete a temporary directory a hub was using.
 *
 * `force` only swallows "it was not there"; it does not wait for anything.
 * On Windows a PTY child that has just been killed, or the SQLite file the
 * hub closed a moment ago, can still hold the directory open long enough for
 * rmdir to come back EBUSY - so teardown has to be allowed to retry rather
 * than fail a run that has already passed every assertion in it.
 */
export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
