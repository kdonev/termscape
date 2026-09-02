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
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const zoom = clampZoom(
    Math.min((viewportW - margin * 2) / w, (viewportH - margin * 2) / h),
  );
  return {
    zoom,
    panX: (viewportW - w * zoom) / 2 - minX * zoom,
    panY: (viewportH - h * zoom) / 2 - minY * zoom,
  };
}
