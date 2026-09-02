#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Hub, HUB_VERSION } from './hub.js';
import { serve } from './server.js';
import { mintClientToken } from './agents/tokens.js';
import { paths } from './paths.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '0' },
      headless: { type: 'boolean', default: false },
      token: { type: 'string' },
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
    console.log(`aicanvas ${HUB_VERSION}

  --port <n>    port to bind on 127.0.0.1 (default: 0, meaning pick one)
  --headless    serve no web UI; used when running as a remote hub
  --token <t>   client token to use instead of generating one
  --open        print the UI url and open it in the browser
`);
    return;
  }

  mkdirSync(paths.home(), { recursive: true });
  const clientToken = values.token ?? mintClientToken();
  writeFileSync(paths.tokenFile(), clientToken, { mode: 0o600 });

  const hub = new Hub();
  const { app, origin, port } = await serve({
    hub,
    port: Number(values.port),
    clientToken,
    headless: values.headless,
  });

  const url = `${origin}/?token=${clientToken}`;
  // A remote hub is parsed by the deployer, so keep this line machine-readable.
  console.log(`aicanvas hub ${HUB_VERSION} listening on ${origin}`);
  console.log(`AICANVAS_PORT=${port}`);
  if (!values.headless) console.log(`\n  open: ${url}\n`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] saving state...`);
    // Snapshots are forced here: this is the write that makes a clean restart
    // come back with the right screens.
    hub.shutdown();
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
