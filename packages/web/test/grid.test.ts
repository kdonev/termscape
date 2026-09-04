import { describe, expect, it } from 'vitest';
import {
  TERMINAL_LINE_HEIGHT,
  gridFor,
  normalisedCell,
  widestCell,
  type BaseCell,
} from '../src/window/grid.js';
import { MAX_DEVICE_FONT, MIN_DEVICE_FONT } from '../src/canvas/viewport.js';

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
