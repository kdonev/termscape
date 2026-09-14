/**
 * The canvas in a native window: the process open-window.ts starts.
 *
 * Run as `node app-window.js <url>`. It shows the hub's own web UI in the OS
 * webview - WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux - and
 * exits 0 when the user closes it, which the hub takes as "stop". It exits
 * WINDOW_UNAVAILABLE when there is no webview to show, which the hub takes as
 * "open the browser instead".
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openInBrowser } from '../browser.js';
import { paths } from '../paths.js';
import { WINDOW_UNAVAILABLE } from './open-window.js';

/*
 * The slice of @webviewjs/webview used here, declared locally.
 *
 * The package is an optional dependency with a native binary per platform, so
 * it is absent wherever npm had no prebuilt for it. Importing its types would
 * make the hub fail to typecheck on exactly the machines this file exists to
 * degrade gracefully on.
 */
interface WebviewModule {
  Application: new () => WebviewApp;
}
interface WebviewApp {
  createBrowserWindow(options: { title: string; width: number; height: number }): {
    createWebview(options: {
      url: string;
      enableDevtools: boolean;
      clipboard: boolean;
      hotkeysZoom: boolean;
      navigationHandler: (url: string) => boolean;
    }): unknown;
  };
  on(event: 'window-close-requested' | 'application-close-requested', listener: () => void): void;
  whenReady(): Promise<void>;
  exit(): void;
}

const PACKAGE = '@webviewjs/webview';

/** Say why there is no window, and let the hub open the browser instead. */
function unavailable(what: string, err: unknown): never {
  console.error(`[app] ${what}: ${err instanceof Error ? err.message : err}`);
  if (process.platform === 'linux') {
    console.error('      the window needs WebKitGTK 4.1 and libxdo, e.g.');
    console.error('      sudo apt install libwebkit2gtk-4.1-0 libxdo3');
  }
  return process.exit(WINDOW_UNAVAILABLE);
}

async function loadWebview(): Promise<WebviewModule> {
  try {
    // A variable specifier keeps TypeScript from resolving the optional package.
    const mod = (await import(PACKAGE)) as WebviewModule & { default?: WebviewModule };
    return mod.Application ? mod : mod.default!;
  } catch (err) {
    return unavailable(`cannot load ${PACKAGE}`, err);
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error('usage: app-window <url>');
    process.exit(2);
  }
  const origin = new URL(url).origin;

  /*
   * A window onto a canvas that no longer exists should not stay open, so
   * this watches the hub that started it. By polling its pid rather than by
   * holding an IPC channel: with one open on Windows, the webview never gets
   * to handle its own close button.
   */
  const hubPid = process.ppid;
  setInterval(() => {
    try {
      process.kill(hubPid, 0);
    } catch {
      process.exit(0);
    }
  }, 1000).unref();

  /*
   * WebView2 keeps its profile beside the executable by default, and for a
   * node.exe installed under Program Files that is not writable: creating the
   * webview fails with "Access is denied". The environment variable is
   * WebView2's own override. The library's WebContext `dataDirectory` would be
   * the obvious way to say this, but with it the app never reaches ready.
   */
  if (process.platform === 'win32' && !process.env.WEBVIEW2_USER_DATA_FOLDER) {
    const dataDirectory = join(paths.home(), 'webview');
    mkdirSync(dataDirectory, { recursive: true });
    process.env.WEBVIEW2_USER_DATA_FOLDER = dataDirectory;
  }

  const { Application } = await loadWebview();
  const app = new Application();

  const close = (): void => {
    app.exit();
    process.exit(0);
  };
  app.on('window-close-requested', close);
  app.on('application-close-requested', close);

  try {
    const window = app.createBrowserWindow({ title: 'Termscape', width: 1400, height: 900 });
    window.createWebview({
      url,
      enableDevtools: true,
      clipboard: true,
      // Left on, though the canvas does its own zooming. On Windows wry ties
      // WebView2's pinch zoom to this same switch, and with pinch off Chromium
      // never turns a touchpad pinch into the ctrl+wheel stream the canvas
      // zooms on. The page zoom it would otherwise do is not a risk: the
      // canvas preventDefaults every ctrl+wheel it takes, as in a browser tab.
      hotkeysZoom: true,
      // The window shows the canvas and nothing else. Links out of it - the
      // bug report, anything opened with target="_blank" - go to the browser.
      navigationHandler: (target) => {
        let parsed: URL;
        try {
          parsed = new URL(target);
        } catch {
          return false;
        }
        if (parsed.origin === origin || parsed.protocol === 'about:') return true;
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') openInBrowser(target);
        return false;
      },
    });
  } catch (err) {
    // Nothing has been shown yet, so a tab is still a fair substitute.
    unavailable('cannot open a webview', err);
  }

  await app.whenReady();
}

main().catch((err) => {
  console.error('[app]', err);
  process.exit(1);
});
