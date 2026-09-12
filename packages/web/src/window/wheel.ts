/**
 * What a wheel over a terminal should actually do.
 *
 * Three outcomes, and the first two are xterm's own and need no help:
 *
 * - The program asked for mouse reports, so the wheel is its business. xterm
 *   encodes a report and we stay out of the way.
 * - Nobody asked, but this window has scrollback, so the wheel moves the
 *   viewport through it exactly as a real terminal's would.
 * - Nobody asked *and* there is nothing to scroll to. A real terminal is out
 *   of options here; we are not, because the program is still reachable by
 *   key.
 *
 * That third case is not hypothetical. ConPTY before Windows 11 22H2 parses a
 * program's output into its own buffer and re-renders it, and the program's
 * VT request for mouse reporting does not survive that - so xterm never learns
 * anything wants the mouse. The program meanwhile redraws in place and never
 * produces scrollback either. The result is a window that ignores the wheel
 * completely, even though the very same program scrolls fine when sent a key.
 * Measured on such a window: wheel reports moved 0 of 23 rows, PageUp moved 17.
 *
 * Kept pure and kept here rather than inline in the component so it can be
 * tested without a DOM, which is the only environment the web tests have.
 */

/** xterm's public spelling of what the program asked for. */
export type MouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any';

export interface WheelContext {
  /** `none` means no program ever asked for mouse reports. */
  mouseTracking: MouseTracking;
  /** Lines in the active buffer, scrollback included. */
  totalLines: number;
  /** Rows visible on screen. */
  rows: number;
}

export type WheelAction = 'program' | 'scrollback' | 'page-up' | 'page-down' | 'none';

/** PageUp / PageDown, the keys a program that ignores the mouse still takes. */
export const PAGE_UP = '\x1b[5~';
export const PAGE_DOWN = '\x1b[6~';

export function wheelAction(ctx: WheelContext, deltaY: number): WheelAction {
  // A horizontal-only or zero wheel is not a scroll; doing nothing is right.
  if (deltaY === 0) return 'none';

  // The program owns the wheel the moment it asks for reports, whatever else
  // is true - including when it is also sitting on a pile of scrollback.
  if (ctx.mouseTracking !== 'none') return 'program';

  // Anything above the visible rows is history, and moving through it is what
  // a wheel does everywhere else. Leave that to xterm.
  if (ctx.totalLines > ctx.rows) return 'scrollback';

  return deltaY < 0 ? 'page-up' : 'page-down';
}

/** The bytes for an action, or null when there is nothing to send. */
export function wheelKey(action: WheelAction): string | null {
  if (action === 'page-up') return PAGE_UP;
  if (action === 'page-down') return PAGE_DOWN;
  return null;
}
