import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * All hub state lives under one root so it is trivially portable and
 * trivially deletable. `AICANVAS_HOME` overrides it, which is what the
 * integration tests use to get an isolated hub per test.
 */
export function hubHome(): string {
  return process.env.AICANVAS_HOME ?? join(homedir(), '.aicanvas');
}

export const paths = {
  home: hubHome,
  db: () => join(hubHome(), 'state.db'),
  /** Generated per-session MCP configs, settings and briefs. */
  run: () => join(hubHome(), 'run'),
  sessionDir: (sessionId: string) => join(hubHome(), 'run', sessionId),
  profiles: () => join(hubHome(), 'agents.toml'),
  tokenFile: () => join(hubHome(), 'token'),
};
