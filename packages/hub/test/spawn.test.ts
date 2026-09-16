import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@termscape/protocol';
import { Hub } from '../src/hub.js';
import { removeTree } from './tmp.js';

/*
 * One agent starting another. The two promises worth pinning down: the child
 * starts the way its parent did — from the same template, model included —
 * and the wire says who the parent is, because the canvas frames parent and
 * child together off that field.
 */

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
  writeConfig('[shell]\nmodel_args = ["--model", "{{model}}"]');
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
      hub.saveTemplate({ id: 'reviewer', agent: 'shell', prompt: 'TEMPLATE OPENING' });
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
