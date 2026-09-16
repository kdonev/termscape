/**
 * Where a terminal was scrolled to, held across a change of font size.
 *
 * Zooming the canvas re-rasterizes every terminal at a new font size (see the
 * host scaling note in Terminal.tsx), and xterm keeps its scroll position in
 * CSS pixels on a hidden scrollable element rather than in lines. Change the
 * row height underneath that element and the pixels no longer mean the same
 * line: the scroll area is resized, the browser clamps or keeps a scrollTop
 * that now points somewhere else, and xterm's scroll listener reads it back as
 * the user scrolling. A shell with any history visibly jumps through it while
 * Ctrl+wheel is only meant to zoom.
 *
 * An agent on the alternate screen has no history, which is why this only
 * ever showed in shells.
 *
 * So the line is remembered before the font changes and put back after,
 * for as long as xterm is still settling. Kept pure so it can be tested
 * without a DOM.
 */

/** The two numbers of xterm's buffer that say where the viewport is. */
export interface BufferPosition {
  /** First line on screen. */
  viewportY: number;
  /** First line on screen when scrolled all the way down. */
  baseY: number;
}

export interface ScrollPin {
  line: number;
  /**
   * Following the output rather than parked on a line. Held as its own fact
   * because output that arrives mid-zoom moves the bottom, and a terminal that
   * was following it should still be following it afterwards.
   */
  bottom: boolean;
}

export function pinScroll(pos: BufferPosition): ScrollPin {
  return { line: pos.viewportY, bottom: pos.viewportY >= pos.baseY };
}

/** What to scroll to so the pin holds again, or null when it already does. */
export function restoreScroll(pin: ScrollPin, pos: BufferPosition): number | 'bottom' | null {
  if (pin.bottom) return pos.viewportY === pos.baseY ? null : 'bottom';
  const line = Math.min(pin.line, pos.baseY);
  return pos.viewportY === line ? null : line;
}
