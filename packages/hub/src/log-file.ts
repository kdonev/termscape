import { openSync, writeSync } from 'node:fs';

/**
 * Mirror the hub's own output into a file, without taking it off the console.
 *
 * The join installer waits for this hub to report `TERMSCAPE_JOINED=`, and it
 * reads that out of a file rather than a pipe, because the hub outlives the
 * installer. Redirecting the process's stdout was the obvious way to produce
 * that file, and it is what the installer used to do — at the cost of leaving
 * the hub with no console of its own.
 *
 * That cost turned out to be load-bearing on Windows. A pseudoconsole created
 * by a process that has no console behaves differently from one created by a
 * process that has one, and the difference reaches all the way to the agent:
 * on Windows 10 an agent launched that way never enables mouse reporting, so
 * a wheel over its window does nothing at all. Keeping the console and writing
 * the file separately costs one file descriptor and settles it.
 *
 * Deliberately synchronous. These are a handful of lines at startup and the
 * installer is polling for one of them; a buffered stream that flushes after
 * the poll gives up is worse than the write blocking for a microsecond.
 */
export function teeConsoleTo(path: string): void {
  // 'a' rather than 'w': a rejoin appends to the record instead of erasing the
  // reason the last attempt failed, which is usually what someone is looking
  // for when they run the installer a second time.
  const fd = openSync(path, 'a');

  const tee = (original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      original(...args);
      try {
        writeSync(fd, args.map(String).join(' ') + '\n');
      } catch {
        // A full disk or a deleted file must not take the hub down; the
        // console half of this has already succeeded.
      }
    };

  console.log = tee(console.log.bind(console));
  console.error = tee(console.error.bind(console));
}
