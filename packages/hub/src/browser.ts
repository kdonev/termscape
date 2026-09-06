import { spawn } from 'node:child_process';
import { platform } from 'node:process';

/**
 * Open a URL in the user's default browser, best effort.
 *
 * The canvas lives at a URL carrying a token, which makes it long and
 * impossible to retype. Printing it and hoping the terminal linkifies it is
 * the difference between "run one command" and "run one command, then find the
 * URL, then copy exactly the right part of it".
 *
 * Never throws and never blocks: a hub that failed to open a browser is still
 * a working hub, and the URL is printed either way.
 */
export function openInBrowser(url: string): void {
  // Windows has no opener binary; `start` is a cmd.exe builtin, and its first
  // quoted argument is taken as the window title, so it needs an empty one
  // before the URL.
  const [command, args] =
    platform === 'win32'
      ? [process.env.COMSPEC ?? 'cmd.exe', ['/c', 'start', '""', url]]
      : platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // A browser that outlives the hub is the point; do not hold the loop open
    // for it, and do not let a missing xdg-open reach uncaughtException.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Nothing to do: the URL is on stdout regardless.
  }
}
