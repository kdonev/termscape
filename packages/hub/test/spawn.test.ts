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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-spawn-'));
  process.env.TERMSCAPE_HOME = dir;
  // `shell` takes no model on its own command line; this declaration is what
  // makes it able to spell one, which a template with a model needs.
  writeConfig('[shell]\nmodel_args = ["--model", "{{model}}"]');
  hub = new Hub({ dbPath: join(dir, 'state.db') });
});

afterEach(() => {
  hub.shutdown();
  delete process.env.TERMSCAPE_HOME;
  removeTree(dir);
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
});
