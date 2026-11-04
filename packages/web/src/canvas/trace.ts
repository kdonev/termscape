import type { Viewport } from '@termscape/protocol';
import { debug } from '../debug.js';
import { BASE_FONT_SIZE, type Rect } from './viewport.js';

/**
 * The `viewport` trace: every zoom and pan decision the canvas makes.
 *
 * Why it exists, and why it is kept whether or not tracing is on (see
 * debug.ts): a view that lands somewhere wrong is reported as "the zoom is off
 * and it does not focus properly", which is a description of the result and
 * says nothing about which step produced it. The canvas decides a view in
 * several of them - the rect a command picked, the fill it framed it at, the
 * device-pixel alignment that nudges the zoom afterwards, and whatever a
 * gesture did before all of it - and from the finished view they cannot be
 * told apart. Each one writes a line here instead, so the next report settles
 * it instead of starting an argument.
 *
 * Nothing private goes in. Session ids are already in the hub's half of a
 * report, geometry and timings belong to nobody, and window titles, addresses,
 * terminal contents and the canvas token stay out - the file is meant to be
 * sendable (bug-report.ts).
 */

/** Two decimals, without the trailing zeroes that make a line hard to scan. */
function n(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(v);
}

/** A viewport in one token: the zoom, then where the world's origin sits. */
export function fmtViewport(v: Viewport): string {
  return `zoom=${n(v.zoom)} pan=${n(v.panX)},${n(v.panY)}`;
}

/** A rect in one token, in the `x,y wxh` order the CSS and the hub both use. */
export function fmtRect(r: Rect): string {
  return `${n(r.x)},${n(r.y)} ${n(r.w)}x${n(r.h)}`;
}

/**
 * How much of the canvas the panel is sitting on top of.
 *
 * The panel is absolutely positioned over the canvas rather than beside it
 * (styles.css), while the canvas measures its own full width - so a view that
 * is correctly centred in the canvas is off-centre on the part of it anyone
 * can see, by however wide the panel is. That is invisible in a viewport and a
 * rect, so it is measured from the DOM and written down with them.
 *
 * Read at trace time because the width is the panel's own state and its
 * `--panel-width` is a CSS variable; `offsetWidth` is the one number that is
 * true whatever set it. Guarded: a trace must never be the thing that throws.
 */
export function fmtObscured(): string {
  try {
    const el = document.querySelector('.panel.open');
    if (!el) return 'panel=closed';
    return `panel=open:${Math.round((el as HTMLElement).offsetWidth)}px`;
  } catch {
    return 'panel=?';
  }
}

/** The canvas's own geometry, as everything below measures against it. */
export function traceCanvasSize(w: number, h: number, dpr: number): void {
  debug(
    'viewport',
    `canvas ${w}x${h} dpr=${n(dpr)} baseFont=${BASE_FONT_SIZE} ${fmtObscured()}`,
  );
}

/**
 * A command that framed something: which rect, how, and what it asked for.
 *
 * `what` names the command (`focus`, `ladder-in`, `jump-open`, ...) so the
 * line says which of them chose this view, and `target` is the rect it framed
 * - the two facts that are gone from the finished viewport.
 */
export function traceFrame(
  what: string,
  target: Rect | null,
  from: Viewport,
  to: Viewport,
  size: { w: number; h: number },
  extra = '',
): void {
  debug(
    'viewport',
    `${what} ${target ? `target=(${fmtRect(target)}) ` : ''}` +
      `canvas=${size.w}x${size.h} ${fmtObscured()} ` +
      `${fmtViewport(from)} -> ${fmtViewport(to)}${extra ? ` ${extra}` : ''}`,
  );
}

/**
 * The device-pixel alignment nudging a view that was already decided.
 *
 * Logged with the zoom change as a percentage because that is the number that
 * says whether it is the suspect: the nudge is bounded by half a device pixel
 * of text, which at devicePixelRatio 1 is a step of 1/12 - so a few percent is
 * expected and anything more is not. It is taken about the viewport centre
 * while a gesture zooms about the pointer, so a large nudge moves whatever was
 * under the pointer, which is exactly what "the zoom is off" looks like.
 */
export function traceAlign(from: Viewport, to: Viewport): void {
  const dz = from.zoom > 0 ? ((to.zoom - from.zoom) / from.zoom) * 100 : 0;
  debug(
    'viewport',
    `align ${fmtViewport(from)} -> ${fmtViewport(to)} dzoom=${n(dz)}%`,
  );
}

/** A gesture's verdict: what it asked for, over how long, and what it did. */
export function traceGesture(
  kind: 'pinch' | 'wheel',
  b: { ratio: number; durationMs: number; events: number },
  intent: 'in' | 'out' | null,
  outcome: string,
): void {
  debug(
    'viewport',
    `gesture ${kind} ratio=${n(b.ratio)} ms=${Math.round(b.durationMs)} ` +
      `events=${b.events} intent=${intent ?? 'none'} -> ${outcome}`,
  );
}

/** One rung of the zoom ladder, and the rungs it was chosen from. */
export function traceLadder(dir: 'in' | 'out', rungs: Rect[], to: Viewport | null): void {
  debug(
    'viewport',
    `ladder ${dir} rungs=[${rungs.map((r) => `(${fmtRect(r)})`).join(' ')}] ` +
      `-> ${to ? fmtViewport(to) : 'nothing to step to'}`,
  );
}

/** The render scale every terminal rasterizes at, and the zoom behind it. */
export function traceRenderScale(zoom: number, dpr: number, scale: number): void {
  debug(
    'viewport',
    `renderScale ${n(scale)} for zoom=${n(zoom)} dpr=${n(dpr)} ` +
      `deviceFont=${n(BASE_FONT_SIZE * scale * dpr)}`,
  );
}
