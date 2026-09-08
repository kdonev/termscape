import { describe, expect, it } from 'vitest';
import { splitChunks } from '../src/session/pty.js';

/*
 * How a large write reaches a PTY.
 *
 * A paste is one write here but not on the far side: a pty's input buffer is
 * small - 4KB on Linux, and ConPTY's is no more generous - and a writer that
 * fills it faster than the program drains it loses the remainder with no error
 * anywhere. An agent handed a long instruction acts on the first few lines of
 * it and never sees the rest, which is worse than failing. So anything past
 * one chunk is fed in paced pieces, and the pieces have to add back up to
 * exactly what was written.
 */
describe('splitChunks', () => {
  it('leaves anything that already fits alone', () => {
    expect(splitChunks('hello', 1024)).toEqual(['hello']);
    expect(splitChunks('', 1024)).toEqual([]);
  });

  it('splits at the size and loses nothing', () => {
    const text = 'x'.repeat(2500);
    const parts = splitChunks(text, 1024);
    expect(parts.map((p) => p.length)).toEqual([1024, 1024, 452]);
    expect(parts.join('')).toBe(text);
  });

  it('never splits a surrogate pair', () => {
    // A lone half reaches the program as a replacement character and corrupts
    // whatever emoji or CJK text it came from. The chunk goes short instead.
    const text = 'ab' + '\u{1F600}'.repeat(4);
    const parts = splitChunks(text, 3);
    const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
    const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
    for (const p of parts) {
      expect(isHigh(p.charCodeAt(p.length - 1))).toBe(false);
      expect(isLow(p.charCodeAt(0))).toBe(false);
    }
    expect(parts.join('')).toBe(text);
  });

  it('keeps every piece within the size', () => {
    const text = '\u{1F600}'.repeat(50);
    for (const p of splitChunks(text, 7)) expect(p.length).toBeLessThanOrEqual(7);
  });
});
