import { describe, expect, it } from 'vitest';
import type { Viewport } from '@aicanvas/protocol';
import {
  alignViewport,
  alignZoom,
  boundsOf,
  clampZoom,
  fitTo,
  focusRect,
  lerpViewport,
  pinchIntent,
  rectContains,
  rectContainsPoint,
  rectsIntersect,
  renderScaleFor,
  screenToWorld,
  snapWorldPx,
  stepOutTo,
  terminalFontSize,
  visibleWorldRect,
  wheelStream,
  wheelZoomFactor,
  workspaceBounds,
  worldToScreen,
  zoomAt,
  BASE_FONT_SIZE,
  LIVE_ZOOM_THRESHOLD,
  MAX_DEVICE_FONT,
  MAX_ZOOM,
  MIN_DEVICE_FONT,
  MIN_ZOOM,
  PINCH_MAX_MS,
  PINCH_MIN_EVENTS,
  PINCH_MIN_RATIO,
  WHEEL_GAP_MS,
  WS_LABEL_H,
  WS_PAD,
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

describe('focusRect', () => {
  const VIEW = { w: 1600, h: 1000 };

  /** The rect's on-screen box after applying the viewport. */
  const screenBox = (r: { x: number; y: number; w: number; h: number }, v: Viewport) => {
    const tl = worldToScreen({ x: r.x, y: r.y }, v);
    const br = worldToScreen({ x: r.x + r.w, y: r.y + r.h }, v);
    return { ...tl, w: br.x - tl.x, h: br.y - tl.y, cx: (tl.x + br.x) / 2, cy: (tl.y + br.y) / 2 };
  };

  it('centres the rect in the viewport', () => {
    for (const r of [
      { x: 0, y: 0, w: 720, h: 460 },
      { x: -1840, y: 920, w: 720, h: 460 },
    ]) {
      const box = screenBox(r, focusRect(r, VIEW.w, VIEW.h));
      expect(box.cx).toBeCloseTo(VIEW.w / 2);
      expect(box.cy).toBeCloseTo(VIEW.h / 2);
    }
  });

  it('covers the requested share of the constraining axis', () => {
    // 720x460 in 1600x1000: height is the tighter fit, so it is the axis that
    // lands on exactly 90% while the width comes in under it.
    const r = { x: 40, y: -12, w: 720, h: 460 };
    const box = screenBox(r, focusRect(r, VIEW.w, VIEW.h, 0.9));
    expect(box.h).toBeCloseTo(VIEW.h * 0.9);
    expect(box.w).toBeLessThanOrEqual(VIEW.w * 0.9 + 1e-9);
  });

  it('picks the constraining axis for wide and tall rects alike', () => {
    const wide = { x: 0, y: 0, w: 4000, h: 200 };
    const wideBox = screenBox(wide, focusRect(wide, VIEW.w, VIEW.h, 0.9));
    expect(wideBox.w).toBeCloseTo(VIEW.w * 0.9);

    const tall = { x: 0, y: 0, w: 200, h: 4000 };
    const tallBox = screenBox(tall, focusRect(tall, VIEW.w, VIEW.h, 0.9));
    expect(tallBox.h).toBeCloseTo(VIEW.h * 0.9);
  });

  it('never overflows the viewport', () => {
    for (const r of [
      { x: 0, y: 0, w: 720, h: 460 },
      { x: 5000, y: -3000, w: 4000, h: 200 },
      { x: 0, y: 0, w: 200, h: 4000 },
    ]) {
      const box = screenBox(r, focusRect(r, VIEW.w, VIEW.h));
      expect(box.x).toBeGreaterThanOrEqual(-0.01);
      expect(box.y).toBeGreaterThanOrEqual(-0.01);
      expect(box.x + box.w).toBeLessThanOrEqual(VIEW.w + 0.01);
      expect(box.y + box.h).toBeLessThanOrEqual(VIEW.h + 0.01);
    }
  });

  it('clamps a tiny rect to MAX_ZOOM and still centres it', () => {
    // Filling 90% would need ~5x here. Magnifying that far is worse than
    // leaving the window smaller than asked, so the zoom clamp wins.
    const r = { x: 300, y: 300, w: 320, h: 200 };
    const v = focusRect(r, VIEW.w, VIEW.h);
    expect(v.zoom).toBe(MAX_ZOOM);
    const box = screenBox(r, v);
    expect(box.cx).toBeCloseTo(VIEW.w / 2);
    expect(box.cy).toBeCloseTo(VIEW.h / 2);
  });

  it('survives a degenerate rect', () => {
    const v = focusRect({ x: 10, y: 10, w: 0, h: 0 }, VIEW.w, VIEW.h);
    expect(Number.isFinite(v.zoom)).toBe(true);
    expect(Number.isFinite(v.panX)).toBe(true);
    expect(Number.isFinite(v.panY)).toBe(true);
  });
});

describe('bounds', () => {
  it('encloses a set of rects', () => {
    expect(
      boundsOf([
        { x: 0, y: 0, w: 100, h: 50 },
        { x: 200, y: -30, w: 40, h: 40 },
      ]),
    ).toEqual({ x: 0, y: -30, w: 240, h: 80 });
  });

  it('has nothing to enclose for an empty set', () => {
    expect(boundsOf([])).toBeNull();
    expect(workspaceBounds([])).toBeNull();
  });

  it('pads a workspace box, with extra room above it for the label', () => {
    expect(workspaceBounds([{ x: 100, y: 100, w: 200, h: 100 }])).toEqual({
      x: 100 - WS_PAD,
      y: 100 - WS_PAD - WS_LABEL_H,
      w: 200 + WS_PAD * 2,
      h: 100 + WS_PAD * 2 + WS_LABEL_H,
    });
  });
});

describe('containment', () => {
  const outer = { x: 0, y: 0, w: 100, h: 100 };

  it('accepts a rect inside and rejects one that pokes out', () => {
    expect(rectContains(outer, { x: 10, y: 10, w: 50, h: 50 })).toBe(true);
    expect(rectContains(outer, { x: 10, y: 10, w: 200, h: 50 })).toBe(false);
    expect(rectContains(outer, { x: -20, y: 10, w: 50, h: 50 })).toBe(false);
  });

  it('forgives the fraction of a pixel that centring leaves behind', () => {
    expect(rectContains(outer, { x: -0.3, y: -0.3, w: 100.6, h: 100.6 })).toBe(true);
    expect(rectContains(outer, { x: -2, y: 0, w: 100, h: 100 })).toBe(false);
  });

  it('locates a point, edges included', () => {
    expect(rectContainsPoint(outer, { x: 50, y: 50 })).toBe(true);
    expect(rectContainsPoint(outer, { x: 100, y: 100 })).toBe(true);
    expect(rectContainsPoint(outer, { x: 101, y: 50 })).toBe(false);
    expect(rectContainsPoint(outer, { x: 50, y: -1 })).toBe(false);
  });
});

describe('wheelZoomFactor', () => {
  it('passes trackpad-sized deltas straight through', () => {
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-4)).toBeCloseTo(1.04);
    expect(wheelZoomFactor(6)).toBeCloseTo(0.94);
  });

  it('maps the sign of the delta to zooming in and out', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
  });

  it('clamps a mouse notch instead of collapsing to zero', () => {
    // deltaY 100 is one notch of a mouse wheel. The unclamped formula turns
    // that into a factor of zero: the canvas slams to a zoom limit, and a
    // ratio accumulated from zeroes says nothing about what was asked for.
    expect(wheelZoomFactor(100)).toBeGreaterThan(0);
    expect(wheelZoomFactor(1000)).toBe(0.2);
    expect(wheelZoomFactor(-1000)).toBe(5);
  });
});

describe('pinchIntent', () => {
  const flick = { ratio: 2, durationMs: 140, events: 8 };

  it('reads a fast, large burst as a direction', () => {
    expect(pinchIntent(flick)).toBe('in');
    expect(pinchIntent({ ...flick, ratio: 0.5 })).toBe('out');
  });

  it('judges by speed, not by a stopwatch', () => {
    // The reason there is no duration cap doing the real work: a confident
    // pinch that happens to run 400ms is still a flick, and rejecting it is
    // what makes the gesture feel like it misfires.
    expect(pinchIntent({ ratio: 2, durationMs: 400, events: 24 })).toBe('in');
    expect(pinchIntent({ ratio: 0.5, durationMs: 400, events: 24 })).toBe('out');
  });

  it('ignores the same distance covered slowly', () => {
    // The regression that matters most: a deliberate pinch has to keep zooming
    // exactly where the fingers left it, never snapping somewhere else.
    expect(pinchIntent({ ratio: 1.4, durationMs: 600, events: 40 })).toBeNull();
    expect(pinchIntent({ ...flick, ratio: 0.5, durationMs: 1500 })).toBeNull();
  });

  it('stops calling anything a flick once it has run long enough', () => {
    expect(pinchIntent({ ratio: 8, durationMs: PINCH_MAX_MS + 1, events: 40 })).toBeNull();
  });

  it('ignores a burst too small to be a flick, however brisk', () => {
    expect(pinchIntent({ ...flick, ratio: PINCH_MIN_RATIO - 0.01, durationMs: 20 })).toBeNull();
    expect(pinchIntent({ ...flick, ratio: 1 / (PINCH_MIN_RATIO - 0.01), durationMs: 20 })).toBeNull();
    expect(pinchIntent({ ...flick, ratio: 1 })).toBeNull();
  });

  it('lets a burst delivered inside one frame through on distance alone', () => {
    expect(pinchIntent({ ratio: 2, durationMs: 0, events: 5 })).toBe('in');
  });

  it('ignores a lone large event, which is a mouse wheel and not a pinch', () => {
    expect(
      pinchIntent({ ratio: 5, durationMs: 0, events: PINCH_MIN_EVENTS - 1 }),
    ).toBeNull();
  });

  it('rejects a nonsensical burst', () => {
    expect(pinchIntent({ ...flick, ratio: 0 })).toBeNull();
    expect(pinchIntent({ ...flick, ratio: Number.NaN })).toBeNull();
    expect(pinchIntent({ ...flick, durationMs: -1 })).toBeNull();
  });
});

describe('stepOutTo', () => {
  const VIEW = { w: 1600, h: 1000 };
  const one = { x: 0, y: 0, w: 720, h: 460 };
  const two = { x: 900, y: 0, w: 720, h: 460 };
  const far = { x: 4000, y: 2000, w: 720, h: 460 };
  const ws = workspaceBounds([one, two])!;
  const all = boundsOf([one, two, far])!;
  const sees = (v: { panX: number; panY: number; zoom: number }, r: typeof one) =>
    rectContains(visibleWorldRect(v, VIEW.w, VIEW.h, 0), r);

  it('steps from one window close-up out to its workspace', () => {
    const next = stepOutTo([ws, all], focusRect(one, VIEW.w, VIEW.h), VIEW.w, VIEW.h)!;
    expect(next).not.toBeNull();
    expect(sees(next, ws)).toBe(true);
    // and stops there rather than skipping a rung.
    expect(sees(next, all)).toBe(false);
  });

  it('steps from the workspace out to every window', () => {
    const next = stepOutTo([ws, all], fitTo([ws], VIEW.w, VIEW.h), VIEW.w, VIEW.h)!;
    expect(next).not.toBeNull();
    expect(sees(next, all)).toBe(true);
  });

  it('has nothing left to reveal once everything is on screen', () => {
    expect(stepOutTo([ws, all], fitTo([all], VIEW.w, VIEW.h), VIEW.w, VIEW.h)).toBeNull();
  });
});

describe('lerpViewport', () => {
  const VIEW = { w: 1600, h: 1000 };
  const a = { panX: 0, panY: 0, zoom: 0.4 };
  const b = { panX: -1200, panY: -640, zoom: 1.9 };

  it('reproduces the endpoints exactly', () => {
    expect(lerpViewport(a, b, 0, VIEW.w, VIEW.h)).toEqual(a);
    expect(lerpViewport(a, b, 1, VIEW.w, VIEW.h)).toEqual(b);
    expect(lerpViewport(a, b, 1.4, VIEW.w, VIEW.h)).toEqual(b);
  });

  it('stays inside the zoom range it is travelling', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const z = lerpViewport(a, b, t, VIEW.w, VIEW.h).zoom;
      expect(z).toBeGreaterThan(a.zoom);
      expect(z).toBeLessThan(b.zoom);
    }
  });

  it('carries the centre of the view straight from one to the other', () => {
    // Lerping panX/panY against an exponential zoom is what makes map
    // animations swoop out and back. The centre has to travel evenly instead.
    const centre = { x: VIEW.w / 2, y: VIEW.h / 2 };
    const from = screenToWorld(centre, a);
    const to = screenToWorld(centre, b);
    let previous = -1;
    for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const at = screenToWorld(centre, lerpViewport(a, b, t, VIEW.w, VIEW.h));
      const progress = (at.x - from.x) / (to.x - from.x);
      expect(progress).toBeCloseTo(t);
      expect(progress).toBeGreaterThan(previous);
      previous = progress;
    }
  });
});

describe('wheelStream', () => {
  const at = (now: number, over: boolean, zooming = false) => ({
    now,
    overTerminal: over,
    zooming,
  });

  it('keeps a pan on the canvas when a window slides under the pointer', () => {
    // The reported bug: a two-finger pan started over empty canvas moves the
    // world, a terminal drifts beneath a stationary cursor, and every event
    // after that used to be handed to xterm mid-gesture.
    let s = wheelStream(null, at(0, false));
    expect(s.owner).toBe('canvas');
    for (const t of [16, 32, 48, 64]) {
      s = wheelStream(s, at(t, true));
      expect(s.owner).toBe('canvas');
      expect(s.lastAt).toBe(t);
    }
  });

  it('keeps a scroll in the terminal it started in', () => {
    let s = wheelStream(null, at(0, true));
    expect(s.owner).toBe('terminal');
    s = wheelStream(s, at(16, false));
    expect(s.owner).toBe('terminal');
  });

  it('holds an owner across an unbroken gesture of any length', () => {
    let s = wheelStream(null, at(0, false));
    for (let t = WHEEL_GAP_MS; t <= WHEEL_GAP_MS * 10; t += WHEEL_GAP_MS) {
      s = wheelStream(s, at(t, true));
    }
    expect(s.owner).toBe('canvas');
  });

  it('re-decides once the gesture has gone idle', () => {
    const first = wheelStream(null, at(0, false));
    const same = wheelStream(first, at(WHEEL_GAP_MS, true));
    expect(same.owner).toBe('canvas');
    const fresh = wheelStream(first, at(WHEEL_GAP_MS + 1, true));
    expect(fresh.owner).toBe('terminal');
  });

  it('gives a pinch to the canvas wherever it starts', () => {
    expect(wheelStream(null, at(0, true, true)).owner).toBe('canvas');
  });
});
