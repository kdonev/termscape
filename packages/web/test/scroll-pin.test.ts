import { describe, expect, it } from 'vitest';
import { pinScroll, restoreScroll } from '../src/window/scrollPin.js';

/*
 * A Ctrl+wheel zoom changes every terminal's font size, and xterm keeps its
 * scroll position in pixels - so without a pin a shell with history scrolls
 * while the canvas zooms.
 */

describe('scroll pin', () => {
  it('holds a terminal that was following its output at the bottom', () => {
    const pin = pinScroll({ viewportY: 120, baseY: 120 });
    expect(pin.bottom).toBe(true);
    // The font change dragged it up a few lines.
    expect(restoreScroll(pin, { viewportY: 104, baseY: 120 })).toBe('bottom');
    expect(restoreScroll(pin, { viewportY: 120, baseY: 120 })).toBeNull();
  });

  it('keeps following the bottom when output arrived mid-zoom', () => {
    const pin = pinScroll({ viewportY: 120, baseY: 120 });
    expect(restoreScroll(pin, { viewportY: 120, baseY: 130 })).toBe('bottom');
  });

  it('puts a terminal parked in its history back on the same line', () => {
    const pin = pinScroll({ viewportY: 40, baseY: 120 });
    expect(pin.bottom).toBe(false);
    expect(restoreScroll(pin, { viewportY: 52, baseY: 120 })).toBe(40);
    expect(restoreScroll(pin, { viewportY: 31, baseY: 120 })).toBe(40);
    expect(restoreScroll(pin, { viewportY: 40, baseY: 120 })).toBeNull();
  });

  it('never asks for a line past the bottom', () => {
    const pin = { line: 90, bottom: false };
    expect(restoreScroll(pin, { viewportY: 10, baseY: 60 })).toBe(60);
  });

  it('has nothing to do for a buffer with no history', () => {
    const pin = pinScroll({ viewportY: 0, baseY: 0 });
    expect(restoreScroll(pin, { viewportY: 0, baseY: 0 })).toBeNull();
  });
});
