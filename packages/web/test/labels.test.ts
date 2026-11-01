import { describe, expect, it } from 'vitest';
import { assignLabels, matchLabel, LABEL_ALPHABET } from '../src/canvas/labels.js';

/*
 * Badges for the jump (issue 52). The property that matters most is the
 * uniform length: it is what makes a completed badge unambiguous, so the jump
 * never needs a timeout or a terminator key.
 */

describe('assignLabels', () => {
  it('hands out single letters while the alphabet covers it', () => {
    expect(assignLabels(3)).toEqual(['a', 's', 'd']);
    expect(assignLabels(LABEL_ALPHABET.length)).toEqual([...LABEL_ALPHABET]);
  });

  it('goes to two letters for everything the moment one is not enough', () => {
    const labels = assignLabels(LABEL_ALPHABET.length + 1);
    expect(labels).toHaveLength(LABEL_ALPHABET.length + 1);
    // Uniform: not "a" for the first nine and "aa" for the tenth.
    expect(new Set(labels.map((l) => l.length))).toEqual(new Set([2]));
    expect(labels[0]).toBe('aa');
    expect(labels[1]).toBe('as');
  });

  it('never repeats a badge', () => {
    for (const n of [1, 9, 10, 40, 81]) {
      const labels = assignLabels(n);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('gives nothing for an empty canvas', () => {
    expect(assignLabels(0)).toEqual([]);
    expect(assignLabels(-1)).toEqual([]);
  });

  it('runs out rather than sharing a badge past what two letters cover', () => {
    const max = LABEL_ALPHABET.length ** 2;
    expect(assignLabels(max)).toHaveLength(max);
    // A canvas this size is unnavigable anyway; the point is that the windows
    // left over get no badge rather than one that is also someone else's.
    const over = assignLabels(max + 5);
    expect(over).toHaveLength(max);
    expect(new Set(over).size).toBe(max);
  });
});

describe('matchLabel', () => {
  const labels = assignLabels(12); // two letters each

  it('counts everything as still possible before anything is typed', () => {
    expect(matchLabel(labels, '')).toEqual({ index: null, remaining: 12 });
  });

  it('narrows on a prefix without picking anything yet', () => {
    const m = matchLabel(labels, 'a');
    expect(m.index).toBeNull();
    expect(m.remaining).toBe(9);
  });

  it('picks the badge once it is typed in full', () => {
    expect(matchLabel(labels, 'as').index).toBe(1);
    expect(matchLabel(labels, 'ad').index).toBe(2);
  });

  it('reports nothing left when the keys cannot become a badge', () => {
    // The caller ends the jump on this rather than leaving the user typing
    // into something that will never match.
    expect(matchLabel(labels, 'z')).toEqual({ index: null, remaining: 0 });
    expect(matchLabel(labels, 'az')).toEqual({ index: null, remaining: 0 });
  });

  it('treats a full match as final, since no badge is a prefix of another', () => {
    const single = assignLabels(4);
    const m = matchLabel(single, 'a');
    expect(m.index).toBe(0);
    expect(m.remaining).toBe(1);
  });
});
