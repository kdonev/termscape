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

/** The pan that centres a world rect in the viewport at a given zoom. */
function centreOn(r: Rect, zoom: number, viewportW: number, viewportH: number): Viewport {
  return {
    zoom,
    panX: (viewportW - r.w * zoom) / 2 - r.x * zoom,
    panY: (viewportH - r.h * zoom) / 2 - r.y * zoom,
  };
}

/** Fit a set of world rects into the viewport with margin. */
export function fitTo(
  rects: Rect[],
  viewportW: number,
  viewportH: number,
  margin = 80,
): Viewport {
  if (rects.length === 0) return { panX: 0, panY: 0, zoom: 1 };
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  const bounds = {
    x: minX,
    y: minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
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
