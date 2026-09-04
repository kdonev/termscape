import {
  BASE_FONT_SIZE,
  MAX_DEVICE_FONT,
  MIN_DEVICE_FONT,
} from '../canvas/viewport.js';

/** Shared by the live terminals and the measurement that sizes their grid. */
export const TERMINAL_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const TERMINAL_LINE_HEIGHT = 1.2;

/** Character box at BASE_FONT_SIZE, in CSS pixels. */
export interface BaseCell {
  charW: number;
  charH: number;
}

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
 * overflow its host at any zoom, only leave a sliver of matching background.
 */

/** The device font sizes a terminal can be rendered at. See renderScaleFor. */
function deviceFontRange(): number[] {
  const out: number[] = [];
  for (let d = MIN_DEVICE_FONT; d <= MAX_DEVICE_FONT; d++) out.push(d);
  return out;
}

/**
 * Cell size in world pixels, for a terminal rendered at `deviceFont` device
 * pixels of text and counter-scaled back down. This inverts xterm's own
 * quantisation, so it reports what a column really costs at that render scale.
 */
export function normalisedCell(
  base: BaseCell,
  deviceFont: number,
  lineHeight = TERMINAL_LINE_HEIGHT,
): { w: number; h: number } {
  // A render scale k means fontSize = deviceFont / dpr and k = deviceFont /
  // (BASE_FONT_SIZE * dpr), so charWidth * dpr collapses to charW * deviceFont
  // / BASE_FONT_SIZE and the dpr drops out of the normalised result entirely.
  const deviceCharW = Math.floor((base.charW * deviceFont) / BASE_FONT_SIZE);
  const deviceCharH = Math.ceil((base.charH * deviceFont) / BASE_FONT_SIZE);
  const deviceCellH = Math.floor(deviceCharH * lineHeight);
  return {
    w: (deviceCharW * BASE_FONT_SIZE) / deviceFont,
    h: (deviceCellH * BASE_FONT_SIZE) / deviceFont,
  };
}

/** The worst case over every render scale, so no zoom can overflow the host. */
export function widestCell(base: BaseCell, lineHeight = TERMINAL_LINE_HEIGHT) {
  let w = 0;
  let h = 0;
  for (const deviceFont of deviceFontRange()) {
    const cell = normalisedCell(base, deviceFont, lineHeight);
    if (cell.w > w) w = cell.w;
    if (cell.h > h) h = cell.h;
  }
  return { w, h };
}

/**
 * Grid for a terminal area of `frameW` x `frameH` world pixels. Pure, and a
 * pure function of geometry alone: the same window is the same grid at every
 * zoom level. Minimums match the fit addon's.
 */
export function gridFor(
  frameW: number,
  frameH: number,
  base: BaseCell,
  lineHeight = TERMINAL_LINE_HEIGHT,
): { cols: number; rows: number } {
  const cell = widestCell(base, lineHeight);
  if (!(cell.w > 0) || !(cell.h > 0)) return { cols: 2, rows: 1 };
  return {
    cols: Math.max(2, Math.floor(frameW / cell.w)),
    rows: Math.max(1, Math.floor(frameH / cell.h)),
  };
}

let cached: BaseCell | null = null;

/**
 * Measure the base character box, once per page. Deliberately mirrors xterm's
 * own DOM measurement (a `white-space: pre` span of 32 'W's at `line-height:
 * normal`), so the number we divide by is the one xterm will scale.
 */
export function measureBaseCell(): BaseCell {
  if (cached) return cached;

  const el = document.createElement('span');
  el.textContent = 'W'.repeat(32);
  el.setAttribute('aria-hidden', 'true');
  el.style.cssText =
    'display:inline-block;visibility:hidden;position:absolute;top:0;left:-9999em;' +
    'line-height:normal;white-space:pre;font-kerning:none;';
  el.style.fontFamily = TERMINAL_FONT_FAMILY;
  el.style.fontSize = `${BASE_FONT_SIZE}px`;
  document.body.appendChild(el);
  const charW = el.offsetWidth / 32;
  const charH = el.offsetHeight;
  el.remove();

  // A zero measurement means fonts are not ready; leave it uncached so the next
  // caller measures again rather than freezing a broken grid for the session.
  if (!(charW > 0) || !(charH > 0)) return { charW: BASE_FONT_SIZE * 0.6, charH: BASE_FONT_SIZE * 1.2 };
  cached = { charW, charH };
  return cached;
}
