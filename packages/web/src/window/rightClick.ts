/**
 * What a right-click over a terminal should actually do.
 *
 * A plain shell never asks for mouse reports, so xterm drops button 2 on the
 * floor - there is no report to encode, because nothing asked for one. That
 * used to leave the click with nowhere to go at all: the context menu was
 * suppressed (see the comment at its call site in Terminal.tsx) on the theory
 * that the program owned the button, but a program that never asked for it
 * was not there to receive it either. The user got neither the terminal's
 * copy/paste nor the browser's.
 *
 * The fix is the convention conhost and Windows Terminal both use: right-click
 * copies the current selection, or pastes the clipboard when there is none.
 * copy wins over paste when a selection exists because a selection is
 * something the user just made on purpose - overwriting it with a paste would
 * discard that gesture rather than serve it.
 *
 * A program that *did* ask for mouse reports keeps the button by default, the
 * same way it keeps the wheel in wheel.ts: it is expecting to see button 2
 * itself, most often to open its own context menu or extend a selection of
 * its own. Shift is the escape hatch that takes the button back, exactly as
 * Shift is what every real terminal uses to reach past a mouse-hungry program.
 *
 * Kept pure and kept here rather than inline in the component so it can be
 * tested without a DOM, which is the only environment the web tests have.
 */
import type { MouseTracking } from './wheel.js';

export interface RightClickContext {
  /** `none` means no program ever asked for mouse reports. */
  mouseTracking: MouseTracking;
  /** Whether the terminal currently has a selection. */
  hasSelection: boolean;
  /** Whether Shift was held, the override that reclaims the button. */
  shift: boolean;
}

export type RightClickAction = 'program' | 'copy' | 'paste';

export function rightClickAction(ctx: RightClickContext): RightClickAction {
  // The program owns the button the moment it asks for reports, unless Shift
  // says otherwise - the same deal a mouse-hungry program gets on the wheel.
  if (ctx.mouseTracking !== 'none' && !ctx.shift) return 'program';

  return ctx.hasSelection ? 'copy' : 'paste';
}
