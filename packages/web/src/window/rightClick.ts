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
 * That holds even when a program has asked for mouse reports. Claude Code
 * turns on full tracking and does nothing with button 2, so giving the button
 * to the program left right-click dead in exactly the windows the canvas is
 * for (issue 33). Shift is the way through instead: Shift+right-click sends
 * the button to a program that asked for it - the reverse of the wheel in
 * wheel.ts, where the program's claim is the one that matters.
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
  /** Whether Shift was held, which hands the button to a program that asked. */
  shift: boolean;
}

export type RightClickAction = 'program' | 'copy' | 'paste';

export function rightClickAction(ctx: RightClickContext): RightClickAction {
  // Only Shift gives the button to the program, and only if it asked for
  // reports - otherwise there is nobody to give it to.
  if (ctx.shift && ctx.mouseTracking !== 'none') return 'program';

  return ctx.hasSelection ? 'copy' : 'paste';
}
