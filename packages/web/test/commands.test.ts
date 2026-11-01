import { describe, expect, it } from 'vitest';
import { commandEntries, fuzzy, rank, startEntries } from '../src/canvas/commands.js';

/*
 * The palette's matching (issue 52). What these pin down is the ordering: a
 * palette that finds the right thing but ranks it third is barely better than
 * one that does not find it, because the user is typing and pressing Enter
 * without looking.
 */

const score = (text: string, query: string) => fuzzy(text, query)?.score ?? null;

describe('fuzzy', () => {
  it('matches everything on an empty query, so the palette opens full', () => {
    expect(fuzzy('anything', '')).toEqual({ score: 0, indices: [] });
  });

  it('rejects what is not a subsequence', () => {
    expect(fuzzy('new note', 'xyz')).toBeNull();
    // Right letters, wrong order: there is no `n` after the last `e`.
    expect(fuzzy('new note', 'ten')).toBeNull();
  });

  it('ignores case in both directions', () => {
    expect(fuzzy('New Agent', 'nag')).not.toBeNull();
    expect(fuzzy('new agent', 'NAG')).not.toBeNull();
  });

  it('reports which characters matched, for highlighting', () => {
    expect(fuzzy('new note', 'note')!.indices).toEqual([4, 5, 6, 7]);
  });

  it('prefers a run of characters over scattered ones', () => {
    expect(score('new note', 'note')!).toBeGreaterThan(score('nineteen otters', 'note')!);
  });

  it('prefers a match at the start of a word', () => {
    expect(score('new workspace', 'w')!).toBeGreaterThan(score('answer', 'w')!);
  });

  it('reads a query as initials', () => {
    // The case greedy subsequence matching is worst at, and the one people
    // type most: "na" meaning "new agent".
    expect(score('new agent in this workspace', 'na')!).toBeGreaterThan(
      score('canvas mode', 'na')!,
    );
  });

  it('lets initials skip words, so "nh" still finds "new agent here"', () => {
    const hit = fuzzy('new agent here', 'nh');
    expect(hit).not.toBeNull();
    expect(hit!.indices).toEqual([0, 10]);
  });

  it('breaks a tie towards the shorter title', () => {
    expect(score('note', 'note')!).toBeGreaterThan(score('note something longer', 'note')!);
  });
});

describe('rank', () => {
  const titles = ['New note', 'New agent in this workspace', 'New workspace', 'Machines panel'];
  const ranked = (q: string) => rank(titles, q, (t) => t).map((r) => r.item);

  it('keeps the given order when nothing is typed', () => {
    expect(ranked('')).toEqual(titles);
  });

  it('drops what does not match', () => {
    expect(ranked('zzz')).toEqual([]);
  });

  it('puts the obvious answer first', () => {
    expect(ranked('note')[0]).toBe('New note');
    expect(ranked('machines')[0]).toBe('Machines panel');
    expect(ranked('nw')[0]).toBe('New workspace');
  });

  it('carries the highlight indices through', () => {
    const [first] = rank(titles, 'note', (t) => t);
    expect(first!.indices).toEqual([4, 5, 6, 7]);
  });

  it('is stable, so equal scores do not reshuffle under the cursor', () => {
    const same = ['aa one', 'aa two', 'aa three'];
    expect(rank(same, 'aa', (t) => t).map((r) => r.item)).toEqual(same);
  });
});

describe('commandEntries', () => {
  it('spells the modifier the way the caller asks', () => {
    const entries = commandEntries('Cmd');
    expect(entries.every((e) => !e.hint.includes('Ctrl'))).toBe(true);
    expect(entries.some((e) => e.hint === 'Cmd+Shift+E')).toBe(true);
  });

  it('offers only what makes sense to pick from a list', () => {
    const actions = commandEntries('Ctrl').map((e) => e.kind === 'command' && e.action);
    // Moving the selection one window over is a key, not an entry.
    expect(actions).not.toContain('select.left');
    expect(actions).not.toContain('pan.up');
    expect(actions).not.toContain('focus.enter');
    expect(actions).toContain('new.agent');
    expect(actions).toContain('help');
  });

  it('names every entry distinctly, so the list is never ambiguous', () => {
    const titles = commandEntries('Ctrl').map((e) => e.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('startEntries', () => {
  const ws = (id: string, name: string) => ({ id, name });
  const tpl = (id: string, agent = id) => ({ id, agent });

  it('crosses every workspace with every template it was given', () => {
    const entries = startEntries([
      { workspace: ws('w1', 'termscape'), templates: [tpl('claude'), tpl('codex')] },
      { workspace: ws('w2', 'website'), templates: [tpl('claude')] },
    ]);
    expect(entries.map((e) => e.title)).toEqual([
      'New claude in termscape',
      'New codex in termscape',
      'New claude in website',
    ]);
  });

  it('carries what starting it actually needs', () => {
    const [entry] = startEntries([
      { workspace: ws('w1', 'termscape'), templates: [tpl('claude')] },
    ]);
    expect(entry).toMatchObject({ kind: 'start', workspaceId: 'w1', profile: 'claude' });
  });

  it('names the agent only when the template is not simply that agent', () => {
    const entries = startEntries([
      { workspace: ws('w1', 'termscape'), templates: [tpl('claude'), tpl('reviewer', 'codex')] },
    ]);
    expect(entries[0]!.hint).toBe('');
    expect(entries[1]!.hint).toBe('codex');
  });

  it('offers nothing for a workspace whose machine can start nothing', () => {
    // The caller does the filtering, because whether an agent exists is the
    // other machine's answer; this is the half that must not invent a row.
    expect(startEntries([{ workspace: ws('w1', 'termscape'), templates: [] }])).toEqual([]);
  });

  it('is searchable by either half', () => {
    const entries = startEntries([
      { workspace: ws('w1', 'termscape'), templates: [tpl('claude'), tpl('codex')] },
      { workspace: ws('w2', 'website'), templates: [tpl('claude'), tpl('codex')] },
    ]);
    const hit = (q: string) => rank(entries, q, (e) => e.title).map((r) => r.item.title);
    // The agent narrows to every workspace it could run in. Sorted rather
    // than compared in order: the two match equally well and the shorter
    // title wins the tie, so the order here is workspace name length, which
    // is not a property worth pinning.
    expect(hit('codex').sort()).toEqual(['New codex in termscape', 'New codex in website']);
    // ...and the workspace to every agent it could hold.
    expect(hit('website').sort()).toEqual(['New claude in website', 'New codex in website']);
    // Both, in the order the row is written.
    expect(hit('claude in web')[0]).toBe('New claude in website');
  });
});
