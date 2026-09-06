import { rmSync } from 'node:fs';

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
 */
export function removeTree(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
  } catch (err) {
    console.warn(`[teardown] leaving ${dir} behind: ${(err as Error).message}`);
  }
}
