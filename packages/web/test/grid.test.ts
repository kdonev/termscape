import { describe, expect, it } from 'vitest';
import {
  TERMINAL_LINE_HEIGHT,
  fitGrid,
  gridFor,
  normalisedCell,
  widestCell,
  type MeasureChar,
} from '../src/window/grid.js';
import { BASE_FONT_SIZE, MAX_DEVICE_FONT, MIN_DEVICE_FONT } from '../src/canvas/viewport.js';

/** A font whose metrics scale linearly from its box at BASE_FONT_SIZE. */
const linear =
  (charW: number, charH: number): MeasureChar =>
  (size) => ({ width: (charW * size) / BASE_FONT_SIZE, height: (charH * size) / BASE_FONT_SIZE });

/**
 * Real fonts are hinted, so their metrics are not linear in size: this one
 * gains a pixel of height at every size from 20px up. A base cell scaled
 * linearly from 12px under-predicts it, which is the overflow in issue 32.
 */
const hinted: MeasureChar = (size) => ({
  width: size * 0.6,
  height: size * 1.17 + (size >= 20 ? 1 : 0),
});

/** Consolas-ish, a few deliberately awkward metrics, and a non-linear one. */
const FONTS: MeasureChar[] = [
  linear(7.2, 14),
  linear(7.9, 15.4),
  linear(6.0, 12),
  linear(7.03, 13.72),
  hinted,
];

/** The unquantised character box at zoom 1, for the bounds below. */
const baseW = (m: MeasureChar) => m(BASE_FONT_SIZE).width;

const DPRS = [1, 1.25, 1.5, 2];

const deviceFonts = () => {
  const out: number[] = [];
  for (let d = MIN_DEVICE_FONT; d <= MAX_DEVICE_FONT; d++) out.push(d);
  return out;
};

describe('normalisedCell', () => {
  it('drifts with the render scale, which is why fit cannot size the grid', () => {
    // If this stopped being true the whole grid module would be unnecessary, so
    // assert the premise rather than trusting it.
    const base = FONTS[1]!;
    const sizes = new Set(
      deviceFonts().map((d) => normalisedCell(base, d, 1, TERMINAL_LINE_HEIGHT).w.toFixed(4)),
    );
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('never exceeds the unquantised character box', () => {
    for (const base of FONTS.slice(0, 4)) {
      for (const dpr of DPRS) {
        for (const d of deviceFonts()) {
          expect(normalisedCell(base, d, dpr).w).toBeLessThanOrEqual(baseW(base) + 1e-9);
        }
      }
    }
  });

  it('measures at the font size xterm is given, not a scaled 12px box', () => {
    // At dpr 1 and 24 device px the terminal is given a 24px font, where the
    // hinted font is a pixel taller than twice its 12px self.
    const requested: number[] = [];
    const spy: MeasureChar = (size) => {
      requested.push(size);
      return hinted(size);
    };
    const cell = normalisedCell(spy, 24, 1);
    expect(requested).toEqual([24]);
    const deviceCellH = Math.floor(Math.ceil(24 * 1.17 + 1) * TERMINAL_LINE_HEIGHT);
    expect(cell.h).toBeCloseTo((deviceCellH * BASE_FONT_SIZE) / 24, 9);
  });
});

describe('widestCell', () => {
  it('bounds every render scale, at every dpr', () => {
    for (const base of FONTS) {
      for (const dpr of DPRS) {
        const widest = widestCell(base, dpr);
        for (const d of deviceFonts()) {
          const cell = normalisedCell(base, d, dpr);
          expect(cell.w).toBeLessThanOrEqual(widest.w + 1e-9);
          expect(cell.h).toBeLessThanOrEqual(widest.h + 1e-9);
        }
      }
    }
  });
});

describe('gridFor', () => {
  const FRAMES = [
    [308, 168],
    [400, 300],
    [640, 420],
    [1024, 768],
  ] as const;

  it('fits inside the frame at every render scale', () => {
    // The property that replaces fit: whatever zoom the terminal is rendered
    // at, the fixed grid still fits the window, so it can never clip a column.
    for (const base of FONTS) {
      for (const dpr of DPRS) {
        for (const [fw, fh] of FRAMES) {
          const { cols, rows } = gridFor(fw, fh, base, dpr);
          for (const d of deviceFonts()) {
            const cell = normalisedCell(base, d, dpr);
            expect(cols * cell.w).toBeLessThanOrEqual(fw + 1e-9);
            expect(rows * cell.h).toBeLessThanOrEqual(fh + 1e-9);
          }
        }
      }
    }
  });

  it('leaves less than one cell unused at the largest render scale', () => {
    // The flip side: the bound must not be so conservative that the terminal
    // visibly underfills its window.
    for (const base of FONTS) {
      for (const [fw, fh] of FRAMES) {
        const { cols, rows } = gridFor(fw, fh, base, 1);
        const widest = widestCell(base, 1);
        expect(fw - cols * widest.w).toBeLessThan(widest.w);
        expect(fh - rows * widest.h).toBeLessThan(widest.h);
      }
    }
  });

  it('depends only on the geometry', () => {
    for (const base of FONTS) {
      expect(gridFor(640, 420, base, 1)).toEqual(gridFor(640, 420, base, 1));
      expect(gridFor(640, 420, base, 1)).not.toEqual(gridFor(641 + baseW(base), 420, base, 1));
    }
  });

  it('honours the minimum grid for a collapsed window', () => {
    expect(gridFor(0, 0, FONTS[0]!, 1)).toEqual({ cols: 2, rows: 1 });
    expect(gridFor(1, 1, FONTS[0]!, 1)).toEqual({ cols: 2, rows: 1 });
  });

  it('survives an unmeasurable font without dividing by zero', () => {
    expect(gridFor(400, 300, () => ({ width: 0, height: 0 }), 1)).toEqual({ cols: 2, rows: 1 });
  });
});

describe('fitGrid', () => {
  /*
   * What a share view is built on. The owner's grid is fixed, so the only
   * question is how much the reviewer's browser has to scale it - and the
   * failure it exists to prevent is a wide terminal running off the edge of a
   * smaller screen, which is exactly what a render scale alone produced.
   */
  const dpr = 1;
  const BASE = FONTS[0]!;

  it('shrinks a grid too wide for the viewport until the whole of it fits', () => {
    const fit = fitGrid(220, 60, 1000, 600, dpr, BASE);
    expect(fit.w * fit.zoom).toBeLessThanOrEqual(1000);
    expect(fit.h * fit.zoom).toBeLessThanOrEqual(600);
    expect(fit.zoom).toBeLessThan(1);
  });

  it('enlarges a small grid to use the space it has', () => {
    const fit = fitGrid(40, 10, 1600, 900, dpr, BASE);
    expect(fit.zoom).toBeGreaterThan(1);
    expect(fit.w * fit.zoom).toBeLessThanOrEqual(1600);
    expect(fit.h * fit.zoom).toBeLessThanOrEqual(900);
  });

  it('makes the area big enough for the grid at the render scale it picks, and no bigger', () => {
    for (const base of FONTS) {
      for (const [cols, rows, w, h] of [[120, 40, 1400, 900], [200, 55, 982, 480], [80, 24, 1920, 1000]]) {
        const fit = fitGrid(cols!, rows!, w!, h!, dpr, base);
        const cell = normalisedCell(base, Math.round(fit.renderScale * BASE_FONT_SIZE * dpr), dpr);
        expect(cols! * cell.w).toBeLessThanOrEqual(fit.w);
        expect(rows! * cell.h).toBeLessThanOrEqual(fit.h);
        // Tight: no more than the one pixel ceil() can add.
        expect(fit.w - cols! * cell.w).toBeLessThan(1);
        expect(fit.h - rows! * cell.h).toBeLessThan(1);
      }
    }
  });

  it('picks the largest legible text that still fits', () => {
    const fit = fitGrid(100, 30, 1200, 700, dpr, BASE);
    const device = Math.round(fit.zoom * BASE_FONT_SIZE * dpr);
    if (device < MAX_DEVICE_FONT) {
      const next = fitGrid(100, 30, 1200, 700, dpr, BASE);
      expect(next.zoom).toBe(fit.zoom);
      const bigger = normalisedCell(BASE, device + 1, dpr);
      const z = (device + 1) / (BASE_FONT_SIZE * dpr);
      const overflows = Math.ceil(100 * bigger.w) * z > 1200 || Math.ceil(30 * bigger.h) * z > 700;
      expect(overflows).toBe(true);
    }
  });

  it('lands the text on a whole device pixel where the text is legible', () => {
    for (const d of [1, 1.25, 2]) {
      const fit = fitGrid(160, 48, 1300, 760, d, BASE);
      const device = fit.zoom * BASE_FONT_SIZE * d;
      expect(Math.abs(device - Math.round(device))).toBeLessThan(1e-9);
      expect(fit.renderScale).toBeCloseTo(fit.zoom, 9);
    }
  });

  it('minifies rather than overflowing once the text is below legible', () => {
    const fit = fitGrid(300, 100, 400, 300, dpr, BASE);
    expect(fit.w * fit.zoom).toBeLessThanOrEqual(400 + 1e-9);
    expect(fit.h * fit.zoom).toBeLessThanOrEqual(300 + 1e-9);
  });
});
