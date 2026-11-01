/**
 * The command palette's matching and its list of commands (issue 52).
 *
 * The palette is what keeps the keymap small: anything that does not earn a
 * chord of its own lives here, found by typing part of its name. It also
 * answers "which agent was that?" - every window is in the list under its
 * address, so a canvas too big to scan by eye is still one search away.
 *
 * Kept pure so it can be tested without a DOM, like keymap.ts and labels.ts.
 */
import type { Action } from './keymap.js';

/** One row of the palette. */
export type PaletteEntry =
  /** Go to a window, by the address on its title bar. */
  | { kind: 'session'; id: string; title: string; hint: string }
  /** Run something the keys can also do. */
  | { kind: 'command'; action: Action; title: string; hint: string }
  /** Start a new agent: one entry per workspace and template that fit. */
  | {
      kind: 'start';
      workspaceId: string;
      /** The template id, which is what `startSession` calls a profile. */
      profile: string;
      title: string;
      hint: string;
    };

/* ------------------------------------------------------------ matching */

export interface FuzzyHit {
  score: number;
  /** Which characters of the text matched, for highlighting. */
  indices: number[];
}

/** Characters a new word starts after. */
const BOUNDARY = /[\s/\-_.:]/;

/** What a set of matched positions is worth. */
function scoreIndices(t: string, indices: readonly number[]): number {
  let score = 0;
  let prev = -2;
  for (const at of indices) {
    let s = 1;
    // Runs read as a real match rather than scattered letters, so they are
    // worth much more than the characters themselves.
    if (at === prev + 1) s += 8;
    if (at === 0 || BOUNDARY.test(t[at - 1]!)) s += 6;
    // Skipping a long way to find the next character is weak evidence.
    s -= Math.min(4, at - (prev + 1));
    score += s;
    prev = at;
  }
  return score;
}

/**
 * Subsequence match, pulled as tight as it will go.
 *
 * A plain leftmost scan is not enough: `note` against "new note" takes the
 * `n` of "new" and highlights `n`ew n`ote`, which both scores badly and looks
 * wrong. So the forward scan is only used to prove a match exists and find
 * where it can end, and a backward pass then drags every character as late as
 * it can go - which lands the whole query on the word the user meant.
 *
 * Still not an optimal alignment, which would need a full search per item per
 * keystroke. Between the two passes and the acronym pass below, the cases
 * that remain are ones nobody types.
 */
function subsequence(t: string, q: string): FuzzyHit | null {
  const chars = [...q];
  let from = 0;
  for (const ch of chars) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    from = at + 1;
  }

  // `from - 1` is where the last character landed going forwards; nothing
  // can end later than that, so the backward pass starts there.
  const indices: number[] = new Array(chars.length);
  indices[chars.length - 1] = from - 1;
  for (let i = chars.length - 2; i >= 0; i--) {
    indices[i] = t.lastIndexOf(chars[i]!, indices[i + 1]! - 1);
  }
  return { score: scoreIndices(t, indices), indices };
}

/** Where each word of `t` starts. */
function wordStarts(t: string): number[] {
  const starts: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (i === 0 ? /\w/.test(t[i]!) : BOUNDARY.test(t[i - 1]!) && /\w/.test(t[i]!)) starts.push(i);
  }
  return starts;
}

/**
 * The query read as initials: `na` for "new agent", `ws` for "workspace
 * shell". Scored high, because someone typing initials almost always means
 * them, and greedy subsequence matching would score them poorly.
 */
function acronym(t: string, q: string): FuzzyHit | null {
  const starts = wordStarts(t);
  if (q.length > starts.length) return null;
  const indices: number[] = [];
  let at = 0;
  for (const ch of q) {
    // Walk forward through the word starts rather than requiring the first
    // n: "new agent here" should still answer to `nh`.
    while (at < starts.length && t[starts[at]!] !== ch) at += 1;
    if (at === starts.length) return null;
    indices.push(starts[at]!);
    at += 1;
  }
  return { score: 12 * q.length - indices[0]!, indices };
}

/**
 * How well `text` answers `query`, or null if it does not.
 *
 * An empty query matches everything with no highlight, so the palette opens
 * showing the whole list rather than nothing.
 */
export function fuzzy(text: string, query: string): FuzzyHit | null {
  if (query === '') return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const a = subsequence(t, q);
  const b = acronym(t, q);
  const best = !a ? b : !b ? a : b.score > a.score ? b : a;
  if (!best) return null;
  // A shorter title matching the same query is more likely the thing meant,
  // and this is small enough to only break ties.
  return { ...best, score: best.score - text.length * 0.05 };
}

/** The entries that answer `query`, best first. */
export function rank<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
): { item: T; indices: number[] }[] {
  const scored: { item: T; indices: number[]; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    const hit = fuzzy(textOf(item), query);
    if (hit) scored.push({ item, indices: hit.indices, score: hit.score, at });
  });
  // `at` breaks ties, so the order the caller chose survives an empty query
  // and equal scores - the list must not reshuffle under the cursor.
  scored.sort((x, y) => y.score - x.score || x.at - y.at);
  return scored.map(({ item, indices }) => ({ item, indices }));
}

/* ------------------------------------------------------------ commands */

/**
 * What the palette can run, in the order it offers them.
 *
 * Only the commands that make sense as a thing to pick from a list: moving
 * the selection one window left is a key, not an entry. `mod` is spelled by
 * the caller, which knows whether it is on a Mac.
 */
export function commandEntries(mod: string): PaletteEntry[] {
  const cmd = (action: Action, title: string, hint: string): PaletteEntry => ({
    kind: 'command',
    action,
    title,
    hint,
  });
  return [
    cmd('labelJump', 'Jump to a window by its badge', `${mod}+Shift+F`),
    cmd('zoom.in', 'Zoom in to the selected window', `${mod}+ +`),
    cmd('zoom.out', 'Zoom out to the workspace, then everything', `${mod}+ -`),
    cmd('panel', 'Machines panel', `${mod}+Shift+E`),
    cmd('mode.toggle', 'Canvas mode', `${mod}+Shift+Space`),
    cmd('new.agent', 'New agent in this workspace', 'a'),
    cmd('new.note', 'New note', 'n'),
    cmd('new.workspace', 'New workspace', 'Shift+W'),
    cmd('session.restart', 'Resume or restart the selected agent', 'r'),
    cmd('session.close', 'Remove the selected window', 'x'),
    cmd('help', 'Keyboard shortcuts', '?'),
  ];
}

/* ----------------------------------------------------- starting an agent */

/** A workspace and the templates that can actually be started in it. */
export interface StartGroup {
  workspace: { id: string; name: string };
  /**
   * Already filtered by the caller: a template with a configuration error, or
   * naming an agent that is not installed on that workspace's machine, is not
   * offered. Which machine that is depends on the workspace, so the join
   * cannot happen here.
   */
  templates: readonly { id: string; agent: string }[];
}

/**
 * Every workspace crossed with every template, as "start this there".
 *
 * The whole cross product on purpose: with a handful of workspaces and a
 * handful of agents it is still only a few dozen rows, and the palette is a
 * search box rather than a menu - typing the agent narrows to every workspace
 * it could run in, typing the workspace narrows to every agent it could hold.
 * That is strictly more direct than opening a dialog and picking twice.
 *
 * Note the one limitation: the query matches the title as written, so
 * "claude termscape" finds nothing while "termscape" and "claude" each find
 * plenty. Typing both parts in the other order is rare enough not to be worth
 * indexing the row twice and making the highlighting lie.
 */
export function startEntries(groups: readonly StartGroup[]): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const { workspace, templates } of groups) {
    for (const t of templates) {
      entries.push({
        kind: 'start',
        workspaceId: workspace.id,
        profile: t.id,
        title: `New ${t.id} in ${workspace.name}`,
        // Only when the template is not simply the agent's own: a stored
        // template named "reviewer" has to say what it actually runs.
        hint: t.id === t.agent ? '' : t.agent,
      });
    }
  }
  return entries;
}
