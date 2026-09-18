import { defineConfig } from 'vitest/config';

/**
 * The live suite: real hubs, real agent CLIs, real tokens spent.
 *
 * Kept behind its own config and its own file suffix rather than an env check
 * alone. `vitest.config.ts` collects `*.test.ts`, so a `*.live-test.ts` file is
 * outside `npm test`'s reach by construction - there is no flag to forget and
 * no exclude list to keep in step. `TERMSCAPE_LIVE` is then the second lock:
 * `describeLive` skips unless it is set, so pointing any other config at these
 * files still spawns nothing.
 *
 * Run with: npm run test:live
 */
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.live-test.ts'],
    env: { TERMSCAPE_LIVE: '1' },
    // A real agent boots in tens of seconds and then takes a turn or two. The
    // harness times every phase itself with a message that says which one
    // failed; these are the outer bound that should never be what fires.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    // A retried live test hides exactly the intermittent-delivery bug this
    // suite exists to catch.
    retry: 0,
    globalSetup: ['packages/hub/test/harness/sweep.ts'],
  },
});
