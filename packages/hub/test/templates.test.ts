import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.js';
import { ProfileRegistry } from '../src/agents/profiles.js';
import { TemplateRegistry } from '../src/agents/templates.js';
import { removeTree } from './tmp.js';

/*
 * A template is an agent plus a model, an effort and an opening instruction.
 *
 * The rules worth pinning down are the ones that say no, and the one that
 * turns values into argv: a template holds what was chosen, and the agent
 * declares how to spell it, because no two of these CLIs agree.
 */

let dir: string;

const writeConfig = (toml: string): void =>
  writeFileSync(join(dir, 'agents.toml'), toml);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-tpl-'));
  process.env.TERMSCAPE_HOME = dir;
});

afterEach(() => {
  delete process.env.TERMSCAPE_HOME;
  removeTree(dir);
});

const load = (): TemplateRegistry => TemplateRegistry.load(ProfileRegistry.load());

describe('what is offered', () => {
  it('gives every agent a bare template, so nothing that worked stops working', () => {
    const ids = load()
      .list()
      .map((t) => t.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('shell');
    const claude = load().get('claude')!;
    expect(claude.agent).toBe('claude');
    expect(claude.error).toBeUndefined();
    expect(claude.model).toBeUndefined();
  });

  it('reads [template.x] out of agents.toml', () => {
    writeConfig(
      [
        '[template.reviewer]',
        'agent = "claude"',
        'model = "opus"',
        'effort = "high"',
        'prompt = "Review the diff. Report, do not fix."',
      ].join('\n'),
    );
    expect(load().get('reviewer')).toMatchObject({
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      prompt: 'Review the diff. Report, do not fix.',
    });
  });

  it('does not mistake the template table for an agent', () => {
    writeConfig('[template.reviewer]\nagent = "claude"\n');
    expect(ProfileRegistry.load().get('template')).toBeNull();
  });
});

describe('what is refused, and refused at load', () => {
  it('rejects an effort on an agent that has no effort setting', () => {
    // opencode's --variant is documented under `opencode run` and is not a
    // top-level option, so the TUI this profile starts does not take one.
    writeConfig('[template.deep]\nagent = "opencode"\neffort = "high"\n');
    const t = load().get('deep')!;
    expect(t.error).toMatch(/no effort setting/);
    // It stays in the list saying why, rather than vanishing as if the config
    // had been ignored.
    expect(load().list().map((x) => x.id)).toContain('deep');
  });

  it('rejects a model on an agent that takes none on the command line', () => {
    // A shell is the honest example now that Codex and Gemini both declare a
    // --model: it is whatever COMSPEC or SHELL points at, and there is no
    // model to give it.
    writeConfig('[template.scout]\nagent = "shell"\nmodel = "gpt-6-astra"\n');
    expect(load().get('scout')?.error).toMatch(/does not take a model/);
  });

  it('rejects an agent that does not exist', () => {
    writeConfig('[template.ghost]\nagent = "nope"\n');
    expect(load().get('ghost')?.error).toMatch(/unknown agent/);
  });

  it('falls back to the bare set on a broken file, as the profile loader does', () => {
    writeConfig('[template.oops\nthis is not toml');
    const ids = load().list().map((t) => t.id);
    expect(ids).toContain('claude');
    expect(ids).not.toContain('oops');
  });
});

describe('turning values into argv', () => {
  let hub: Hub;
  const folder = (name: string): string => {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  /** The argv the session was actually launched with. */
  const argvOf = (id: string): string[] =>
    JSON.parse(
      (
        hub.db.prepare('SELECT argv_json FROM session WHERE id = ?').get(id) as {
          argv_json: string;
        }
      ).argv_json,
    );

  beforeEach(() => {
    hub = new Hub({ dbPath: join(dir, 'state.db') });
  });
  afterEach(() => hub.shutdown());

  it('appends nothing when a template chose nothing', async () => {
    // A fragment for a value nobody chose disappears entirely. `--model ''`
    // is not the same request as no --model at all, and the CLIs say so.
    const ws = hub.createWorkspace('plain', folder('plain'));
    const s = await hub.startSession({ workspaceId: ws.id, profile: 'shell' });
    expect(argvOf(s.id).join(' ')).not.toContain('--model');
    expect(s.model).toBeNull();
    expect(s.effort).toBeNull();
  }, 30_000);

  it('spells the value the way the agent declares, and keeps it for resume', async () => {
    // `shell` declares no model spelling, so give it one - it is the only
    // profile a test can actually launch on every platform.
    writeConfig(
      [
        '[shell]',
        'model_args = ["--model", "{{model}}"]',
        '',
        '[template.reviewer]',
        'agent = "shell"',
        'model = "opus"',
      ].join('\n'),
    );
    hub.shutdown();
    hub = new Hub({ dbPath: join(dir, 'state2.db') });

    const ws = hub.createWorkspace('crew', folder('crew'));
    const s = await hub.startSession({ workspaceId: ws.id, profile: 'reviewer' });

    expect(argvOf(s.id)).toContain('--model');
    expect(argvOf(s.id)).toContain('opus');
    // Recorded on the session, not looked up from the template: resume
    // rebuilds argv rather than replaying it, and a template can be edited.
    expect(s.model).toBe('opus');
    expect(s.template).toBe('reviewer');

    hub.sessions.stop(s.id);
    const back = await hub.sessions.resume(s.id);
    // An agent coming back on a different model than it left with is worse
    // than one that does not come back.
    expect(argvOf(back.id)).toContain('opus');
  }, 60_000);

  it('refuses to start a template that did not load cleanly', async () => {
    writeConfig('[template.deep]\nagent = "opencode"\neffort = "high"\n');
    hub.shutdown();
    hub = new Hub({ dbPath: join(dir, 'state3.db') });
    const ws = hub.createWorkspace('bad', folder('bad'));
    await expect(
      hub.startSession({ workspaceId: ws.id, profile: 'deep' }),
    ).rejects.toThrow(/no effort setting/);
  }, 30_000);
});
