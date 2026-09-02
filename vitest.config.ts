import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // PTY-backed integration tests spawn real shells; give them room but do
    // not let a hung shell wedge the suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    // One fork: the integration tests spawn real PTYs and bind real ports.
    maxWorkers: 1,
    fileParallelism: false,
  },
});
