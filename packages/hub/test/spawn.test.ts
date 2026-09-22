import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INPUT_MODES_RESET, describeSnapshotModes, type Session } from '@termscape/protocol';
import { createRequire } from 'node:module';
import { Hub } from '../src/hub.js';
import { removeTree } from './tmp.js';
import { STAND_IN, standInToml } from './stand-in.js';

/*
 * One agent starting another. The two promises worth pinning down: the child
 * starts the way its parent did — from the same template, model included —
 * and the wire says who the parent is, because the canvas frames parent and
 * child together off that field.
 */

// CommonJS only, the same way pty.ts loads it.
const { Terminal } = createRequire(import.meta.url)('@xterm/headless') as typeof import('@xterm/headless');

let dir: string;
let hub: Hub;

const folder = (name: string): string => {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
};

const writeConfig = (toml: string): void =>
  writeFileSync(join(dir, 'agents.toml'), toml);

/** Poll a window's output until it says something, or say so. */
const waitForText = async (read: () => string, needle: string): Promise<string> => {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const text = read();
    if (text.includes(needle)) return text;
    if (Date.now() > deadline) throw new Error(`timed out waiting for "${needle}"`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-spawn-'));
  process.env.TERMSCAPE_HOME = dir;
  // `shell` takes no model on its own command line; this declaration is what
  // makes it able to spell one, which a template with a model needs.
  writeConfig(standInToml() + '[shell]\nmodel_args = ["--model", "{{model}}"]');
  hub = new Hub({ dbPath: join(dir, 'state.db') });
});

afterEach(async () => {
  hub.shutdown();
  delete process.env.TERMSCAPE_HOME;
  await removeTree(dir);
});

describe('spawn_agent', () => {
  it(
    'starts the child from the same template the parent runs, model included',
    async () => {
      hub.saveTemplate({ id: 'tester', agent: 'shell', model: 'gpt-test' });
      const ws = hub.createWorkspace('crew', folder('crew'));
      const parent = await hub.startSession({ workspaceId: ws.id, profile: 'tester' });
      expect(parent.template).toBe('tester');
      expect(parent.model).toBe('gpt-test');

      await hub.spawnAgent(parent.id, {});
      const child = hub.sessions
        .list()
        .find((s) => s.spawnedBy === parent.id)!;
      expect(child).toBeDefined();
      // The bare agent's defaults must not replace what the template chose.
      expect(child.template).toBe('tester');
      expect(child.model).toBe('gpt-test');
    },
    60_000,
  );

  it(
    'names the parent on the session broadcast, as the canvas sees it',
    async () => {
      const ws = hub.createWorkspace('crew', folder('crew'));
      const parent = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });

      const seen: Session[] = [];
      hub.on('session', (s) => seen.push(s));
      await hub.spawnAgent(parent.id, {});

      const child = seen.find((s) => s.id !== parent.id);
      expect(child).toBeDefined();
      expect(child?.spawnedBy).toBe(parent.id);
    },
    60_000,
  );

  it(
    'falls back to the bare agent when the inherited template has become invalid',
    async () => {
      hub.saveTemplate({ id: 'tester', agent: 'shell', model: 'gpt-test' });
      const ws = hub.createWorkspace('crew4', folder('crew4'));
      const parent = await hub.startSession({ workspaceId: ws.id, profile: 'tester' });

      // The template breaks on disk; the next boot loads the error with it.
      hub.shutdown();
      writeConfig(
        '[shell]\nmodel_args = ["--model", "{{model}}"]\n\n[template.tester]\nagent = "nope"\n',
      );
      hub = new Hub({ dbPath: join(dir, 'state.db') });
      expect(hub.templates.info().find((t) => t.id === 'tester')?.error).toBeTruthy();

      // A spawn must not die because config changed under a running parent.
      await hub.spawnAgent(parent.id, {});
      const child = hub.sessions.list().find((s) => s.spawnedBy === parent.id)!;
      expect(child).toBeDefined();
      expect(child.profile).toBe('shell');
      expect(child.template).toBe('shell');
      expect(child.model).toBeNull();
    },
    60_000,
  );

  it(
    'merges the template opening and the spawn instruction into one injection',
    async () => {
      // A prompt without a model: a shell carrying --model would be a session
      // that exits before the readiness wait can ever see it type.
      hub.saveTemplate({ id: 'reviewer', agent: STAND_IN, prompt: 'TEMPLATE OPENING' });
      const ws = hub.createWorkspace('crew2', folder('crew2'));
      const parent = await hub.startSession({ workspaceId: ws.id, profile: 'reviewer' });

      const out = new Map<string, string>();
      hub.on('data', (id: string, chunk: string) => out.set(id, (out.get(id) ?? '') + chunk));

      await hub.spawnAgent(parent.id, { prompt: 'run the tests' });
      const child = hub.sessions.list().find((s) => s.spawnedBy === parent.id)!;
      expect(child).toBeDefined();

      // Both halves of the instruction arrive, each exactly once — a second
      // delivery would wake the child twice on the same ready-signal.
      const text = await waitForText(() => out.get(child.id) ?? '', 'run the tests');
      expect(count(text, 'TEMPLATE OPENING')).toBe(1);
      expect(count(text, 'run the tests')).toBe(1);
      expect(count(text, '[from ')).toBe(1);
    },
    60_000,
  );

  it(
    'gives a shell its instruction as a bare command, with no attribution (issue 30)',
    async () => {
      const ws = hub.createWorkspace('crew7', folder('crew7'));
      const parent = await hub.startSession({ workspaceId: ws.id, profile: STAND_IN });

      const out = new Map<string, string>();
      hub.on('data', (id: string, chunk: string) => out.set(id, (out.get(id) ?? '') + chunk));

      await hub.spawnAgent(parent.id, { profile: 'shell', prompt: 'echo SPAWNED-SHELL' });
      const child = hub.sessions.list().find((s) => s.spawnedBy === parent.id)!;
      expect(child.profile).toBe('shell');

      // Typed once and printed once: the shell ran it as a command, which it
      // could not have with `[from ...]` in front.
      const deadline = Date.now() + 25_000;
      while (count(out.get(child.id) ?? '', 'SPAWNED-SHELL') < 2) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the echo to run');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(out.get(child.id)).not.toContain('[from ');
    },
    60_000,
  );

  it(
    "types the template opening again on clear, without the spawner's task",
    async () => {
      hub.saveTemplate({ id: 'reviewer', agent: 'shell', prompt: 'TEMPLATE OPENING' });
      const ws = hub.createWorkspace('crew4', folder('crew4'));
      const parent = await hub.startSession({ workspaceId: ws.id, profile: 'reviewer' });

      const out = new Map<string, string>();
      hub.on('data', (id: string, chunk: string) => out.set(id, (out.get(id) ?? '') + chunk));

      await hub.spawnAgent(parent.id, { prompt: 'run the tests' });
      const child = hub.sessions.list().find((s) => s.spawnedBy === parent.id)!;
      await waitForText(() => out.get(child.id) ?? '', 'run the tests');
      await waitForText(() => hub.sessions.snapshotForAttach(child.id)?.serialized ?? '', 'run the tests');

      // The old process's listeners go with it, so everything past this mark
      // is the new run - starting with the wipe the browsers are sent.
      const mark = (out.get(child.id) ?? '').length;
      const cleared = await hub.clearSession(child.id);
      expect(cleared.id).toBe(child.id);
      expect(cleared.address).toBe(child.address);
      expect(cleared.state).toBe('running');

      const after = () => (out.get(child.id) ?? '').slice(mark);
      expect(after().startsWith('\x1b[H\x1b[2J\x1b[3J')).toBe(true);
      await waitForText(after, 'TEMPLATE OPENING');
      // Who the agent is comes back; the task it was handed does not, or a
      // cleared agent would start the same work over.
      await new Promise((r) => setTimeout(r, 1500));
      expect(count(after(), 'run the tests')).toBe(0);
      expect(count(after(), '[from ')).toBe(0);
      expect(hub.sessions.snapshotForAttach(child.id)?.serialized ?? '').not.toContain(
        'run the tests',
      );
    },
    60_000,
  );

  it(
    'wipes the screen on clear and restarts a session that had no opening',
    async () => {
      const ws = hub.createWorkspace('crew5', folder('crew5'));
      const s = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });
      const out: string[] = [];
      hub.on('data', (id: string, chunk: string) => {
        if (id === s.id) out.push(chunk);
      });
      hub.sessions.write(s.id, 'echo BEFORE-CLEAR\r');
      await waitForText(() => out.join(''), 'BEFORE-CLEAR');

      const mark = out.join('').length;
      await hub.clearSession(s.id);
      const after = () => out.join('').slice(mark);
      expect(after().startsWith('\x1b[H\x1b[2J\x1b[3J')).toBe(true);
      await new Promise((r) => setTimeout(r, 3000));
      expect(after()).not.toContain('BEFORE-CLEAR');
      expect(hub.sessions.snapshotForAttach(s.id)?.serialized ?? '').not.toContain('BEFORE-CLEAR');
      expect(hub.sessions.get(s.id)?.state).toBe('running');
    },
    60_000,
  );

  it(
    "does not hand a resumed process the previous one's mouse and paste modes",
    async () => {
      // Moving the mouse over a resuming Claude Code window typed mouse
      // reports into its prompt: the restored screen had switched them on
      // for a process that had not asked for them yet.
      const ws = hub.createWorkspace('crew7', folder('crew7'));
      const s = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });
      hub.sessions.stop(s.id);
      // The exit saves the screen too; plant the old one after it, not before.
      await waitForText(() => hub.sessions.get(s.id)?.state ?? '', 'exited');
      hub.store.saveSnapshot(s.id, 'OLD-SCREEN\x1b[?1003h\x1b[?1006h\x1b[?2004h', 80, 24);

      const out: string[] = [];
      hub.on('data', (id: string, chunk: string) => {
        if (id === s.id) out.push(chunk);
      });
      await hub.resumeSession(s.id);

      // Windows already showing the session are told first, before any output.
      expect(out[0]).toBe(INPUT_MODES_RESET);
      // And a window that attaches later gets a screen without the modes. (Not
      // the old text: the new process's console repaints over it on Windows.)
      await new Promise((r) => setTimeout(r, 500));
      const snap = hub.sessions.snapshotForAttach(s.id)?.serialized ?? '';
      // Mouse modes only: the new process may ask for others itself, which it
      // is entitled to. On Windows its console asks for focus events, and on
      // Linux bash's readline turns bracketed paste back on at every prompt.
      expect(describeSnapshotModes(snap)).not.toMatch(/\+[\w-]*mouse/);
    },
    60_000,
  );

  it('INPUT_MODES_RESET switches off what a restored screen switched on', async () => {
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const write = (d: string) => new Promise<void>((r) => term.write(d, r));
    await write('\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h');
    expect(term.modes.mouseTrackingMode).toBe('any');
    expect(term.modes.bracketedPasteMode).toBe(true);

    await write(INPUT_MODES_RESET);
    expect(term.modes.mouseTrackingMode).toBe('none');
    expect(term.modes.bracketedPasteMode).toBe(false);
    expect(term.modes.sendFocusMode).toBe(false);
    expect(term.modes.applicationCursorKeysMode).toBe(false);
    term.dispose();
  });

  it(
    'restarts a cleared session at the size its window last set, not the default',
    async () => {
      const ws = hub.createWorkspace('crew6', folder('crew6'));
      const s = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });
      // The browser sends this once, when the window first measures itself,
      // and never again while its grid stays the same - a clear included.
      hub.sessions.resize(s.id, 113, 27);

      await hub.clearSession(s.id);
      const pty = hub.sessions.pty(s.id)!;
      expect([pty.cols, pty.rows]).toEqual([113, 27]);
    },
    60_000,
  );

  it(
    'delivers the template opening alone when the spawn carries no instruction',
    async () => {
      hub.saveTemplate({ id: 'reviewer', agent: 'shell', prompt: 'TEMPLATE OPENING' });
      const ws = hub.createWorkspace('crew3', folder('crew3'));
      const parent = await hub.startSession({ workspaceId: ws.id, profile: 'reviewer' });

      const out = new Map<string, string>();
      hub.on('data', (id: string, chunk: string) => out.set(id, (out.get(id) ?? '') + chunk));

      await hub.spawnAgent(parent.id, {});
      const child = hub.sessions.list().find((s) => s.spawnedBy === parent.id)!;
      expect(child).toBeDefined();

      const text = await waitForText(() => out.get(child.id) ?? '', 'TEMPLATE OPENING');
      expect(count(text, 'TEMPLATE OPENING')).toBe(1);
      expect(text).not.toContain('[from ');
    },
    60_000,
  );
});

describe('an opening instruction', () => {
  /*
   * A CLI that opens by asking the human something - Claude Code in a folder
   * it has not been trusted in - is quiet, and looks ready. The instruction
   * typed at it went into the question instead: lost, or partly taken as
   * answers. This one asks, and only reads a prompt once it has been answered.
   */
  const ASKER = String.raw`
    process.stdout.write('Do you trust this folder?\r\n  1. Yes, I trust this folder\r\n');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let answered = false;
    process.stdin.on('data', (b) => {
      if (!answered) {
        answered = true;
        process.stdout.write('\x1b[2J\x1b[Hanswered\r\n> ');
        return;
      }
      process.stdout.write('got: ' + b.toString('utf8').replace(/\x1b/g, '') + '\r\n');
    });
    setTimeout(() => {}, 60000);
  `;

  it(
    'waits for a question on screen to be answered before it is typed',
    async () => {
      const script = join(dir, 'asker.js');
      writeFileSync(script, ASKER);
      writeConfig(
        [
          '[asker]',
          `command = ${JSON.stringify(process.execPath)}`,
          `args = [${JSON.stringify(script)}]`,
          'mcp = false',
          'asking_hint = "I trust this folder"',
        ].join('\n'),
      );
      // The config is read when the hub is made.
      hub.shutdown();
      hub = new Hub({ dbPath: join(dir, 'state2.db') });
      const ws = hub.createWorkspace('asked', folder('asked'));

      const out = new Map<string, string>();
      hub.on('data', (id: string, chunk: string) => out.set(id, (out.get(id) ?? '') + chunk));
      const s = await hub.startSession({
        workspaceId: ws.id,
        profile: 'asker',
        prompt: 'OPENING TASK',
      });

      await waitForText(() => out.get(s.id) ?? '', 'I trust this folder');
      // Well past the quiet that would otherwise have counted as ready.
      await new Promise((r) => setTimeout(r, 4000));
      expect(out.get(s.id) ?? '').not.toContain('answered');

      hub.sessions.write(s.id, '1');
      const text = await waitForText(() => out.get(s.id) ?? '', 'OPENING TASK');
      expect(count(text, 'OPENING TASK')).toBe(1);
    },
    60_000,
  );
});
