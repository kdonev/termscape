import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CLI_OPTIONS } from '../src/cli-args.js';
import {
  childExecArgv,
  openAppWindow,
  windowOutcome,
  WINDOW_UNAVAILABLE,
  type WindowOutcome,
} from '../src/window/open-window.js';
import { removeTree } from './tmp.js';

/*
 * Closing the canvas window stops the hub, so what a window process's exit is
 * taken to mean decides whether a user loses their agents. These pin that
 * reading without a real webview - CI has no display - by standing a tiny
 * script in for app-window.js.
 */

describe('windowOutcome', () => {
  it('reads a clean exit as the user closing the window', () => {
    expect(windowOutcome(0, null)).toBe('closed');
  });

  it('reads the unavailable code as no webview to show', () => {
    expect(windowOutcome(WINDOW_UNAVAILABLE, null)).toBe('unavailable');
  });

  it('reads anything else as a crash, which must not stop the hub', () => {
    expect(windowOutcome(1, null)).toBe('crashed');
    expect(windowOutcome(null, 'SIGKILL')).toBe('crashed');
  });
});

describe('openAppWindow', () => {
  const outcomeOf = (script: string): Promise<WindowOutcome> =>
    new Promise((resolve) => {
      openAppWindow(
        'http://127.0.0.1:1/?token=t',
        {
          onClosed: () => resolve('closed'),
          onUnavailable: () => resolve('unavailable'),
          onCrashed: () => resolve('crashed'),
        },
        script,
      );
    });

  it('reports each way the window process can end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'termscape-window-'));
    try {
      const stub = (name: string, code: number): string => {
        const path = join(dir, `${name}.mjs`);
        writeFileSync(path, `process.exit(${code});\n`);
        return path;
      };
      expect(await outcomeOf(stub('closed', 0))).toBe('closed');
      expect(await outcomeOf(stub('unavailable', WINDOW_UNAVAILABLE))).toBe('unavailable');
      expect(await outcomeOf(stub('crashed', 1))).toBe('crashed');
    } finally {
      await removeTree(dir);
    }
  });

  it('starts the window as a child of the hub, whose pid it watches', async () => {
    // The real window closes once its parent's pid is gone; a stub checks the
    // parent it would be watching is this process.
    const dir = mkdtempSync(join(tmpdir(), 'termscape-window-'));
    try {
      const path = join(dir, 'watch.mjs');
      writeFileSync(path, `process.exit(process.ppid === ${process.pid} ? 0 : 1);\n`);
      expect(await outcomeOf(path)).toBe('closed');
    } finally {
      await removeTree(dir);
    }
  });
});

describe('childExecArgv', () => {
  it('passes the loader on, so a .ts window runs under tsx as the hub does', () => {
    const tsx = ['--require', 'tsx/preflight.cjs', '--import', 'file:///tsx/loader.mjs'];
    expect(childExecArgv(tsx)).toEqual(tsx);
  });

  it('keeps the inspector to the hub, whose port it already holds', () => {
    expect(childExecArgv(['--inspect', '--inspect-brk=9230', '--inspect-port=1'])).toEqual([
      '--inspect-port=1',
    ]);
  });
});

describe('--browser', () => {
  it('defaults to the window and parses as a switch', () => {
    expect(parseArgs({ args: [], options: CLI_OPTIONS, strict: true }).values.browser).toBe(false);
    expect(
      parseArgs({ args: ['--browser'], options: CLI_OPTIONS, strict: true }).values.browser,
    ).toBe(true);
  });
});
