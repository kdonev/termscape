import type { parseArgs } from 'node:util';

/**
 * The hub's command line, in a module of its own.
 *
 * Separate from cli.ts only because that file starts a hub the moment it is
 * imported, and this table is worth testing against. What it is tested for is
 * narrow and specific: the hub is launched by machinery rather than by hand -
 * the join installer on a machine being attached, the SSH deployer on one
 * being deployed to - and both of those put a freshly minted token on the
 * command line.
 *
 * Those tokens are base64url, and that alphabet contains `-`. Roughly one in
 * sixty-four therefore begins with a dash, and `parseArgs` in strict mode
 * refuses `--token <value>` when the value looks like another option. The
 * result was a join that installed everything correctly and then died with
 * ERR_PARSE_ARGS_INVALID_OPTION_VALUE, on about 1.5% of attempts, with no
 * obvious connection between the failure and the token that caused it.
 *
 * Every generated command line now uses `--opt=value`, which is unambiguous.
 * See cli-args.test.ts, which parses what the generators actually emit.
 */
export const CLI_OPTIONS = {
  port: { type: 'string' },
  headless: { type: 'boolean', default: false },
  token: { type: 'string' },
  listen: { type: 'string' },
  join: { type: 'string' },
  'join-token': { type: 'string' },
  label: { type: 'string' },
  /**
   * Mirror this hub's output into a file as well as its console.
   *
   * The join installer polls for the line that says the join succeeded, and
   * it has to read that from a file because the hub outlives it. Redirecting
   * the process's stdout would also produce the file, but it leaves the hub
   * with no console — which on Windows changes how the pseudoconsoles it
   * creates behave. See log-file.ts.
   */
  'log-file': { type: 'string' },
  open: { type: 'boolean', default: false },
  // parseArgs has no --no-x negation, so the opt-out is its own flag.
  'no-open': { type: 'boolean', default: false },
  version: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const satisfies NonNullable<Parameters<typeof parseArgs>[0]>['options'];
