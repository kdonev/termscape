import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { AgentDetector } from '../src/agents/detect.js';
import { ProfileRegistry, type AgentProfile } from '../src/agents/profiles.js';
import { removeTree } from './tmp.js';

/*
 * Finding what is installed, and what each one can be pointed at.
 *
 * The fake CLIs are node scripts run through node itself, which is the one
 * executable every platform running these tests is guaranteed to have. which()
 * accepts an absolute command as given, so `command: execPath` resolves
 * everywhere without depending on anything being on PATH.
 */

let dir: string;

const profile = (over: Partial<AgentProfile> & { id: string }): AgentProfile => ({
  description: over.id,
  command: execPath,
  args: [],
  env: {},
  mcp: false,
  status: 'heuristic',
  inject: 'raw',
  ...over,
});

/** A fake CLI: prints `out` on stdout, exits with `code`. */
const script = (name: string, out: string, code = 0): string => {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, `process.stdout.write(${JSON.stringify(out)});process.exit(${code});\n`);
  return path;
};

const detectorFor = (...list: AgentProfile[]): AgentDetector =>
  new AgentDetector(new ProfileRegistry(Object.fromEntries(list.map((p) => [p.id, p]))));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-detect-'));
});
afterEach(() => removeTree(dir));

describe('before anything has been probed', () => {
  it('reports every profile as unknown rather than as missing', () => {
    const d = detectorFor(profile({ id: 'a', versionArgs: ['--version'] }));
    const [a] = d.snapshot();
    // Detection starts after the hub is already serving, so the first page
    // load lands here. "Not probed yet" is a state, not a failure.
    expect(a?.available).toBeNull();
    expect(a?.version).toBeNull();
  });

  it('answers immediately for a profile with nothing to probe', () => {
    // `shell` is whatever COMSPEC or SHELL points at: always there, and
    // asking a shell its version means something different on every platform.
    const [a] = detectorFor(profile({ id: 'shell' })).snapshot();
    expect(a?.available).toBe(true);
  });
});

describe('probing', () => {
  it('records the version a CLI printed, verbatim', async () => {
    const v = script('v', '2.1.263 (Claude Code)\n');
    const d = detectorFor(profile({ id: 'claude', versionArgs: [v, '--version'] }));
    const [a] = await d.refresh();
    expect(a?.available).toBe(true);
    expect(a?.version).toBe('2.1.263 (Claude Code)');
    expect(a?.commandPath).toBe(execPath);
  }, 30_000);

  it('keeps a declared agent that is not installed, and says which command', async () => {
    const d = detectorFor(
      profile({ id: 'ghost', command: 'definitely-not-a-real-cli', versionArgs: ['--version'] }),
    );
    const [a] = await d.refresh();
    expect(a?.available).toBe(false);
    // It stays in the list: vanishing looks like the config was ignored.
    expect(a?.id).toBe('ghost');
    expect(a?.detail).toContain('definitely-not-a-real-cli');
  });

  it('enumerates models one per line', async () => {
    const models = script('m', 'opencode/big-pickle\nopencode/mimo-v2.5-free\n\n  \n');
    const d = detectorFor(
      profile({ id: 'opencode', versionArgs: [script('ov', '1.1.51')], modelsArgs: [models] }),
    );
    const [a] = await d.refresh();
    expect(a?.models).toEqual(['opencode/big-pickle', 'opencode/mimo-v2.5-free']);
    expect(a?.modelSource).toBe('listed');
  }, 30_000);

  it('falls back to the declared list when the CLI cannot be asked', async () => {
    const d = detectorFor(
      profile({
        id: 'claude',
        versionArgs: [script('v2', '2.1.263')],
        models: ['fable', 'opus', 'sonnet'],
      }),
    );
    const [a] = await d.refresh();
    expect(a?.models).toEqual(['fable', 'opus', 'sonnet']);
    // Declared, not listed: Claude Code takes full model names too, so this
    // is a starting point rather than the whole truth.
    expect(a?.modelSource).toBe('declared');
  }, 30_000);

  it('falls back to the declared list when the listing command fails', async () => {
    const d = detectorFor(
      profile({
        id: 'x',
        versionArgs: [script('v3', '1.0')],
        modelsArgs: [script('broken', '', 1)],
        models: ['a-fallback'],
      }),
    );
    const [a] = await d.refresh();
    expect(a?.models).toEqual(['a-fallback']);
    expect(a?.modelSource).toBe('declared');
  }, 30_000);

  it('survives a CLI that prints nothing for its version', async () => {
    const d = detectorFor(profile({ id: 'quiet', versionArgs: [script('silent', '')] }));
    const [a] = await d.refresh();
    // Installed, just uncommunicative. Not a reason to hide it.
    expect(a?.available).toBe(true);
    expect(a?.version).toBeNull();
  }, 30_000);
});

describe('not spawning a process while somebody waits for a dropdown', () => {
  /** A fake CLI that appends to `counter` every time it runs. */
  const counting = (name: string, counter: string, out: string): string => {
    const path = join(dir, `${name}.mjs`);
    writeFileSync(
      path,
      `import {appendFileSync} from 'node:fs';` +
        `appendFileSync(${JSON.stringify(counter)}, 'x');` +
        `process.stdout.write(${JSON.stringify(out)});`,
    );
    return path;
  };

  it('re-lists only when the version changed', async () => {
    const runs = join(dir, 'runs');
    const models = counting('models', runs, ['one', 'two'].join(String.fromCharCode(10)));
    const versionFile = join(dir, 'version.txt');
    writeFileSync(versionFile, '1.0.0');
    const version = join(dir, 'version.mjs');
    writeFileSync(
      version,
      `import {readFileSync} from 'node:fs';` +
        `process.stdout.write(readFileSync(${JSON.stringify(versionFile)},'utf8'));\n`,
    );

    const d = detectorFor(profile({ id: 'v', versionArgs: [version], modelsArgs: [models] }));
    await d.refresh();
    await d.refresh();
    // Listing 395 models is not something to redo because a dropdown opened.
    expect(readFileSync(runs, 'utf8')).toBe('x');

    // The CLI updated underneath us; last week's list is no longer the right
    // answer, which is the whole reason the version is the cache key.
    writeFileSync(versionFile, '2.0.0');
    await d.refresh();
    expect(readFileSync(runs, 'utf8')).toBe('xx');
  }, 60_000);

  it('shares one run between concurrent callers', async () => {
    const runs = join(dir, 'vruns');
    const version = counting('v', runs, '1.0');
    const d = detectorFor(profile({ id: 'v', versionArgs: [version] }));
    await Promise.all([d.refresh(), d.refresh(), d.refresh()]);
    expect(readFileSync(runs, 'utf8')).toBe('x');
  }, 60_000);
});

describe('telling anyone who is listening', () => {
  it('emits when the answer changes, and not when it does not', async () => {
    const d = detectorFor(profile({ id: 'a', versionArgs: [script('v4', '1.0')] }));
    let changes = 0;
    d.on('changed', () => changes++);
    await d.refresh();
    expect(changes).toBe(1);
    await d.refresh();
    // Same answer: broadcasting it again redraws every picker for nothing.
    expect(changes).toBe(1);
  }, 60_000);
});
