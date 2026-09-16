import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { powershellCommand } from '../src/agents/profiles.js';
import { removeTree } from './tmp.js';

/*
 * Which PowerShell the `powershell` profile starts. On Windows PowerShell 7 is
 * preferred over the 5.1 the OS ships, and 5.1 is only the answer when 7
 * cannot be found. The executables here are empty files: which() and the
 * install-directory probe only ask whether the file exists.
 */

const saved = {
  PATH: process.env.PATH,
  ProgramFiles: process.env.ProgramFiles,
  ProgramW6432: process.env.ProgramW6432,
};
let dir: string;

const restore = (key: keyof typeof saved) => {
  if (saved[key] === undefined) delete process.env[key];
  else process.env[key] = saved[key];
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-pwsh-'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'pf'));
  process.env.PATH = join(dir, 'bin');
  process.env.ProgramFiles = join(dir, 'pf');
  delete process.env.ProgramW6432;
});

afterEach(async () => {
  restore('PATH');
  restore('ProgramFiles');
  restore('ProgramW6432');
  await removeTree(dir);
});

describe.runIf(platform === 'win32')('powershellCommand on Windows', () => {
  it('falls back to the built-in 5.1 when PowerShell 7 is nowhere', () => {
    expect(powershellCommand()).toBe('powershell.exe');
  });

  it('prefers pwsh when it is on PATH', () => {
    writeFileSync(join(dir, 'bin', 'pwsh.exe'), '');
    expect(powershellCommand()).toBe('pwsh');
  });

  it('finds pwsh in its default install directory when PATH predates the install', () => {
    const installed = join(dir, 'pf', 'PowerShell', '7', 'pwsh.exe');
    mkdirSync(join(dir, 'pf', 'PowerShell', '7'), { recursive: true });
    writeFileSync(installed, '');
    expect(powershellCommand()).toBe(installed);
  });
});

describe.runIf(platform !== 'win32')('powershellCommand elsewhere', () => {
  it('is pwsh, the only PowerShell there is', () => {
    expect(powershellCommand()).toBe('pwsh');
  });
});
