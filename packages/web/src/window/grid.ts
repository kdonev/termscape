import {
  BASE_FONT_SIZE,
  MAX_DEVICE_FONT,
  MIN_DEVICE_FONT,
  renderScaleFor,
} from '../canvas/viewport.js';

/** Shared by the live terminals and the measurement that sizes their grid. */
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const TERMINAL_LINE_HEIGHT = 1.2;

/**
 * xterm's character box at one font size, in CSS pixels: what its
 * CharSizeService reports and every renderer quantises from.
 */
export interface CharSize {
  width: number;
  height: number;
}

/** Measures the character box at a font size in CSS px, the way xterm does. */
export type MeasureChar = (fontSize: number) => CharSize;

/*
 * Why the grid is computed here rather than by the fit addon.
 *
 * Terminals render at a font scaled by the canvas zoom, so their bitmap lands
 * on whole device pixels. But xterm quantises the cell it derives from that
 * font — `floor(charWidth * dpr)` and `ceil(charHeight * dpr)` — and the
 * quantisation error does not scale with the font. Normalised back to zoom 1
 * the cell therefore drifts by a few percent as the font grows, and a fit
 * against it hands back a different cols/rows at every zoom level. That reflows
 * the agent's output on every zoom step, which is unusable.
 *
 * So the grid is computed from the window's own size instead, against the
 * largest cell any render scale can produce. Two consequences, both wanted:
 * cols/rows depend only on the window geometry and the display, never on the
 * zoom; and because the divisor is an upper bound, the terminal can never
 * overflow its area at any zoom. The window frame then hugs whatever xterm
 * actually drew (TerminalWindow), so the slack never shows as a gap.
 *
 * The bound is only as good as the measurement under it, which is why each
 * render scale is measured at its own font size rather than extrapolated from
 * one: font metrics are not linear in size, and a cell predicted a pixel short
 * is a last row hanging out of the frame (issue 32).
 */

/** The device font sizes a terminal can be rendered at. See renderScaleFor. */
function deviceFontRange(): number[] {
  const out: number[] = [];
  for (let d = MIN_DEVICE_FONT; d <= MAX_DEVICE_FONT; d++) out.push(d);
  return out;
}

/**
 * Cell size in world pixels, for a terminal rendered at `deviceFont` device
 * pixels of text and counter-scaled back down. Mirrors the WebGL renderer's
 * own quantisation (WebglRenderer._updateDimensions), so it reports what a
 * column really costs at that render scale.
 */
export function normalisedCell(
  measure: MeasureChar,
  deviceFont: number,
  dpr: number,
  lineHeight = TERMINAL_LINE_HEIGHT,
): { w: number; h: number } {
  // A render scale k = deviceFont / (BASE_FONT_SIZE * dpr) means the terminal
  // is given fontSize BASE_FONT_SIZE * k = deviceFont / dpr, and a device
  // pixel of it is BASE_FONT_SIZE / deviceFont world pixels.
  const char = measure(deviceFont / dpr);
  const deviceCharW = Math.floor(char.width * dpr);
  const deviceCharH = Math.ceil(char.height * dpr);
  const deviceCellH = Math.floor(deviceCharH * lineHeight);
  return {
    w: (deviceCharW * BASE_FONT_SIZE) / deviceFont,
    h: (deviceCellH * BASE_FONT_SIZE) / deviceFont,
  };
}

/** The worst case over every render scale, so no zoom can overflow the area. */
export function widestCell(measure: MeasureChar, dpr: number, lineHeight = TERMINAL_LINE_HEIGHT) {
  let w = 0;
  let h = 0;
  for (const deviceFont of deviceFontRange()) {
    const cell = normalisedCell(measure, deviceFont, dpr, lineHeight);
    if (cell.w > w) w = cell.w;
    if (cell.h > h) h = cell.h;
  }
  return { w, h };
}

/**
 * Grid for a terminal area of `frameW` x `frameH` world pixels. Pure, and a
 * function of geometry and display alone: the same window is the same grid at
 * every zoom level. Minimums match the fit addon's.
 */
export function gridFor(
  frameW: number,
  frameH: number,
  measure: MeasureChar,
  dpr: number,
  lineHeight = TERMINAL_LINE_HEIGHT,
): { cols: number; rows: number } {
  const cell = widestCell(measure, dpr, lineHeight);
  if (!(cell.w > 0) || !(cell.h > 0)) return { cols: 2, rows: 1 };
  return {
    cols: Math.max(2, Math.floor(frameW / cell.w)),
    rows: Math.max(1, Math.floor(frameH / cell.h)),
  };
}

/** How a share view lays out a terminal it does not size. See fitGrid. */
export interface GridFit {
  /** The terminal area at zoom 1, in world pixels: exactly big enough for the grid. */
  w: number;
  h: number;
  /** The CSS scale that fits that area into the viewport. */
  zoom: number;
  /** The raster scale to go with it, as the canvas pairs one with its zoom. */
  renderScale: number;
}

/**
 * Fit a fixed `cols`x`rows` grid into an `availW`x`availH` viewport.
 *
 * On the canvas a terminal's size on screen comes from the world layer's
 * `scale(zoom)`; `renderScale` only makes the raster match that zoom, and
 * never changes how big anything is. A share view has no world layer, so it
 * needs a zoom of its own - without one the terminal paints at the base font
 * whatever it is told, and a wide owner window runs off the edge of a smaller
 * browser. This supplies that zoom.
 *
 * The area is sized from the cell at the render scale actually chosen, not
 * from `widestCell`. `gridFor` has to use the widest because a canvas window
 * is seen at every zoom; a share view is seen at one, and the widest bound
 * left a fifth of the screen empty beside the last column.
 *
 * So each device font size is tried, largest first, and the first whose zoomed
 * area fits wins. Whole device pixels of text height fall out of that for free,
 * which is what keeps the raster from being resampled into blur. Below
 * legibility there is nothing to align to: the raster stays at the smallest
 * legible size and the zoom shrinks freely, so a grid too large for the screen
 * minifies the way a zoomed-out canvas does instead of running off the edge.
 */
export function fitGrid(
  cols: number,
  rows: number,
  availW: number,
  availH: number,
  dpr: number,
  measure: MeasureChar,
  lineHeight = TERMINAL_LINE_HEIGHT,
): GridFit {
  const unit = BASE_FONT_SIZE * dpr;
  const areaAt = (deviceFont: number) => {
    const cell = normalisedCell(measure, deviceFont, dpr, lineHeight);
    return { w: Math.ceil(cols * cell.w), h: Math.ceil(rows * cell.h) };
  };

  for (let deviceFont = MAX_DEVICE_FONT; deviceFont >= MIN_DEVICE_FONT; deviceFont--) {
    const { w, h } = areaAt(deviceFont);
    const zoom = deviceFont / unit;
    if (w * zoom <= availW && h * zoom <= availH) {
      return { w, h, zoom, renderScale: renderScaleFor(zoom, dpr) };
    }
  }

  const { w, h } = areaAt(MIN_DEVICE_FONT);
  const zoom = w > 0 && h > 0 ? Math.min(availW / w, availH / h) : 1;
  return { w, h, zoom, renderScale: MIN_DEVICE_FONT / unit };
}

/** Last measurement per font size. Keyed by size alone: the family is fixed. */
const measured = new Map<number, CharSize>();

/**
 * Measure the character box at `fontSize` CSS px exactly as xterm 5.5's
 * CharSizeService does, so the cell predicted here is the cell xterm builds.
 *
 * xterm prefers canvas text metrics - `measureText('W')` for the width and the
 * font bounding box for the height - and falls back to a DOM span of 32 'W's
 * only where those are missing. The height the two report differs, so
 * mirroring the fallback alone (as this once did) under-predicted the cell and
 * let the last row hang out of the window.
 */
export const measureChar: MeasureChar = (fontSize) => {
  const hit = measured.get(fontSize);
  if (hit) return hit;
  const char = measureWithTextMetrics(fontSize) ?? measureWithDom(fontSize);
  // A zero measurement means fonts are not ready; leave it uncached so the next
  // caller measures again rather than freezing a broken grid for the session.
  if (!(char.width > 0) || !(char.height > 0)) {
    return { width: fontSize * 0.6, height: fontSize * 1.2 };
  }
  measured.set(fontSize, char);
  return char;
};

let metricsCtx: OffscreenCanvasRenderingContext2D | null | undefined;

/** xterm's TextMetricsMeasureStrategy, or null where it would not be used. */
function measureWithTextMetrics(fontSize: number): CharSize | null {
  if (metricsCtx === undefined) {
    metricsCtx = null;
    try {
      const ctx = new OffscreenCanvas(100, 100).getContext('2d');
      const probe = ctx?.measureText('W');
      if (ctx && probe && 'fontBoundingBoxAscent' in probe && 'fontBoundingBoxDescent' in probe) {
        metricsCtx = ctx;
      }
    } catch {
      // No OffscreenCanvas: xterm falls back to the DOM, and so do we.
    }
  }
  if (!metricsCtx) return null;
  metricsCtx.font = `${fontSize}px ${TERMINAL_FONT_FAMILY}`;
  const m = metricsCtx.measureText('W');
  return { width: m.width, height: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent };
}

/** xterm's DomMeasureStrategy: a `white-space: pre` span of 32 'W's. */
function measureWithDom(fontSize: number): CharSize {
  const el = document.createElement('span');
  el.textContent = 'W'.repeat(32);
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;' +
    'line-height:normal;white-space:pre;font-kerning:none;';
  el.style.fontFamily = TERMINAL_FONT_FAMILY;
  el.style.fontSize = `${fontSize}px`;
  document.body.appendChild(el);
  const char = { width: el.offsetWidth / 32, height: el.offsetHeight };
  el.remove();
  return char;
}
