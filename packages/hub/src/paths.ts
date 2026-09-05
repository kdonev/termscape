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
  /**
   * Durable credential an enrolled host presents when it dials its canvas hub
   * again. Written 0600; its presence is what makes a reboot rejoin silently.
   */
  hostTokenFile: () => join(hubHome(), 'host-token'),
  /**
   * PID of the running hub. The join installer reads it to stop a previous
   * hub before replacing its files — on Windows an open .node cannot be
   * deleted, so re-joining fails outright without this.
   */
  pidFile: () => join(hubHome(), 'hub.pid'),
};
