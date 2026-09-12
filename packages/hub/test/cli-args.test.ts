import { describe, expect, it } from 'vitest';
import { parseArgs } from 'node:util';
import { CLI_OPTIONS } from '../src/cli-args.js';
import { joinScriptPosix, joinScriptPowerShell } from '../src/remote/join-script.js';

/*
 * A hub is usually launched by other machinery, not by a person, and that
 * machinery puts a freshly minted secret on its command line: the join
 * installer passes an enrollment token, the SSH deployer passes a client
 * token. Both are base64url, an alphabet that includes `-`, so one token in
 * sixty-four begins with a dash.
 *
 * `parseArgs` in strict mode refuses a separate value that looks like another
 * option, so those joins installed everything correctly and then died on
 * startup with ERR_PARSE_ARGS_INVALID_OPTION_VALUE. Nothing about the failure
 * pointed at the token, and re-running the installer minted a new one and
 * usually worked - which is close to the worst shape a bug can have.
 *
 * These tests take the command line out of what the generators actually emit
 * rather than restating it, so an edit that goes back to `--opt value` fails
 * here instead of on someone's second machine.
 */

/** A token that begins with a dash, as one in sixty-four really does. */
const DASH_TOKEN = '-abc_DEF-123ghi_JKL456mno';
const ORIGIN = 'http://studio:7777';

/**
 * The arguments the generated shell script hands to `node cli.js`, with the
 * shell's own expansion done by hand.
 *
 * Quotes are simply stripped rather than parsed: none of these values contain
 * a space, and by the time `parseArgs` sees them a real shell has already
 * done its unquoting. What survives that is exactly what is under test.
 */
function posixLaunchArgv(script: string): string[] {
  const line = /\n\s*(--headless[^\n\\]*)/.exec(script);
  if (!line) throw new Error('no launch command found in the generated script');
  return line[1]!
    .replace('"$HUB_URL"', ORIGIN)
    .replace('"$JOIN_TOKEN"', DASH_TOKEN)
    .trim()
    .split(/\s+/);
}

describe('generated launch command lines', () => {
  it('parses a posix join whose token starts with a dash', () => {
    const argv = posixLaunchArgv(joinScriptPosix(ORIGIN, DASH_TOKEN));

    const { values } = parseArgs({ args: argv, options: CLI_OPTIONS, strict: true });
    expect(values.headless).toBe(true);
    expect(values.join).toBe(ORIGIN);
    expect(values['join-token']).toBe(DASH_TOKEN);
  });

  it('parses a PowerShell join whose token starts with a dash', () => {
    /*
     * The PowerShell script assembles its argument string in its own source,
     * so there is no literal command line to lift out. What can be checked is
     * the thing that matters: name and value joined by `=` rather than split
     * into two arguments.
     */
    const script = joinScriptPowerShell(ORIGIN, DASH_TOKEN);
    expect(script).toContain('--join-token="');
    expect(script).not.toMatch(/--join-token\s+"/);
    expect(script).not.toMatch(/--join\s+"/);

    // And the same argument list, assembled the way that script assembles it.
    const { values } = parseArgs({
      args: ['--headless', '--port', '0', `--join=${ORIGIN}`, `--join-token=${DASH_TOKEN}`],
      options: CLI_OPTIONS,
      strict: true,
    });
    expect(values['join-token']).toBe(DASH_TOKEN);
  });

  /*
   * The property itself, stated straight at parseArgs: the exact call that
   * used to throw, beside the exact call that now does not.
   */
  it('accepts a dash-leading value in the = form and refuses it separated', () => {
    const ok = parseArgs({
      args: ['--headless', `--join-token=${DASH_TOKEN}`],
      options: CLI_OPTIONS,
      strict: true,
    });
    expect(ok.values['join-token']).toBe(DASH_TOKEN);

    expect(() =>
      parseArgs({
        args: ['--headless', '--join-token', DASH_TOKEN],
        options: CLI_OPTIONS,
        strict: true,
      }),
    ).toThrow(/ambiguous/i);
  });

  /*
   * The installer's own launch. It is machinery rather than something a
   * person types, so its shape is worth pinning.
   *
   * It briefly ran the hub attached to the installer's console, on the theory
   * that a console-less parent creates pseudoconsoles that swallow an agent's
   * mouse-mode request. Measured on Windows 10 that is false - an agent
   * behaves identically either way - and the console cost the daemon
   * property, because the hub died the moment the window closed. So it is
   * detached again, with its log produced by a redirect as it always was.
   */
  it('launches the Windows hub detached, with its output redirected', () => {
    const script = joinScriptPowerShell(ORIGIN, DASH_TOKEN);
    // Only the hub's own launch. The installer redirects elsewhere for good
    // reason - npm's stderr has to stay out of PowerShell's error stream -
    // and asserting over the whole script would forbid that too.
    const launch = /\$cliArgs = [\s\S]*?\$null = \$hubProc\.Handle/.exec(script)?.[0];
    expect(launch, 'hub launch block not found').toBeTruthy();
    expect(launch).toContain('-WindowStyle Hidden');
    expect(launch).toContain('-RedirectStandardOutput');
    expect(launch).not.toContain('-NoNewWindow');
  });

  it('leaves the posix installer detached, where a console is not load-bearing', () => {
    // The Windows fix does not apply here and the daemon behaviour is worth
    // more: a pty is a pty whether or not its opener has a terminal.
    const script = joinScriptPosix(ORIGIN, DASH_TOKEN);
    expect(script).toContain('nohup');
    expect(script).toContain('>"$HOME_DIR/hub.log"');
  });

  it('still accepts a token given the old way when it has no leading dash', () => {
    // The `=` form is what the generators emit; a person typing the flag by
    // hand with an ordinary token has to keep working.
    const { values } = parseArgs({
      args: ['--join', ORIGIN, '--join-token', 'plainTOKEN123'],
      options: CLI_OPTIONS,
      strict: true,
    });
    expect(values['join-token']).toBe('plainTOKEN123');
  });
});
