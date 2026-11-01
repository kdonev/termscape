/**
 * Badges for jumping to a window by typing (issue 52).
 *
 * On a canvas holding a dozen agents, "press the arrow key four times" is a
 * worse answer than "press the letter on the one you are looking at", which
 * is what this is for: every window wears a badge, you type it, you land
 * there with the keyboard.
 *
 * ## Why every badge is the same length
 *
 * Mixed lengths - `a` for the first nine, `aa` for the rest - make `a`
 * ambiguous: it is both a complete badge and the start of another, so the
 * jump has to either wait on a timeout or need a terminator key. Uniform
 * length removes the question. One alphabet's worth of windows get one
 * letter each; past that everything is two, which covers 81 windows and is
 * still two keystrokes.
 *
 * Kept pure so it can be tested without a DOM, like keymap.ts.
 */

/**
 * The letters badges are built from, in the order they are handed out.
 *
 * The home row, left hand then right, so the first badges on a small canvas
 * are the easiest keys to hit. `g` and `h` are included despite being a
 * stretch: dropping them to eight would cost a whole row of single-letter
 * badges to save very little.
 */
export const LABEL_ALPHABET = 'asdfghjkl';

/**
 * `count` badges, all the same length.
 *
 * Returns fewer than asked for only when the alphabet cannot cover it even
 * with two letters, which at 81 windows is past the point where a canvas is
 * navigable at all; the windows left over simply get no badge rather than
 * sharing one.
 */
export function assignLabels(count: number, alphabet = LABEL_ALPHABET): string[] {
  const letters = [...alphabet];
  if (count <= 0 || letters.length === 0) return [];
  if (count <= letters.length) return letters.slice(0, count);

  const pairs: string[] = [];
  for (const a of letters) {
    for (const b of letters) {
      if (pairs.length === count) return pairs;
      pairs.push(a + b);
    }
  }
  return pairs;
}

/** What typing `typed` so far has narrowed the badges down to. */
export interface LabelMatch {
  /** The index of the one badge typed in full, or null. */
  index: number | null;
  /** How many badges still start with what has been typed. */
  remaining: number;
}

/**
 * Resolve what has been typed against the badges.
 *
 * `remaining: 0` means the keys cannot become any badge - the caller ends the
 * jump rather than leaving the user typing into something that will never
 * match. Because badges are of uniform length, an exact match is never also a
 * prefix of another, so `index` being set is final.
 */
export function matchLabel(labels: readonly string[], typed: string): LabelMatch {
  if (typed === '') return { index: null, remaining: labels.length };
  let index: number | null = null;
  let remaining = 0;
  labels.forEach((label, i) => {
    if (label === typed) index = i;
    if (label.startsWith(typed)) remaining += 1;
  });
  return { index, remaining };
}
