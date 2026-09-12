import { describe, expect, it } from 'vitest';
import {
  TERMINAL_LINE_HEIGHT,
  fitGrid,
  gridFor,
  normalisedCell,
  widestCell,
  type BaseCell,
} from '../src/window/grid.js';
import { BASE_FONT_SIZE, MAX_DEVICE_FONT, MIN_DEVICE_FONT } from '../src/canvas/viewport.js';

/** Consolas-ish, plus a few deliberately awkward metrics. */
const FONTS: BaseCell[] = [
  { charW: 7.2, charH: 14 },
  { charW: 7.9, charH: 15.4 },
  { charW: 6.0, charH: 12 },
  { charW: 7.03, charH: 13.72 },
];

const deviceFonts = () => {
  const out: number[] = [];
  for (let d = MIN_DEVICE_FONT; d <= MAX_DEVICE_FONT; d++) out.push(d);
  return out;
};

describe('normalisedCell', () => {
  it('drifts with the render scale, which is why fit cannot size the grid', () => {
    // If this stopped being true the whole grid module would be unnecessary, so
    // assert the premise rather than trusting it.
    const base = FONTS[1];
    const sizes = new Set(
      deviceFonts().map((d) => normalisedCell(base, d, TERMINAL_LINE_HEIGHT).w.toFixed(4)),
    );
    expect(sizes.size).toBeGreaterThan(1);
  });

  it('never exceeds the unquantised character box', () => {
    for (const base of FONTS) {
      for (const d of deviceFonts()) {
        expect(normalisedCell(base, d).w).toBeLessThanOrEqual(base.charW + 1e-9);
      }
    }
  });
});

describe('widestCell', () => {
  it('bounds every render scale', () => {
    for (const base of FONTS) {
      const widest = widestCell(base);
      for (const d of deviceFonts()) {
        const cell = normalisedCell(base, d);
        expect(cell.w).toBeLessThanOrEqual(widest.w + 1e-9);
        expect(cell.h).toBeLessThanOrEqual(widest.h + 1e-9);
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
      for (const [fw, fh] of FRAMES) {
        const { cols, rows } = gridFor(fw, fh, base);
        for (const d of deviceFonts()) {
          const cell = normalisedCell(base, d);
          expect(cols * cell.w).toBeLessThanOrEqual(fw + 1e-9);
          expect(rows * cell.h).toBeLessThanOrEqual(fh + 1e-9);
        }
      }
    }
  });

  it('leaves less than one cell unused at the largest render scale', () => {
    // The flip side: the bound must not be so conservative that the terminal
    // visibly underfills its window.
    for (const base of FONTS) {
      for (const [fw, fh] of FRAMES) {
        const { cols, rows } = gridFor(fw, fh, base);
        const widest = widestCell(base);
        expect(fw - cols * widest.w).toBeLessThan(widest.w);
        expect(fh - rows * widest.h).toBeLessThan(widest.h);
      }
    }
  });

  it('depends only on the geometry', () => {
    for (const base of FONTS) {
      expect(gridFor(640, 420, base)).toEqual(gridFor(640, 420, base));
      expect(gridFor(640, 420, base)).not.toEqual(gridFor(641 + base.charW, 420, base));
    }
  });

  it('honours the minimum grid for a collapsed window', () => {
    expect(gridFor(0, 0, FONTS[0])).toEqual({ cols: 2, rows: 1 });
    expect(gridFor(1, 1, FONTS[0])).toEqual({ cols: 2, rows: 1 });
  });

  it('survives an unmeasurable font without dividing by zero', () => {
    expect(gridFor(400, 300, { charW: 0, charH: 0 })).toEqual({ cols: 2, rows: 1 });
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
        const cell = normalisedCell(base, Math.round(fit.renderScale * BASE_FONT_SIZE * dpr));
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
      const bigger = normalisedCell(BASE, device + 1);
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
