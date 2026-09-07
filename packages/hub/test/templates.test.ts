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

/*
 * Templates made from the panel.
 *
 * The rule that needs pinning down is precedence, because it is the one thing
 * a person could be surprised by: a template can come from three places and
 * only one of them is writable.
 */
describe('templates made from the panel', () => {
  let hub: Hub;

  const reload = (): Hub => {
    hub?.shutdown();
    hub = new Hub({ dbPath: join(dir, 'state.db') });
    return hub;
  };
  const info = (id: string) => hub.templates.info().find((t) => t.id === id);

  beforeEach(() => {
    hub = new Hub({ dbPath: join(dir, 'state.db') });
  });
  afterEach(() => hub.shutdown());

  it('stores one and offers it, saying where it came from', () => {
    hub.saveTemplate({ id: 'reviewer', agent: 'claude', model: 'opus', effort: 'high' });
    expect(info('reviewer')).toMatchObject({
      id: 'reviewer',
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      source: 'stored',
      error: null,
    });
  });

  it('survives a restart, because it is in the database and not in memory', () => {
    hub.saveTemplate({ id: 'reviewer', agent: 'claude', model: 'opus' });
    reload();
    expect(info('reviewer')?.model).toBe('opus');
  });

  it('shadows an agent\u2019s own bare template', () => {
    // A bare template is only a default. Making one called `claude` with a
    // model on it is exactly how you say "when I pick claude, I mean this".
    expect(info('claude')?.source).toBe('derived');
    hub.saveTemplate({ id: 'claude', agent: 'claude', model: 'opus' });
    expect(info('claude')).toMatchObject({ source: 'stored', model: 'opus' });
  });

  it('reveals the bare one again when the stored one is removed', () => {
    hub.saveTemplate({ id: 'claude', agent: 'claude', model: 'opus' });
    hub.removeTemplate('claude');
    // Not an empty row and not a missing one: `claude` still starts claude.
    expect(info('claude')).toMatchObject({ source: 'derived', model: null });
  });

  it('lets agents.toml win, and says so rather than shadowing it', () => {
    writeConfig('[template.reviewer]\nagent = "claude"\nmodel = "sonnet"\n');
    reload();
    expect(info('reviewer')).toMatchObject({ source: 'file', model: 'sonnet' });
    // Someone who wrote a template by hand meant it. Refusing the name is a
    // better answer than storing a row that never appears in the list.
    expect(() => hub.saveTemplate({ id: 'reviewer', agent: 'claude' })).toThrow(
      /agents\.toml/,
    );
    expect(info('reviewer')?.model).toBe('sonnet');
  });

  it('refuses a value the named agent cannot spell, before storing it', () => {
    // The loader's own rule, called rather than restated - so the dialog gets
    // the refusal instead of the list quietly gaining a broken row.
    expect(() => hub.saveTemplate({ id: 'deep', agent: 'opencode', effort: 'high' })).toThrow(
      /no effort setting/,
    );
    expect(info('deep')).toBeUndefined();
  });

  it('refuses to remove what it does not own', () => {
    writeConfig('[template.fromfile]\nagent = "claude"\n');
    reload();
    expect(() => hub.removeTemplate('fromfile')).toThrow(/agents\.toml/);
    // A bare template is derived, not stored; there is nothing to delete.
    expect(() => hub.removeTemplate('shell')).toThrow(/not stored/);
  });

  it('announces the whole list, because one write can change another row', () => {
    const seen: string[][] = [];
    hub.on('templates', (list: { id: string; source: string }[]) =>
      seen.push(list.filter((t) => t.source === 'stored').map((t) => t.id)),
    );
    hub.saveTemplate({ id: 'reviewer', agent: 'claude' });
    hub.removeTemplate('reviewer');
    expect(seen).toEqual([['reviewer'], []]);
  });

  it('does not disturb a session it already started', async () => {
    const folder = join(dir, 'made');
    mkdirSync(folder, { recursive: true });
    hub.saveTemplate({ id: 'sh', agent: 'shell', prompt: 'hello' });
    const ws = hub.createWorkspace('made', folder);
    const s = await hub.startSession({ workspaceId: ws.id, profile: 'sh' });

    hub.removeTemplate('sh');
    // The session recorded what its template resolved to precisely so resume
    // cannot drift, so removing the template takes nothing away from it.
    expect(hub.sessions.get(s.id)?.template).toBe('sh');
    expect(hub.sessions.get(s.id)?.state).not.toBe('failed');
  }, 30_000);
});
