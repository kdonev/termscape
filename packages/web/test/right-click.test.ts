import { describe, expect, it } from 'vitest';
import { rightClickAction } from '../src/window/rightClick.js';

/*
 * The decision table this exercises, from the conhost / Windows Terminal
 * convention the fix follows:
 *
 *   mouseTracking | shift | selection | action
 *   --------------+-------+-----------+--------
 *   none          | any   | yes       | copy
 *   none          | any   | no        | paste
 *   not none      | no    | any       | program
 *   not none      | yes   | yes       | copy
 *   not none      | yes   | no        | paste
 */

const ctx = (over: Partial<Parameters<typeof rightClickAction>[0]> = {}) => ({
  mouseTracking: 'none' as const,
  hasSelection: false,
  shift: false,
  ...over,
});

describe('rightClickAction', () => {
  it('copies the selection when nobody asked for mouse reports', () => {
    expect(rightClickAction(ctx({ hasSelection: true }))).toBe('copy');
    expect(rightClickAction(ctx({ hasSelection: true, shift: true }))).toBe('copy');
  });

  it('pastes when nobody asked for mouse reports and nothing is selected', () => {
    expect(rightClickAction(ctx({ hasSelection: false }))).toBe('paste');
    expect(rightClickAction(ctx({ hasSelection: false, shift: true }))).toBe('paste');
  });

  it('leaves the button to the program once it asks for reports', () => {
    for (const tracking of ['x10', 'vt200', 'drag', 'any'] as const) {
      expect(rightClickAction(ctx({ mouseTracking: tracking, hasSelection: false }))).toBe('program');
      expect(rightClickAction(ctx({ mouseTracking: tracking, hasSelection: true }))).toBe('program');
    }
  });

  it('still goes to the program with a selection but no Shift', () => {
    // The boundary worth naming: a selection alone is not enough to reclaim
    // the button from a program that asked for it - only Shift is.
    const c = ctx({ mouseTracking: 'any', hasSelection: true });
    expect(rightClickAction(c)).toBe('program');
  });

  it('lets Shift reclaim the button from the program', () => {
    // The other boundary: tracking is on, but Shift wins over it, exactly as
    // it does in every real terminal.
    const c = ctx({ mouseTracking: 'any', shift: true });
    expect(rightClickAction({ ...c, hasSelection: true })).toBe('copy');
    expect(rightClickAction({ ...c, hasSelection: false })).toBe('paste');
  });
});
