import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A profile that runs a shell but that the hub treats as an agent.
 *
 * Tests need a real process in the target window, and no agent CLI can be
 * counted on to be installed, so a shell stands in for one. The `shell`
 * profile itself no longer will: a message to a shell is sent as a command,
 * with no `[from ...]` prefix (issue 30), and attribution is exactly what
 * these tests are checking. `brief = "flag"` is what makes it an agent in the
 * hub's eyes - nothing is typed, since there is no flag in its args to carry
 * the brief anywhere.
 */
export const STAND_IN = 'stand-in';

export function standInToml(): string {
  const shell =
    process.platform === 'win32'
      ? (process.env.COMSPEC ?? 'powershell.exe')
      : (process.env.SHELL ?? '/bin/bash');
  return [
    `[${STAND_IN}]`,
    `command = ${JSON.stringify(shell)}`,
    'mcp = false',
    'brief = "flag"',
    'inject = "raw"',
    `ready_hint = ${JSON.stringify('[$#>%] ?$')}`,
    '',
  ].join('\n');
}

/** Declare the stand-in in a TERMSCAPE_HOME, ahead of the hub that loads it. */
export function declareStandIn(home: string, extra = ''): void {
  writeFileSync(join(home, 'agents.toml'), standInToml() + extra);
}
