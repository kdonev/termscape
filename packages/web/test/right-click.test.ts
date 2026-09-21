import { describe, expect, it } from 'vitest';
import { rightClickAction } from '../src/window/rightClick.js';

/*
 * The decision table: right-click copies or pastes like conhost and Windows
 * Terminal, even over a program that asked for mouse reports (issue 33), and
 * Shift is what hands the button to such a program.
 *
 *   mouseTracking | shift | selection | action
 *   --------------+-------+-----------+--------
 *   any value     | no    | yes       | copy
 *   any value     | no    | no        | paste
 *   none          | yes   | yes       | copy
 *   none          | yes   | no        | paste
 *   not none      | yes   | any       | program
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

  it('copies or pastes even when a program asked for reports', () => {
    for (const tracking of ['x10', 'vt200', 'drag', 'any'] as const) {
      expect(rightClickAction(ctx({ mouseTracking: tracking, hasSelection: false }))).toBe('paste');
      expect(rightClickAction(ctx({ mouseTracking: tracking, hasSelection: true }))).toBe('copy');
    }
  });

  it('gives the button to the program only with Shift', () => {
    for (const tracking of ['x10', 'vt200', 'drag', 'any'] as const) {
      const c = ctx({ mouseTracking: tracking, shift: true });
      expect(rightClickAction({ ...c, hasSelection: false })).toBe('program');
      expect(rightClickAction({ ...c, hasSelection: true })).toBe('program');
    }
  });
});
