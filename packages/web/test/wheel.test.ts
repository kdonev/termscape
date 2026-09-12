import { describe, expect, it } from 'vitest';
import { PAGE_DOWN, PAGE_UP, wheelAction, wheelKey } from '../src/window/wheel.js';

/*
 * The case this exists for is the last one: a window where nothing asked for
 * mouse reports and there is no scrollback either, which on a real terminal
 * means the wheel is simply dead.
 *
 * That combination is what ConPTY before Windows 11 22H2 produces. It renders
 * the program's output into its own buffer rather than passing it through, so
 * the program's request for mouse reporting never reaches xterm, and the
 * program redraws in place so no history accumulates. Measured on such a
 * window, injected wheel reports moved 0 of 23 rows and PageUp moved 17 - the
 * program was reachable the whole time, just not by mouse.
 */

const ctx = (over: Partial<Parameters<typeof wheelAction>[0]> = {}) => ({
  mouseTracking: 'none' as const,
  totalLines: 23,
  rows: 23,
  ...over,
});

describe('wheelAction', () => {
  it('leaves the wheel to the program once it asks for reports', () => {
    for (const tracking of ['x10', 'vt200', 'drag', 'any'] as const) {
      expect(wheelAction(ctx({ mouseTracking: tracking }), -100)).toBe('program');
      expect(wheelAction(ctx({ mouseTracking: tracking }), 100)).toBe('program');
    }
  });

  it('still leaves it to the program when there is scrollback as well', () => {
    // Tracking wins over history: a program that asked for reports expects to
    // handle its own scrolling, and moving the viewport underneath it instead
    // would desynchronise what it thinks is on screen.
    const c = ctx({ mouseTracking: 'any', totalLines: 500 });
    expect(wheelAction(c, -100)).toBe('program');
  });

  it('moves the viewport when nobody asked but there is history', () => {
    const c = ctx({ totalLines: 500 });
    expect(wheelAction(c, -100)).toBe('scrollback');
    expect(wheelAction(c, 100)).toBe('scrollback');
  });

  it('falls back to page keys when there is no report and no history', () => {
    expect(wheelAction(ctx(), -100)).toBe('page-up');
    expect(wheelAction(ctx(), 100)).toBe('page-down');
  });

  it('treats a buffer exactly one screen tall as having no history', () => {
    // The boundary matters: `totalLines === rows` is a full screen and
    // nothing above it, which is precisely the ConPTY case.
    expect(wheelAction(ctx({ totalLines: 23, rows: 23 }), -100)).toBe('page-up');
    expect(wheelAction(ctx({ totalLines: 24, rows: 23 }), -100)).toBe('scrollback');
  });

  it('does nothing for a wheel that did not move vertically', () => {
    expect(wheelAction(ctx(), 0)).toBe('none');
    expect(wheelAction(ctx({ mouseTracking: 'any' }), 0)).toBe('none');
  });
});

describe('wheelKey', () => {
  it('spells the page keys and nothing else', () => {
    expect(wheelKey('page-up')).toBe(PAGE_UP);
    expect(wheelKey('page-down')).toBe(PAGE_DOWN);
    for (const a of ['program', 'scrollback', 'none'] as const) {
      expect(wheelKey(a)).toBeNull();
    }
  });

  it('uses the standard sequences a program will recognise', () => {
    expect(PAGE_UP).toBe('[5~');
    expect(PAGE_DOWN).toBe('[6~');
  });
});
