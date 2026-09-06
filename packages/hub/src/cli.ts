#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Hub, HUB_VERSION } from './hub.js';
import { serve, MEMORABLE_PORTS } from './server.js';
import { mintClientToken } from './agents/tokens.js';
import { paths } from './paths.js';
import { resolveBindHost } from './remote/lan.js';
import { joinCanvas, type JoinLink } from './remote/join.js';

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
  --listen <addr>   bind address; "lan" picks this machine's own address so
                    other machines can open the join page. Default: loopback
  --headless        serve no web UI; used when running as a remote hub
  --token <t>       client token to use instead of generating one
  --open            print the UI url and open it in the browser

Joining another machine's canvas:

  --join <url>      dial that hub and put this machine on its canvas
  --join-token <t>  single-use token from its join page; not needed once
                    this machine has enrolled once
  --label <name>    how to name this machine there (default: hostname)
`);
    return;
  }

  mkdirSync(paths.home(), { recursive: true });
  const clientToken = values.token ?? mintClientToken();
  writeFileSync(paths.tokenFile(), clientToken, { mode: 0o600 });
  // The join installer reads this to stop a previous hub before replacing its
  // files; on Windows a loaded .node cannot be deleted while it runs.
  writeFileSync(paths.pidFile(), String(process.pid));

  const bindHost = values.listen ? resolveBindHost(values.listen) : undefined;

  const hub = new Hub();
  const { app, origin, enrollOrigin, enrollAltOrigin, port, peerServer } = await serve({
    hub,
    host: bindHost,
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
  if (!values.headless) console.log(`\n  open:   ${url}`);
  // The canvas is worth opening from a phone or a second screen, and that
  // needs the token too - so offer the whole URL, not just the host.
  if (!values.headless && enrollOrigin) {
    console.log(`       or ${enrollOrigin}/?token=${clientToken}`);
  }
  if (enrollOrigin) {
    // Say plainly what binding wider actually did. Every other route still
    // requires the token, but the hub is on the network either way now.
    console.log(`  enroll: ${enrollOrigin}/join`);
    // If the name does not resolve on the other machine, the IP always will.
    if (enrollAltOrigin) console.log(`       or ${enrollAltOrigin}/join`);
    console.log(`          reachable from your network — anyone who can load`);
    console.log(`          that page can attach a machine to this canvas`);
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
