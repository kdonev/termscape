import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Exit code the window process uses to say "there is no webview to open",
 * as opposed to a window that opened and then failed. The first is a reason to
 * fall back to the browser; the second is not, because the user already saw
 * one window come and go and a browser tab appearing after it would be a
 * surprise rather than a rescue.
 */
export const WINDOW_UNAVAILABLE = 3;

export type WindowOutcome = 'closed' | 'unavailable' | 'crashed';

/** What a window process's exit means for the hub that started it. */
export function windowOutcome(code: number | null, signal: NodeJS.Signals | null): WindowOutcome {
  if (signal === null && code === 0) return 'closed';
  if (signal === null && code === WINDOW_UNAVAILABLE) return 'unavailable';
  return 'crashed';
}

export interface WindowHandlers {
  /** The user closed the window. */
  onClosed: () => void;
  /** No native webview could be loaded here; nothing was shown. */
  onUnavailable: () => void;
  /** The window process died some other way. */
  onCrashed: (why: string) => void;
}

/**
 * The window's entry point, beside this module.
 *
 * Built, that is dist/window/app-window.js. Under `npm run dev` this module is
 * src/window/open-window.ts run through tsx, and there is no .js beside it -
 * so the extension is taken from this file rather than assumed.
 */
function windowScript(): string {
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return fileURLToPath(new URL(`./app-window${ext}`, import.meta.url));
}

/**
 * The Node flags the window inherits: whatever loader the hub itself runs
 * under, which is how a .ts window loads under tsx. An inspector flag is left
 * behind, since two processes cannot both take its port.
 */
export function childExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  return execArgv.filter((arg) => !/^--inspect(-brk|-wait)?(=|$)/.test(arg));
}

/**
 * Open the canvas in a native window of its own.
 *
 * The window is a separate Node process running app-window.js, not a webview
 * inside the hub. A native crash in the webview then costs a window rather than
 * every agent on the canvas, macOS gets a process whose main thread belongs to
 * its UI, and a hub that never opens a window never loads the native module.
 *
 * The child is not detached, and watches this process's pid so that it closes
 * when the hub goes away.
 */
export function openAppWindow(
  url: string,
  handlers: WindowHandlers,
  script: string = windowScript(),
): void {
  let settled = false;
  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };

  const child = spawn(process.execPath, [...childExecArgv(), script, url], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  // Spawning node itself failing is as good as having no webview: the browser
  // can still show the canvas.
  child.on('error', () => settle(handlers.onUnavailable));
  child.on('exit', (code, signal) => {
    settle(() => {
      switch (windowOutcome(code, signal)) {
        case 'closed':
          return handlers.onClosed();
        case 'unavailable':
          return handlers.onUnavailable();
        case 'crashed':
          return handlers.onCrashed(signal ?? `exit code ${code}`);
      }
    });
  });
}
