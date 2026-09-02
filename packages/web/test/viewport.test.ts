import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  fitTo,
  rectsIntersect,
  screenToWorld,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  LIVE_ZOOM_THRESHOLD,
  MAX_ZOOM,
  MIN_ZOOM,
} from '../src/canvas/viewport.js';

describe('coordinate transforms', () => {
  const v = { panX: 100, panY: 50, zoom: 2 };

  it('round-trips screen and world coordinates', () => {
    const world = { x: 37, y: -12 };
    const back = screenToWorld(worldToScreen(world, v), v);
    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });

  it('places the world origin at the pan offset', () => {
    expect(worldToScreen({ x: 0, y: 0 }, v)).toEqual({ x: 100, y: 50 });
  });
});

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const before = { panX: 0, panY: 0, zoom: 1 };
    const cursor = { x: 400, y: 300 };
    const worldUnderCursor = screenToWorld(cursor, before);

    const after = zoomAt(before, cursor, 2.4);
    const stillThere = worldToScreen(worldUnderCursor, after);

    // Anything else and the canvas slides out from under the pointer.
    expect(stillThere.x).toBeCloseTo(cursor.x);
    expect(stillThere.y).toBeCloseTo(cursor.y);
  });

  it('holds the invariant when zooming out too', () => {
    const before = { panX: -320, panY: 88, zoom: 1.75 };
    const cursor = { x: 210, y: 640 };
    const world = screenToWorld(cursor, before);
    const after = zoomAt(before, cursor, 0.35);
    const back = worldToScreen(world, after);
    expect(back.x).toBeCloseTo(cursor.x);
    expect(back.y).toBeCloseTo(cursor.y);
  });

  it('clamps to the zoom range', () => {
    expect(zoomAt({ panX: 0, panY: 0, zoom: 1 }, { x: 0, y: 0 }, 99).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ panX: 0, panY: 0, zoom: 1 }, { x: 0, y: 0 }, 0).zoom).toBe(MIN_ZOOM);
    expect(clampZoom(0.5)).toBe(0.5);
  });
});

describe('culling and level of detail', () => {
  it('includes offscreen padding so neighbours mount before they scroll in', () => {
    const v = { panX: 0, panY: 0, zoom: 1 };
    const r = visibleWorldRect(v, 1000, 800, 400);
    expect(r.x).toBe(-400);
    expect(r.y).toBe(-400);
    expect(r.w).toBe(1800);
    expect(r.h).toBe(1600);
  });

  it('grows the visible world rect as you zoom out', () => {
    const wide = visibleWorldRect({ panX: 0, panY: 0, zoom: 0.25 }, 1000, 800, 0);
    const tight = visibleWorldRect({ panX: 0, panY: 0, zoom: 2 }, 1000, 800, 0);
    expect(wide.w).toBeGreaterThan(tight.w);
  });

  it('detects intersection and separation', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    expect(rectsIntersect(a, { x: 50, y: 50, w: 100, h: 100 })).toBe(true);
    expect(rectsIntersect(a, { x: 100, y: 0, w: 10, h: 10 })).toBe(true); // touching
    expect(rectsIntersect(a, { x: 101, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsIntersect(a, { x: 0, y: -200, w: 10, h: 10 })).toBe(false);
  });

  it('has a live threshold inside the usable zoom range', () => {
    expect(LIVE_ZOOM_THRESHOLD).toBeGreaterThan(MIN_ZOOM);
    expect(LIVE_ZOOM_THRESHOLD).toBeLessThan(MAX_ZOOM);
  });
});

describe('fitTo', () => {
  it('centres a single rect in the viewport', () => {
    const v = fitTo([{ x: 0, y: 0, w: 400, h: 300 }], 1000, 800, 0);
    const tl = worldToScreen({ x: 0, y: 0 }, v);
    const br = worldToScreen({ x: 400, y: 300 }, v);
    expect((tl.x + br.x) / 2).toBeCloseTo(500);
    expect((tl.y + br.y) / 2).toBeCloseTo(400);
  });

  it('brings every rect inside the viewport', () => {
    const rects = [
      { x: -500, y: -200, w: 400, h: 300 },
      { x: 900, y: 700, w: 400, h: 300 },
    ];
    const v = fitTo(rects, 1200, 900, 40);
    for (const r of rects) {
      const tl = worldToScreen({ x: r.x, y: r.y }, v);
      const br = worldToScreen({ x: r.x + r.w, y: r.y + r.h }, v);
      expect(tl.x).toBeGreaterThanOrEqual(-0.01);
      expect(tl.y).toBeGreaterThanOrEqual(-0.01);
      expect(br.x).toBeLessThanOrEqual(1200.01);
      expect(br.y).toBeLessThanOrEqual(900.01);
    }
  });

  it('returns a sane viewport for an empty canvas', () => {
    expect(fitTo([], 1000, 800)).toEqual({ panX: 0, panY: 0, zoom: 1 });
  });
});
