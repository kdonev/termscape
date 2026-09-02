import { describe, expect, it } from 'vitest';
import { execPath, platform } from 'node:process';
import { basename, extname, isAbsolute } from 'node:path';
import { which, resolveCommand } from '../src/agents/resolve.js';

/**
 * node-pty performs no PATH lookup, so every profile command must be resolved
 * to an absolute path before it is spawned. Getting this wrong fails with an
 * opaque "File not found:", which is why it is worth pinning down.
 */
describe('command resolution', () => {
  it('finds a bare command that is on PATH', () => {
    // node itself is guaranteed to be on PATH in any environment running this.
    const found = which(basename(execPath).replace(/\.exe$/i, ''));
    expect(found).not.toBeNull();
    expect(isAbsolute(found!)).toBe(true);
  });

  it('returns null for a command that does not exist', () => {
    expect(which('definitely-not-a-real-command-xyz')).toBeNull();
  });

  it('accepts an absolute path unchanged', () => {
    expect(which(execPath)).toBe(execPath);
  });

  it('returns an absolute argv[0] with the args preserved', () => {
    const cmd = basename(execPath).replace(/\.exe$/i, '');
    const { argv } = resolveCommand(cmd, ['--version', '--flag=x']);
    expect(isAbsolute(argv[0]!)).toBe(true);
    expect(argv.slice(1)).toEqual(['--version', '--flag=x']);
  });

  it('throws a message naming the command when it is missing', () => {
    expect(() => resolveCommand('no-such-agent-cli', [])).toThrow(/no-such-agent-cli/);
    expect(() => resolveCommand('no-such-agent-cli', [])).toThrow(/PATH/);
  });

  it.runIf(platform === 'win32')('probes PATHEXT on Windows', () => {
    // "node" resolves even though the file on disk is node.exe.
    const found = which('node');
    expect(found).not.toBeNull();
    expect(extname(found!).toLowerCase()).toBe('.exe');
  });

  it.runIf(platform === 'win32')('wraps a .cmd shim in cmd.exe /c', () => {
    // npm ships as npm.cmd on Windows; CreateProcess cannot execute it
    // directly, so it has to go through the shell.
    const npm = which('npm');
    if (!npm || extname(npm).toLowerCase() !== '.cmd') return;
    const { argv } = resolveCommand('npm', ['--version']);
    expect(argv[0]!.toLowerCase()).toContain('cmd');
    expect(argv[1]).toBe('/c');
    expect(argv[2]).toBe(npm);
    expect(argv[3]).toBe('--version');
  });
});
