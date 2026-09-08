#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Hub, HUB_VERSION } from './hub.js';
import { serve, MEMORABLE_PORTS } from './server.js';
import { mintClientToken } from './agents/tokens.js';
import { paths } from './paths.js';
import { listenPlan } from './remote/lan.js';
import { joinCanvas, type JoinLink } from './remote/join.js';
import { openInBrowser } from './browser.js';
import { ProfileRegistry } from './agents/profiles.js';
import { which } from './agents/resolve.js';

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string' },
      headless: { type: 'boolean', default: false },
      token: { type: 'string' },
      listen: { type: 'string' },
      join: { type: 'string' },
      'join-token': { type: 'string' },
      label: { type: 'string' },
      open: { type: 'boolean', default: false },
      // parseArgs has no --no-x negation, so the opt-out is its own flag.
      'no-open': { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

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
  --open            open the UI in the browser even when not on a terminal
  --no-open         do not open the browser; just print the url

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

  /*
   * Opening the canvas is the default, not a flag.
   *
   * The URL carries a token, so it is long and cannot be retyped - leaving
   * the user to copy it out of scrollback is most of the friction in a
   * one-command install. A headless hub has no UI to open, and a hub started
   * by a script or a supervisor has nobody watching, which is what the TTY
   * check stands in for. --open overrides that check; --no-open beats both.
   */
  const wantsBrowser =
    !values.headless &&
    !values['no-open'] &&
    (values.open || process.stdout.isTTY === true);
  if (wantsBrowser) openInBrowser(url);

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
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] saving state...`);
    // Snapshots are forced here: this is the write that makes a clean restart
    // come back with the right screens.
    link?.stop();
    hub.shutdown();
    try {
      rmSync(paths.pidFile(), { force: true });
    } catch {
      // Best effort; a stale pid file is handled by whoever reads it.
    }
    try {
      await app.close();
    } catch {
      // Server already down.
    }
    // node-pty on ConPTY keeps handles that can hold the loop open past close.
    process.exit(0);
  };

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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
