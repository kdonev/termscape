import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Hub, HUB_VERSION } from './hub.js';
import { serve, MEMORABLE_PORTS } from './server.js';
import { mintClientToken } from './agents/tokens.js';
import { paths } from './paths.js';
import { listenPlan } from './remote/lan.js';
import { joinCanvas, type JoinLink } from './remote/join.js';
import { openInBrowser } from './browser.js';
import { openAppWindow } from './window/open-window.js';
import { ProfileRegistry } from './agents/profiles.js';
import { which } from './agents/resolve.js';
import { debugTopics } from './debug.js';
import type { CliValues } from './cli-args.js';
import { Updater } from './update/updater.js';
import { installKind } from './update/install.js';
import { EXIT_RESTART, restartArgs, writeRestartPlan } from './update/restart.js';
import { runHostUpdate } from './update/host.js';
import { resumeFile } from './update/resume.js';
import { announceExit } from './supervisor.js';

/** How long shutdown waits for open connections to close. See `shutdown`. */
const SERVER_CLOSE_DEADLINE_MS = 2000;

/**
 * Warn when no agent CLI is installed.
 *
 * Without this the first thing a new user does - start an agent - fails inside
 * a terminal window on the canvas, where the error is easy to miss and reads
 * like the hub is broken. Checking every profile that wires up MCP, rather
 * than "claude" specifically, keeps a custom ~/.termscape/agents.toml counted.
 */
function preflightAgents(): void {
  const agents = ProfileRegistry.load()
    .list()
    .filter((profile) => profile.mcp);
  if (agents.length === 0) return;
  if (agents.some((profile) => which(profile.command))) return;

  const names = agents.map((profile) => profile.command).join(', ');
  console.error(`[warn] no agent CLI found on PATH (looked for: ${names})`);
  console.error('       install one - https://claude.com/claude-code - or set');
  console.error('       an absolute "command" in ~/.termscape/agents.toml.');
  console.error('       Terminals with the "shell" profile still work.');
  console.error('');
}

/**
 * The hub itself. `cliPath` is the entry point it was started from, which is
 * how it tells an npx run from a global install from a checkout.
 */
export async function main(values: CliValues, cliPath: string): Promise<void> {

  if (values.version) {
    console.log(HUB_VERSION);
    return;
  }
  if (values.help) {
    console.log(`termscape ${HUB_VERSION}

  --port <n>        port to bind; 0 lets the OS pick. Default: the first
                    free memorable port (7777, 4242, ...)
  --listen <addr>   bind address. Default: every interface, so the canvas is
                    reachable from your network with its token and another
                    machine can attach from the join page - the one page
                    served *without* the token. "loopback" keeps the hub to
                    this machine, and turns that page off with it
  --headless        serve no web UI; used when running as a remote hub
  --token <t>       client token to use instead of generating one
  --open            open the canvas even when not on a terminal
  --no-open         do not open the canvas; just print the url
  --browser         open the canvas in the browser instead of its own
                    window. Closing that window stops the hub; closing a
                    browser tab does not
  --no-update-check do not ask npm whether a newer termscape is out

Joining another machine's canvas:

  --join <url>      dial that hub and put this machine on its canvas
  --join-token <t>  single-use token from its join page; not needed once
                    this machine has enrolled once
  --label <name>    how to name this machine there (default: hostname)
`);
    return;
  }

  preflightAgents();

  mkdirSync(paths.home(), { recursive: true });
  const clientToken = values.token ?? mintClientToken();
  writeFileSync(paths.tokenFile(), clientToken, { mode: 0o600 });
  // The join installer reads this to stop a previous hub before replacing its
  // files; on Windows a loaded .node cannot be deleted while it runs.
  writeFileSync(paths.pidFile(), String(process.pid));

  const plan = listenPlan(values.listen, { headless: values.headless });

  const hub = new Hub();
  const {
    app,
    origin,
    lanOrigin,
    lanAltOrigin,
    enrollOrigin,
    enrollAltOrigin,
    port,
    peerServer,
  } = await serve({
    hub,
    host: plan.host,
    enroll: plan.enroll,
    // The join page has to be typed by hand on another machine, so prefer a
    // port worth remembering unless one was asked for explicitly.
    port: values.port === undefined ? MEMORABLE_PORTS : Number(values.port),
    clientToken,
    headless: values.headless,
  });

  const url = `${origin}/?token=${clientToken}`;
  // A remote hub is parsed by the deployer, so keep this line machine-readable.
  console.log(`termscape hub ${HUB_VERSION} listening on ${origin}`);
  console.log(`TERMSCAPE_PORT=${port}`);
  // Said out loud because it is easy to leave on, and because a remote
  // session only traces if the hub on the *other* machine was started with
  // it too - a half-traced path is what makes an input look lost.
  const traced = debugTopics();
  if (traced.length > 0) {
    console.log(`  tracing: ${traced.join(', ')} (TERMSCAPE_DEBUG)`);
  }

  /*
   * Binding wide and answering the join page is the default now, which makes
   * it news rather than a confirmation - so it is said first, before the URLs,
   * and it says what it costs before it says what it buys. The old banner put
   * this last, where it read as an acknowledgement of something the operator
   * had just typed.
   *
   * The way out is printed on the enrolling path too, not only the other one.
   * It is the branch where somebody might want it.
   */
  if (!values.headless && lanOrigin) {
    const where = lanOrigin.replace(/^http:\/\//, '');
    console.log(`\n  on your network at ${where}`);
    if (enrollOrigin) {
      console.log(`          anyone who can reach it can load the join page and`);
      console.log(`          attach a machine to this canvas. Everything else`);
      console.log(`          needs the token below.`);
      console.log(`          --listen loopback keeps the hub to this machine.`);
    } else {
      console.log(`          the canvas needs the token below, so this is worth`);
      console.log(`          opening on a phone or a second screen.`);
      console.log(`          --listen loopback keeps the hub to this machine.`);
    }
  }

  if (!values.headless) console.log(`\n  open:   ${url}`);
  // The canvas is worth opening from a phone or a second screen, and that
  // needs the token too - so offer the whole URL, not just the host.
  if (!values.headless && lanOrigin) {
    console.log(`       or ${lanOrigin}/?token=${clientToken}`);
    // If the name does not resolve on the other machine, the IP always will.
    if (lanAltOrigin) console.log(`       or ${lanAltOrigin}/?token=${clientToken}`);
  }

  if (enrollOrigin) {
    console.log(`\n  enroll: ${enrollOrigin}/join`);
    if (enrollAltOrigin) console.log(`       or ${enrollAltOrigin}/join`);
  } else if (!values.headless) {
    // Only two ways to get here now that the default enrolls: the operator
    // asked for loopback, or this machine has no address anyone could reach it
    // on. Saying which is the difference between a setting they chose and a
    // network they need to go and look at.
    const why =
      values.listen === undefined
        ? 'this machine has no address another machine could reach it on'
        : 'this hub is bound to loopback';
    console.log(`\n  no join page: ${why}`);
  }
  if (!values.headless) console.log('');

  // The canvas hub asks us to stop when the user drops this host, so the
  // machine does not keep a hub running that belongs to nobody.
  // A join that was refused cannot be retried into working, and this hub was
  // started only to join. Stopping frees its install for a re-run.
  hub.on('joinFailed', (message: string) => {
    console.error(`[join] cannot join: ${message}`);
    void shutdown('join failed');
  });

  hub.on('peerShutdown', () => {
    console.log('\n[peer] the canvas dropped this host; stopping');
    void shutdown('peer');
  });

  /*
   * The canvas telling this machine to take its build. Only a joined hub can:
   * it knows the canvas to fetch from, and the installer that does the work
   * is the one it was installed by in the first place.
   */
  const joinUrl = values.join;
  if (joinUrl) {
    hub.on('peerUpdate', (answer: (failure: string | null) => void) => {
      console.log('\n[peer] the canvas asked this machine to update; handing over to its installer');
      // Before the installer stops this hub: the one it starts resumes them.
      hub.rememberRunning();
      runHostUpdate(joinUrl).then(
        () => answer(null),
        (err: Error) => {
          // Nothing is going to restart, so nothing is waiting to resume.
          rmSync(resumeFile(), { force: true });
          answer(`could not start the update here: ${err.message}`);
        },
      );
    });
  }

  let link: JoinLink | null = null;
  if (values.join) {
    link = joinCanvas({
      hub,
      peerServer,
      hubUrl: values.join,
      joinToken: values['join-token'],
      label: values.label,
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] saving state...`);
    // Snapshots are forced here: this is the write that makes a clean restart
    // come back with the right screens.
    try {
      link?.stop();
      hub.shutdown();
    } catch (err) {
      // Stopping is the one thing this must not fail at. A throw here used to
      // skip the exit below and leave the hub up with nothing to stop it.
      console.error('[shutdown]', err instanceof Error ? err.message : err);
    }
    try {
      rmSync(paths.pidFile(), { force: true });
    } catch {
      // Best effort; a stale pid file is handled by whoever reads it.
    }
    /*
     * Closing the server is given a deadline rather than waited out. It waits
     * for every websocket to finish its close handshake, and a client that
     * never answers - a tab on a laptop that went to sleep, a machine on the
     * other end of a dead link, anything that opened a socket and went quiet -
     * held it open indefinitely. The canvas window had gone, the terminal was
     * still held, and only Ctrl+C gave it back. State is already saved by now;
     * all that is left to lose is a goodbye nobody is listening for.
     */
    await Promise.race([
      app.close().catch(() => {
        // Server already down.
      }),
      new Promise((resolve) => setTimeout(resolve, SERVER_CLOSE_DEADLINE_MS).unref()),
    ]);
    // node-pty on ConPTY keeps handles that can hold the loop open past close,
    // and on Windows has been seen to hold process.exit itself. Saying so
    // first lets a supervisor finish the job.
    await announceExit(exitCode);
    process.exit(exitCode);
  };

  // A hub replaced by this one for an update left behind which agents it was
  // running. Bring them back, now that there is a hub to run them.
  void hub.resumeRemembered().then((resumed) => {
    if (resumed.length > 0) console.log(`[update] resumed ${resumed.join(', ')}`);
  });

  startUpdater({
    hub,
    values,
    cliPath,
    port,
    clientToken,
    restart: (plan) => {
      hub.rememberRunning();
      writeRestartPlan(plan);
      void shutdown('update', EXIT_RESTART);
    },
  });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown(sig));
  }
  process.on('uncaughtException', (err) => {
    console.error('[fatal]', err);
    void shutdown('uncaughtException');
  });

  // Node escalates an unhandled rejection to uncaughtException, which above
  // stops the hub. A peer refusing a request is a normal thing that must not
  // cost the user every agent running on this machine, so it is logged and
  // survived instead. Call sites still catch their own; this is the net.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandled]', reason instanceof Error ? reason.message : reason);
  });

  /*
   * Opening the canvas is the default, not a flag.
   *
   * The URL carries a token, so it is long and cannot be retyped - leaving
   * the user to copy it out of scrollback is most of the friction in a
   * one-command install. A headless hub has no UI to open, and a hub started
   * by a script or a supervisor has nobody watching, which is what the TTY
   * check stands in for. --open overrides that check; --no-open beats both.
   *
   * What opens is a window of the canvas's own, which is the app: closing it
   * stops the hub, as Ctrl+C would. --browser asks for a tab instead, and a
   * machine with no webview to show gets one anyway rather than nothing.
   * Opened after `shutdown` exists, since closing the window calls it.
   */
  const wantsCanvas =
    !values.headless &&
    !values['no-open'] &&
    (values.open || process.stdout.isTTY === true);
  if (wantsCanvas && values.browser) {
    openInBrowser(url);
  } else if (wantsCanvas) {
    openAppWindow(url, {
      onClosed: () => void shutdown('window closed'),
      onUnavailable: () => {
        console.error('[app] no native window here; opening the browser instead');
        openInBrowser(url);
      },
      onCrashed: (why) => {
        console.error(`[app] the window exited (${why}); the hub is still running at ${url}`);
      },
    });
  }
}


/**
 * Look for newer releases, and be ready to install one when asked.
 *
 * Only a hub that has a canvas of its own looks: a headless hub is a joined
 * machine, which takes its canvas's build rather than npm's, and anyone who
 * would rather not be told can say so.
 */
function startUpdater(opts: {
  hub: Hub;
  values: CliValues;
  cliPath: string;
  port: number;
  clientToken: string;
  restart: (plan: import('./update/restart.js').RestartPlan) => void;
}): void {
  const { hub, values } = opts;
  const initialError = process.env.TERMSCAPE_UPDATE_ERROR ?? null;
  // It has been read; the agents this hub starts have no use for it.
  delete process.env.TERMSCAPE_UPDATE_ERROR;
  if (initialError) console.error(`[update] ${initialError}`);

  const optedOut =
    values['no-update-check'] || process.env.TERMSCAPE_NO_UPDATE_CHECK === '1';
  if (values.headless || values.join || optedOut) return;

  const updater = new Updater({
    currentVersion: HUB_VERSION,
    kind: installKind(opts.cliPath, { joined: false }),
    canRestart: process.env.TERMSCAPE_SUPERVISED === '1',
    cliPath: opts.cliPath,
    restartArgs: () =>
      restartArgs(process.argv.slice(2), { port: opts.port, token: opts.clientToken }),
    restart: opts.restart,
    initialError,
  });
  hub.updater = updater;
  updater.on('change', (info) => hub.emit('update', info));
  hub.emit('update', updater.info());
  updater.start();
}
