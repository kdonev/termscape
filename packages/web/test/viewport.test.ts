import { describe, expect, it } from 'vitest';
import {
  alignViewport,
  alignZoom,
  clampZoom,
  fitTo,
  rectsIntersect,
  renderScaleFor,
  screenToWorld,
  snapWorldPx,
  terminalFontSize,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  BASE_FONT_SIZE,
  LIVE_ZOOM_THRESHOLD,
  MAX_DEVICE_FONT,
  MAX_ZOOM,
  MIN_DEVICE_FONT,
  MIN_ZOOM,
} from '../src/canvas/viewport.js';

/** The display scalings that actually matter: 100%, 125%, 150%, 200%. */
const DPRS = [1, 1.25, 1.5, 2];

/** A spread of awkward zooms, none of them landing on a round number. */
const ZOOMS = [0.08, 0.19, 0.37, 0.6, 0.73, 0.91, 1, 1.13, 1.37, 1.62, 2.04, 2.5];

const isInteger = (n: number) => Math.abs(n - Math.round(n)) < 1e-9;

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

describe('device-pixel alignment', () => {
  it('lands text on a whole device pixel', () => {
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        const device = BASE_FONT_SIZE * alignZoom(zoom, dpr) * dpr;
        if (device < MIN_DEVICE_FONT || device > MAX_DEVICE_FONT) continue;
        expect(isInteger(device), `zoom ${zoom} @ dpr ${dpr} -> ${device}`).toBe(true);
      }
    }
  });

  it('nudges the zoom by at most half a device pixel of text', () => {
    // This is the property that keeps zoom feeling continuous. A ladder of
    // discrete zoom stops would pass every other test here and fail this one.
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        const aligned = alignZoom(zoom, dpr);
        // The clamps at the ends of the range are allowed to move further.
        if (aligned === MIN_ZOOM || aligned === MAX_ZOOM) continue;
        expect(Math.abs(aligned - zoom)).toBeLessThanOrEqual(
          0.5 / (BASE_FONT_SIZE * dpr) + 1e-9,
        );
      }
    }
  });

  it('stays inside the zoom range', () => {
    for (const dpr of DPRS) {
      for (const zoom of [...ZOOMS, 0.001, 99]) {
        const aligned = alignZoom(zoom, dpr);
        expect(aligned).toBeGreaterThanOrEqual(MIN_ZOOM);
        expect(aligned).toBeLessThanOrEqual(MAX_ZOOM);
      }
    }
  });

  it('is idempotent, so the settle effect cannot loop', () => {
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        const once = alignZoom(zoom, dpr);
        expect(alignZoom(once, dpr)).toBeCloseTo(once, 12);
      }
    }
  });
});

describe('renderScaleFor', () => {
  it('matches the aligned zoom, so the terminal bitmap maps 1:1', () => {
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        const raw = BASE_FONT_SIZE * zoom * dpr;
        if (raw < MIN_DEVICE_FONT || raw > MAX_DEVICE_FONT) continue;
        expect(renderScaleFor(alignZoom(zoom, dpr), dpr)).toBeCloseTo(
          alignZoom(zoom, dpr),
          12,
        );
      }
    }
  });

  it('keeps the glyph atlas within bounds at the extremes', () => {
    for (const dpr of DPRS) {
      for (const zoom of [MIN_ZOOM, MAX_ZOOM, 0.001, 99]) {
        const device = terminalFontSize(renderScaleFor(zoom, dpr)) * dpr;
        expect(device).toBeGreaterThanOrEqual(MIN_DEVICE_FONT - 1e-9);
        expect(device).toBeLessThanOrEqual(MAX_DEVICE_FONT + 1e-9);
      }
    }
  });

  it('does not shrink text below legibility in the live band', () => {
    // At LIVE_ZOOM_THRESHOLD a terminal is still interactive, so its text has
    // to stay readable rather than following the zoom all the way down.
    for (const dpr of DPRS) {
      const device = terminalFontSize(renderScaleFor(LIVE_ZOOM_THRESHOLD, dpr)) * dpr;
      expect(device).toBeGreaterThanOrEqual(MIN_DEVICE_FONT);
    }
  });
});

describe('alignViewport', () => {
  const base = { panX: 137.42, panY: -88.6, zoom: 1.37 };

  it('puts the pan on whole device pixels', () => {
    for (const dpr of DPRS) {
      const v = alignViewport(base, 1200, 800, dpr);
      expect(isInteger(v.panX * dpr)).toBe(true);
      expect(isInteger(v.panY * dpr)).toBe(true);
    }
  });

  it('keeps the viewport centre fixed', () => {
    for (const dpr of DPRS) {
      const centre = { x: 600, y: 400 };
      const world = screenToWorld(centre, base);
      const back = worldToScreen(world, alignViewport(base, 1200, 800, dpr));
      // Within the device pixel the pan was rounded to.
      expect(Math.abs(back.x - centre.x)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
      expect(Math.abs(back.y - centre.y)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
    }
  });

  it('is idempotent', () => {
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        const once = alignViewport({ ...base, zoom }, 1200, 800, dpr);
        expect(alignViewport(once, 1200, 800, dpr)).toEqual(once);
      }
    }
  });
});

describe('snapWorldPx', () => {
  it('lands a world coordinate on a whole device pixel', () => {
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        for (const v of [0, 137.42, -880.13, 4096.5]) {
          expect(isInteger(snapWorldPx(v, zoom, dpr) * zoom * dpr)).toBe(true);
        }
      }
    }
  });

  it('moves the coordinate by less than one device pixel', () => {
    for (const dpr of DPRS) {
      for (const zoom of ZOOMS) {
        const moved = Math.abs(snapWorldPx(137.42, zoom, dpr) - 137.42) * zoom * dpr;
        expect(moved).toBeLessThanOrEqual(0.5 + 1e-9);
      }
    }
  });

  it('passes the value through when there is no scale to snap to', () => {
    expect(snapWorldPx(12.5, 0, 2)).toBe(12.5);
    expect(snapWorldPx(12.5, Number.NaN, 2)).toBe(12.5);
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
