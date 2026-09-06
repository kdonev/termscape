import type { Viewport } from '@aicanvas/protocol';

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 2.5;

/**
 * Below this zoom a terminal is unmounted and replaced by a static snapshot.
 * Live xterm instances are expensive; a canvas showing twenty of them at 20%
 * zoom would be paying full parsing and rendering cost for text nobody can
 * read. This is the single number that keeps the canvas usable at scale.
 */
export const LIVE_ZOOM_THRESHOLD = 0.6;

/**
 * Terminal text size in CSS pixels at zoom 1. Every terminal on the canvas uses
 * this one number scaled by the render scale, so they all show the same size
 * text no matter how big their windows are.
 */
export const BASE_FONT_SIZE = 12;

/** Below this the glyphs stop being legible, so we stop following the zoom. */
export const MIN_DEVICE_FONT = 9;
/**
 * Bounds the glyph atlas. Large enough to cover MAX_ZOOM at devicePixelRatio 2
 * (12 * 2.5 * 2 = 60); above that the render scale stops following the zoom and
 * the terminal is mildly magnified rather than the atlas growing without limit.
 */
export const MAX_DEVICE_FONT = 64;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen (client) coordinates -> world coordinates. */
export function screenToWorld(p: Point, v: Viewport): Point {
  return { x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom };
}

/** World coordinates -> screen (client) coordinates. */
export function worldToScreen(p: Point, v: Viewport): Point {
  return { x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY };
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * Zoom about a fixed screen point, so the world position under the cursor
 * stays under the cursor. Anything else feels like the canvas is sliding.
 */
export function zoomAt(v: Viewport, screenPoint: Point, nextZoom: number): Viewport {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(screenPoint, v);
  return {
    zoom,
    panX: screenPoint.x - world.x * zoom,
    panY: screenPoint.y - world.y * zoom,
  };
}

/* ------------------------------------------------- device-pixel alignment */

/*
 * Text on the canvas is blurry whenever the terminal's bitmap does not land on
 * whole device pixels. xterm rasterizes glyphs into a canvas sized in CSS
 * pixels times devicePixelRatio; it knows nothing about the world transform, so
 * `scale(zoom)` resamples a finished bitmap.
 *
 * The fix is to render each terminal at `renderScale` (a larger font in a
 * proportionally larger, counter-scaled host) so the bitmap comes out at
 * exactly the size it will be painted, and to nudge the zoom so that scale is a
 * whole number of device pixels of text. The nudge is bounded by half a device
 * pixel of text height, so zoom still feels continuous.
 */

/** Text height in device pixels this zoom implies, before any clamping. */
function rawDeviceFont(zoom: number, dpr: number): number {
  return BASE_FONT_SIZE * zoom * dpr;
}

/**
 * The nearest zoom whose text is a whole number of device pixels tall.
 *
 * Outside the band the render scale can follow there is no whole-pixel size to
 * align to, so the zoom is left alone: zooming out past MIN_DEVICE_FONT is the
 * LOD range where terminals are minified anyway.
 */
export function alignZoom(zoom: number, dpr: number): number {
  const raw = rawDeviceFont(zoom, dpr);
  if (!(raw >= MIN_DEVICE_FONT && raw <= MAX_DEVICE_FONT)) return clampZoom(zoom);

  const unit = BASE_FONT_SIZE * dpr;
  let device = Math.round(raw);
  // Rounding up at the very top of the range would overshoot MAX_ZOOM, and
  // clamping afterwards would throw the whole-pixel property away.
  if (device / unit > MAX_ZOOM) device = Math.floor(MAX_ZOOM * unit);
  if (device / unit < MIN_ZOOM) device = Math.ceil(MIN_ZOOM * unit);
  return device / unit;
}

/**
 * The scale terminals rasterize at. Equal to the aligned zoom wherever it can
 * be, so the bitmap maps 1:1 onto device pixels; clamped at the ends, where a
 * little resampling is better than an illegible or enormous glyph atlas.
 */
export function renderScaleFor(zoom: number, dpr: number): number {
  const device = Math.min(
    MAX_DEVICE_FONT,
    Math.max(MIN_DEVICE_FONT, Math.round(rawDeviceFont(zoom, dpr))),
  );
  return device / (BASE_FONT_SIZE * dpr);
}

/** Terminal font size in CSS px. One global value, shared by every terminal. */
export function terminalFontSize(renderScale: number): number {
  return BASE_FONT_SIZE * renderScale;
}

/**
 * Align the zoom about the viewport centre, then put the pan on whole device
 * pixels. Idempotent: this runs from an effect watching the viewport, so a
 * version that kept moving would loop.
 */
export function alignViewport(
  v: Viewport,
  viewportW: number,
  viewportH: number,
  dpr: number,
): Viewport {
  // About the centre rather than the origin, so aligning never lurches the view.
  const centred = zoomAt(v, { x: viewportW / 2, y: viewportH / 2 }, alignZoom(v.zoom, dpr));
  return {
    zoom: centred.zoom,
    panX: Math.round(centred.panX * dpr) / dpr,
    panY: Math.round(centred.panY * dpr) / dpr,
  };
}

/**
 * Round a world coordinate so it lands on a whole device pixel at this zoom.
 * Applied at paint time to window origins; the stored rect keeps its exact
 * value so dragging and the hub are unaffected.
 */
export function snapWorldPx(value: number, zoom: number, dpr: number): number {
  const unit = zoom * dpr;
  if (!Number.isFinite(unit) || unit <= 0) return value;
  return Math.round(value * unit) / unit;
}

/** The world-space rectangle currently visible, padded to pre-mount neighbours. */
export function visibleWorldRect(
  v: Viewport,
  viewportW: number,
  viewportH: number,
  padPx = 400,
): Rect {
  const tl = screenToWorld({ x: -padPx, y: -padPx }, v);
  const br = screenToWorld({ x: viewportW + padPx, y: viewportH + padPx }, v);
  return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Whether `inner` lies wholly within `outer`. The epsilon absorbs the fraction
 * of a pixel that centring and device-pixel rounding leave behind, so a rect
 * the canvas has just fitted still reads as fully visible.
 */
export function rectContains(outer: Rect, inner: Rect, epsilon = 0.5): boolean {
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.w <= outer.x + outer.w + epsilon &&
    inner.y + inner.h <= outer.y + outer.h + epsilon
  );
}

/** The pan that centres a world rect in the viewport at a given zoom. */
function centreOn(r: Rect, zoom: number, viewportW: number, viewportH: number): Viewport {
  return {
    zoom,
    panX: (viewportW - r.w * zoom) / 2 - r.x * zoom,
    panY: (viewportH - r.h * zoom) / 2 - r.y * zoom,
  };
}

/**
 * The box enclosing a set of world rects, or null for none. Width and height
 * are floored at 1 so a degenerate set still divides safely.
 */
export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/** Fit a set of world rects into the viewport with margin. */
export function fitTo(
  rects: Rect[],
  viewportW: number,
  viewportH: number,
  margin = 80,
): Viewport {
  const bounds = boundsOf(rects);
  if (!bounds) return { panX: 0, panY: 0, zoom: 1 };
  const zoom = clampZoom(
    Math.min((viewportW - margin * 2) / bounds.w, (viewportH - margin * 2) / bounds.h),
  );
  return centreOn(bounds, zoom, viewportW, viewportH);
}

/**
 * The share of the viewport a maximized window is asked to cover. Not 1: a
 * window flush against the edges reads as broken rather than focused, and the
 * gap is what tells you the canvas continues past it.
 */
export const DEFAULT_FILL = 0.9;

/**
 * Zoom and pan so one world rect covers `fill` of the viewport, centred.
 *
 * Unlike fitTo this is a fraction rather than a fixed margin, so the result
 * looks the same on a laptop and on a large display. The zoom is clamped like
 * any other, so a small window on a big screen lands centred at MAX_ZOOM
 * covering less than `fill` rather than magnifying without limit.
 */
export function focusRect(
  rect: Rect,
  viewportW: number,
  viewportH: number,
  fill = DEFAULT_FILL,
): Viewport {
  const w = Math.max(1, rect.w);
  const h = Math.max(1, rect.h);
  const zoom = clampZoom(Math.min((viewportW * fill) / w, (viewportH * fill) / h));
  return centreOn({ ...rect, w, h }, zoom, viewportW, viewportH);
}

/* --------------------------------------------------- workspace grouping */

/** Breathing room drawn around a workspace's windows. */
export const WS_PAD = 28;
/** Extra room above them for the workspace's name. */
export const WS_LABEL_H = 24;

/**
 * The box drawn around one workspace's windows. Shared by the group rendering
 * and by the pinch-out ladder, so the view a gesture flies to is by
 * construction the box the user can see.
 */
export function workspaceBounds(members: Rect[]): Rect | null {
  const b = boundsOf(members);
  if (!b) return null;
  return {
    x: b.x - WS_PAD,
    y: b.y - WS_PAD - WS_LABEL_H,
    w: b.w + WS_PAD * 2,
    h: b.h + WS_PAD * 2 + WS_LABEL_H,
  };
}

/* ----------------------------------------------------- wheel gestures */

/**
 * Idle gap that ends one wheel gesture.
 *
 * Longer than PINCH_GAP_MS, which buys a verdict at the cost of dead time the
 * user waits out. This one only has to outlast the pauses inside a single
 * continuous two-finger scroll — including the momentum tail a trackpad keeps
 * sending after the fingers lift — so it can afford to be generous.
 */
export const WHEEL_GAP_MS = 300;

export type WheelOwner = 'canvas' | 'terminal';

export interface WheelStream {
  owner: WheelOwner;
  lastAt: number;
}

/**
 * Who the wheel stream in flight belongs to, given one more event.
 *
 * Ownership is settled at the *start* of a stream and then held. Deciding it per
 * event instead — from whatever sits under the pointer right now — breaks the
 * one gesture where the canvas is the thing moving: a two-finger pan started
 * over empty canvas slides a window beneath a stationary cursor, and from that
 * moment the rest of the gesture is delivered to the terminal, which starts
 * scrolling while the canvas stops dead. Holding the owner is what makes a pan
 * finish where it started, and symmetrically keeps a terminal's scroll its own.
 *
 * Zooming is the canvas's wherever the pointer is, which is the rule the wheel
 * handler already followed.
 */
export function wheelStream(
  prev: WheelStream | null,
  ev: { now: number; zooming: boolean; overTerminal: boolean },
): WheelStream {
  if (prev && ev.now - prev.lastAt <= WHEEL_GAP_MS) {
    return { owner: prev.owner, lastAt: ev.now };
  }
  return { owner: ev.overTerminal && !ev.zooming ? 'terminal' : 'canvas', lastAt: ev.now };
}

/* ----------------------------------------------------- pinch gestures */

/*
 * A precision trackpad reports a pinch as a stream of wheel events with
 * ctrlKey set. Those already drive the continuous zoom; the recogniser below
 * watches the same stream for a *flick* — a pinch that was both fast and large
 * — and treats that as a command to snap somewhere, leaving slow deliberate
 * pinches to zoom exactly as they always have.
 */

/** The zoom multiplier one wheel tick asks for. */
/**
 * Above this, a delta is one detent of a mouse wheel rather than a moment of a
 * trackpad gesture.
 *
 * Nothing in the event says which device sent it — a mouse reports 100 pixels
 * per detent in the same `deltaMode` a trackpad streams 4s and 6s in — so size
 * is the only thing left to read. The other delta modes are lines and pages,
 * which no trackpad produces.
 */
export const WHEEL_NOTCH_MIN_DELTA = 40;

export function isWheelNotch(deltaY: number, deltaMode = 0): boolean {
  return deltaMode !== 0 || Math.abs(deltaY) >= WHEEL_NOTCH_MIN_DELTA;
}

/**
 * What one detent of a mouse wheel is worth: five of them double the zoom.
 * Small enough to arrive at a zoom rather than overshoot past it.
 */
export const WHEEL_NOTCH_FACTOR = 1.15;

export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  if (deltaY === 0) return 1;

  // One detent, one step, whatever magnitude the device picked for it — and
  // out is the exact reciprocal of in, so a notch each way is a round trip.
  // Scaling by the delta instead is what made a notch double the zoom going
  // in and quarter it coming out.
  if (isWheelNotch(deltaY, deltaMode)) {
    return deltaY < 0 ? WHEEL_NOTCH_FACTOR : 1 / WHEEL_NOTCH_FACTOR;
  }

  // A trackpad pinch is a stream, and its zoom follows the size of each
  // moment of it, which is what makes it continuous under the fingers. These
  // deltas are small by definition and never approach the clamps.
  return Math.min(5, Math.max(0.2, 1 - deltaY * 0.01));
}

/**
 * Idle gap that ends one burst of wheel detents.
 *
 * Slightly longer than the trackpad's, because detents are physical clicks
 * rather than frame-paced samples: a fast spin lands them 30-60ms apart, while
 * turning the wheel deliberately is slower than this and never accumulates a
 * burst at all. That gap is most of what separates a flick from zooming.
 */
export const WHEEL_FLICK_GAP_MS = 80;

/**
 * How far a spin has to travel to read as a flick rather than as zooming,
 * counted in detents — so a spin that doubles back cancels itself out instead
 * of adding up.
 */
export const WHEEL_FLICK_MIN_DETENTS = 4;

/**
 * And how long it may take. "Short and quick" is the whole gesture, and past
 * this a spin is someone aiming at a zoom level, however fast the wheel is
 * going. It also caps the length: at a flick's pace this is about eight
 * detents, and a longer spin than that was not a flick.
 */
export const WHEEL_FLICK_MAX_MS = 400;

/**
 * Whether a finished burst of detents reads as a flick, and in which
 * direction.
 *
 * No speed test, unlike a pinch: detents are uniform, so the count already
 * says how far, and the gap that held the burst together already said how
 * fast. Not firing is the safe failure — the zoom the spin asked for happened
 * either way.
 */
export function wheelFlickIntent(b: { ratio: number; durationMs: number }): 'in' | 'out' | null {
  if (!(b.ratio > 0) || !Number.isFinite(b.ratio)) return null;
  if (!(b.durationMs >= 0 && b.durationMs <= WHEEL_FLICK_MAX_MS)) return null;

  const detents = Math.abs(Math.log(b.ratio)) / Math.log(WHEEL_NOTCH_FACTOR);
  // Epsilon because exactly four detents is a float product of four factors.
  if (detents < WHEEL_FLICK_MIN_DETENTS - 1e-9) return null;

  return b.ratio > 1 ? 'in' : 'out';
}

/**
 * Idle gap that ends one pinch burst.
 *
 * This is dead time you can feel: the zoom stops at the pinch's last position
 * and nothing moves until it elapses, because the verdict needs the whole
 * gesture. So it wants to be as short as it can be without splitting one pinch
 * into two — a trackpad reports a pinch once per compositor frame, making this
 * four idle frames at 60Hz. Still under the canvas settle delay, so the snap is
 * decided before the viewport is ever called at rest.
 */
export const PINCH_GAP_MS = 70;

/**
 * How fast a flick has to be, in e-folds of zoom per second — |ln ratio|
 * divided by the seconds it took.
 *
 * Speed rather than a duration cap is the whole test, because "quick" is not a
 * stopwatch reading: a confident pinch that happens to run 400ms covers far
 * more ground than a careful one of the same length, and only a rate tells
 * them apart. A doubling inside 1.1s sits right on this line.
 *
 * Deliberately generous, and settled against a real trackpad rather than
 * reasoned about: a gesture that will not fire reads as broken, while one that
 * fires too eagerly is only ever a pinch away from being undone.
 */
export const PINCH_MIN_SPEED = 0.6;

/** And it has to actually travel. Below this it is a nudge, however brisk. */
export const PINCH_MIN_RATIO = 1.15;

/**
 * Past this the gesture is aiming at a zoom level rather than flicking, no
 * matter how much ground it covered on the way.
 */
export const PINCH_MAX_MS = 900;

/**
 * A trackpad pinch is a stream of small deltas; ctrl held over a mouse wheel is
 * one large event per notch. The count is what tells them apart.
 */
export const PINCH_MIN_EVENTS = 3;

export interface PinchBurst {
  /** Product of the burst's wheel factors: the zoom change that was asked for. */
  ratio: number;
  durationMs: number;
  events: number;
}

/**
 * Whether a finished burst reads as a quick pinch, and in which direction.
 *
 * The ratio is the requested zoom rather than the achieved one, so a flick
 * still registers when the canvas was already parked at a zoom limit.
 */
export function pinchIntent(b: PinchBurst): 'in' | 'out' | null {
  if (b.events < PINCH_MIN_EVENTS) return null;
  if (!(b.ratio > 0) || !Number.isFinite(b.ratio)) return null;
  if (!(b.durationMs >= 0 && b.durationMs <= PINCH_MAX_MS)) return null;

  const travel = Math.abs(Math.log(b.ratio));
  if (travel < Math.log(PINCH_MIN_RATIO)) return null;
  // A burst delivered inside a single frame has no measurable duration. It is
  // as fast as anything can be, so it passes on distance alone.
  const speed = b.durationMs > 0 ? travel / (b.durationMs / 1000) : Infinity;
  if (speed < PINCH_MIN_SPEED) return null;

  return b.ratio > 1 ? 'in' : 'out';
}

/**
 * One step out: fit the smallest of `containers` that is not already wholly on
 * screen. Containers are given innermost first — a window's workspace, then
 * every window on the canvas.
 *
 * Reading the level off the screen rather than off a stored "we are at level 2"
 * is what stops panning by hand between gestures from desyncing the ladder.
 * Null means there is nothing left to reveal, and the gesture is ignored.
 */
export function stepOutTo(
  containers: Rect[],
  v: Viewport,
  viewportW: number,
  viewportH: number,
): Viewport | null {
  const visible = visibleWorldRect(v, viewportW, viewportH, 0);
  const next = containers.find((c) => !rectContains(visible, c));
  return next ? fitTo([next], viewportW, viewportH) : null;
}

/* ----------------------------------------------------- viewport tweening */

/**
 * One frame between two viewports.
 *
 * Zoom is interpolated geometrically and the pan is derived from the world
 * point under the viewport centre, rather than lerping panX/panY directly.
 * Linear pan against exponential zoom is what makes map animations swoop out
 * and back; this holds the centre on a straight path the whole way.
 */
export function lerpViewport(
  a: Viewport,
  b: Viewport,
  t: number,
  viewportW: number,
  viewportH: number,
): Viewport {
  if (t <= 0) return a;
  // Exactly b, so the last frame of an animation is bit-identical to its target.
  if (t >= 1) return b;
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t);
  const centre = { x: viewportW / 2, y: viewportH / 2 };
  const from = screenToWorld(centre, a);
  const to = screenToWorld(centre, b);
  const x = from.x + (to.x - from.x) * t;
  const y = from.y + (to.y - from.y) * t;
  return { zoom, panX: centre.x - x * zoom, panY: centre.y - y * zoom };
}
