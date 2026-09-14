import { rm } from 'node:fs/promises';

/**
 * Delete a temporary directory a hub was using.
 *
 * `force` only swallows "it was not there"; it does not wait for anything. On
 * Windows a PTY child just killed, or the SQLite file the hub closed a moment
 * earlier, can still hold the directory open, and rmdir comes back EBUSY.
 *
 * So: retry for a while, and if the OS still will not let go, say so and move
 * on. This runs in teardown, after every assertion in the file has already
 * passed - failing the run at that point reports a problem with the Windows
 * filesystem as though it were a problem with the hub. The directory is under
 * the system temp dir, which is cleaned up without our help.
 *
 * The retries wait asynchronously, which is why this returns a promise to
 * await. `rmSync` retried by blocking the event loop - and the handle holding
 * the directory is a PTY whose teardown needs that loop to finish. On Node 22
 * the first attempt usually won that race; on Node 24 it usually lost, and the
 * sync retries starved the release they were waiting for, for four minutes.
 */
export async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  } catch (err) {
    console.warn(`[teardown] leaving ${dir} behind: ${(err as Error).message}`);
  }
}
