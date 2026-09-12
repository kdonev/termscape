import { describe, expect, it } from 'vitest';
import { PollWatch, POLL_WINDOW_MS, POLL_NUDGE_AFTER } from '../src/agents/polling.js';

/**
 * PollWatch alone, on timestamps we choose - no real clock, no hub. Every
 * case here is a step of the loop issue #10 reported: an agent sends a
 * question, then calls read_screen on the same target until it gives up.
 */

describe('PollWatch', () => {
  it('stays silent for the first two reads', () => {
    const w = new PollWatch();
    expect(w.noteRead('a', 'b', 0)).toBeNull();
    expect(w.noteRead('a', 'b', 1)).toBeNull();
  });

  it('speaks from the third read onward', () => {
    const w = new PollWatch();
    expect(w.noteRead('a', 'b', 0)).toBeNull();
    expect(w.noteRead('a', 'b', 1)).toBeNull();
    expect(w.noteRead('a', 'b', 2)).not.toBeNull();
    // Still speaks on a fourth - the loop has not stopped just because it was
    // told to once.
    expect(w.noteRead('a', 'b', 3)).not.toBeNull();
  });

  it('names the question when a send preceded the reads', () => {
    const w = new PollWatch();
    w.noteMessage('a', 'b', 0);
    w.noteRead('a', 'b', 1);
    w.noteRead('a', 'b', 2);
    const note = w.noteRead('a', 'b', 3);
    expect(note).toMatch(/asked b something/);
    expect(note).toMatch(/stop here and wait/i);
  });

  it('gives the plain wording when no question is outstanding', () => {
    const w = new PollWatch();
    w.noteRead('a', 'b', 0);
    w.noteRead('a', 'b', 1);
    const note = w.noteRead('a', 'b', 2);
    expect(note).toMatch(/read this screen 3 times/);
    expect(note).toMatch(/list_agents/);
    expect(note).not.toMatch(/asked/);
  });

  it('forgets a read that has aged past the window', () => {
    const w = new PollWatch();
    expect(w.noteRead('a', 'b', 0)).toBeNull();
    expect(w.noteRead('a', 'b', 1)).toBeNull();
    // The next read arrives after the first two have fallen out of the
    // window, so it is the only one left in play - a first read, not a third.
    expect(w.noteRead('a', 'b', POLL_WINDOW_MS + 2)).toBeNull();
  });

  it('keeps two callers watching the same target apart', () => {
    const w = new PollWatch();
    expect(w.noteRead('a', 'target', 0)).toBeNull();
    expect(w.noteRead('a', 'target', 1)).toBeNull();
    // c's first two reads of the same target do not inherit a's count.
    expect(w.noteRead('c', 'target', 2)).toBeNull();
    expect(w.noteRead('c', 'target', 3)).toBeNull();
    expect(w.noteRead('a', 'target', 4)).not.toBeNull();
  });

  it('does not let an outstanding question from someone else count as this reader\'s', () => {
    const w = new PollWatch();
    // b asked a something; that must not make a's reads of b look answered.
    w.noteMessage('b', 'a', 0);
    w.noteRead('a', 'b', 1);
    w.noteRead('a', 'b', 2);
    const note = w.noteRead('a', 'b', 3);
    expect(note).not.toMatch(/asked/);
  });

  it('exports the threshold the wording is built from', () => {
    expect(POLL_NUDGE_AFTER).toBe(3);
  });
});
