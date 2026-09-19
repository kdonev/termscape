#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CLI_OPTIONS } from './cli-args.js';
import { shouldSupervise, supervise } from './supervisor.js';

/*
 * Deliberately almost empty. Deciding whether this process is the hub or the
 * supervisor that runs it has to happen before anything loads a native
 * module: the supervisor outlives every hub it starts, and on Windows a
 * global update cannot replace a .node file any live process has loaded. So
 * the hub is imported only on the branch that runs it.
 */
async function run(): Promise<void> {
  const { values } = parseArgs({ options: CLI_OPTIONS, strict: true });
  const cliPath = fileURLToPath(import.meta.url);
  if (shouldSupervise(values, cliPath)) {
    await supervise(cliPath);
    return;
  }
  const { main } = await import('./main.js');
  await main(values, cliPath);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
