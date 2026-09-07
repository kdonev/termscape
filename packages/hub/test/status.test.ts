import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PtySession } from '../src/session/pty.js';
import { writeWiring } from '../src/agents/wiring.js';
import type { AgentProfile } from '../src/agents/profiles.js';
import { removeTree } from './tmp.js';

/**
 * What the status dot is showing. These spawn real PTYs running a program that
 * prints once and then sits there, which is the shape of every agent CLI
 * waiting at its prompt - the case the dot used to get wrong.
 */

const QUIET_PROGRAM = "process.stdout.write('$ '); setTimeout(() => {}, 30000)";

const live: PtySession[] = [];

function startQuiet(mode: 'hooks' | 'heuristic', readyHint: RegExp | null): PtySession {
  const p = new PtySession(`status-${live.length}`, 80, 24, readyHint, mode);
  live.push(p);
  p.start({
    argv: [process.execPath, '-e', QUIET_PROGRAM],
    env: {},
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  return p;
}

async function waitForStatus(p: PtySession, want: string, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (p.status === want) return p.status;
    await new Promise((r) => setTimeout(r, 50));
  }
  return p.status;
}

afterEach(() => {
  while (live.length > 0) live.pop()!.dispose();
});

describe('the status a window reports', () => {
  it('starts busy, because a process that just launched is doing something', () => {
    expect(startQuiet('heuristic', /[$#>%] ?$/).status).toBe('busy');
  });

  // The prompt of a CLI that has just started is at the top of the screen,
  // with twenty-three blank rows under it. Testing the bottom row against the
  // prompt pattern matched nothing, ever, so this never went green.
  it('goes idle once a heuristic profile is sitting at its prompt', async () => {
    const p = startQuiet('heuristic', /[$#>%] ?$/);
    expect(await waitForStatus(p, 'idle', 5000)).toBe('idle');
  });

  // The bug this file exists for: a hooks profile changed status only when a
  // hook arrived, so a machine where the hook command cannot run - the wrong
  // shell, a blocked PowerShell - left every window amber for its whole life.
  it('goes idle for a hooks profile whose hooks never arrive', async () => {
    const p = startQuiet('hooks', null);
    expect(p.status).toBe('busy');
    expect(await waitForStatus(p, 'idle', 8000)).toBe('idle');
  });

  it('waits longer than the heuristic before assuming that', async () => {
    // Silence is all this path has to go on, and an agent mid-turn animating
    // a spinner must not fall through it.
    const p = startQuiet('hooks', null);
    await new Promise((r) => setTimeout(r, 1000));
    expect(p.status).toBe('busy');
  });

  it('leaves a session to its hooks once one has arrived', async () => {
    const p = startQuiet('hooks', null);
    p.noteHook('busy');
    // The output fallback would have called this idle by now. A hook said
    // otherwise, and a hook is the agent speaking for itself.
    await new Promise((r) => setTimeout(r, 3000));
    expect(p.status).toBe('busy');

    p.noteHook('idle');
    expect(p.status).toBe('idle');
  });

  it('reports a status change to whoever is listening', async () => {
    const p = startQuiet('heuristic', /[$#>%] ?$/);
    const seen: string[] = [];
    p.on('status', (s: string) => seen.push(s));
    await waitForStatus(p, 'idle', 5000);
    expect(seen).toContain('idle');
  });
});

describe('the hooks an agent is wired with', () => {
  let home: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'termscape-wiring-'));
    process.env.TERMSCAPE_HOME = home;
  });

  afterAll(() => {
    delete process.env.TERMSCAPE_HOME;
    removeTree(home);
  });

  // `mcp: true` because settings.json is a wired agent's file: hooks are how a
  // CLI reports its own turn boundaries, and an unwired one has none to report.
  const profile = (status: 'hooks' | 'heuristic'): AgentProfile =>
    ({
      id: 'test',
      command: 'noop',
      args: [],
      mcp: true,
      status,
      inject: 'bracketed',
    }) as AgentProfile;

  function settingsFor(status: 'hooks' | 'heuristic'): Record<string, any> {
    const out = writeWiring({
      sessionId: `wiring-${status}`,
      address: 'ws/agent-1',
      workspace: 'ws',
      cwd: process.cwd(),
      profile: profile(status),
      token: 'tok',
      hubOrigin: 'http://127.0.0.1:7777',
      peers: [],
    });
    return JSON.parse(readFileSync(out.settingsPath, 'utf8'));
  }

  it('cannot report a failed hook when the hub is unreachable', () => {
    /*
     * A status ping that cannot land is not worth telling the user about, and
     * the CLI running the hook judges that by the exit code. The POSIX branch
     * always had `|| true`; the Windows branch had `catch {}`, which swallows
     * the message and not the failure - PowerShell still exits 1 because $? is
     * false, and the agent reported a failed hook with no stderr every turn.
     */
    const cmd = settingsFor('hooks').hooks.Stop[0].hooks[0].command as string;
    if (process.platform === 'win32') expect(cmd).toMatch(/;\s*exit 0"?$/);
    else expect(cmd).toMatch(/\|\| true$/);
  });

  it('sends a body the hub will actually accept', () => {
    /*
     * `Invoke-WebRequest -Method POST` with no body still sends a content type
     * the hub has no parser for, and Fastify answers 415 - so every status
     * hook on Windows was rejected and the dot fell back to guessing from
     * silence. curl sends no content type at all, which is why this never
     * showed on the other branch.
     */
    const cmd = settingsFor('hooks').hooks.Stop[0].hooks[0].command as string;
    expect(cmd).toMatch(/application\/json/);
  });

  it('covers both edges of a turn, not only the start of one', () => {
    const hooks = settingsFor('hooks').hooks;
    // Work that began without a prompt of its own - a resumed turn, a message
    // typed in by a peer - still reaches a tool call, which is what keeps a
    // busy window from reading as idle.
    expect(Object.keys(hooks).sort()).toEqual(
      ['Notification', 'PreToolUse', 'Stop', 'UserPromptSubmit'].sort(),
    );
    const command = (event: string) => JSON.stringify(hooks[event]);
    expect(command('UserPromptSubmit')).toContain('event=busy');
    expect(command('PreToolUse')).toContain('event=busy');
    expect(command('Stop')).toContain('event=idle');
    // Waiting on a permission prompt is waiting on the human.
    expect(command('Notification')).toContain('event=idle');
  });

  it('writes no hooks for a profile that does not have them', () => {
    expect(settingsFor('heuristic')).toEqual({});
  });
});

describe('the title a program sets for itself', () => {
  it('picks up an OSC 0 title from the stream', async () => {
    const p = new PtySession('title-1', 80, 24, null, 'heuristic');
    live.push(p);
    const seen: string[] = [];
    p.on('title', (t: string) => seen.push(t));
    p.start({
      argv: [
        process.execPath,
        '-e',
        `process.stdout.write('\u001b]0;building the thing\u0007'); setTimeout(() => {}, 30000)`,
      ],
      env: {},
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.includes('building the thing')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toContain('building the thing');
  });

  // ConPTY sets the terminal title to the child's image path the moment it
  // spawns. Reported as the agent's own title it would put C:...node.exe in
  // the header of every window on Windows.
  it('ignores the image path the platform announces at launch', async () => {
    const p = new PtySession('title-3', 80, 24, null, 'heuristic');
    live.push(p);
    const seen: string[] = [];
    p.on('title', (t: string) => seen.push(t));
    p.start({
      argv: [process.execPath, '-e', QUIET_PROGRAM],
      env: {},
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });

    await new Promise((r) => setTimeout(r, 1500));
    for (const t of seen) {
      expect(t.toLowerCase()).not.toBe(process.execPath.toLowerCase());
    }
  });

  it('reports a title once, however often the program repeats it', async () => {
    const p = new PtySession('title-2', 80, 24, null, 'heuristic');
    live.push(p);
    const seen: string[] = [];
    p.on('title', (t: string) => seen.push(t));
    p.start({
      argv: [
        process.execPath,
        '-e',
        `for (let i = 0; i < 5; i++) process.stdout.write('\u001b]2;same title\u0007'); setTimeout(() => {}, 30000)`,
      ],
      env: {},
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });

    await new Promise((r) => setTimeout(r, 2000));
    expect(seen.filter((t) => t === 'same title')).toHaveLength(1);
  });
});
