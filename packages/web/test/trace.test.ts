import { beforeEach, describe, expect, it } from 'vitest';
import { RECENT_LOG_LINES, canvasLog, clearCanvasLog, debug } from '../src/debug.js';
import {
  fmtRect,
  fmtViewport,
  traceAlign,
  traceCanvasSize,
  traceFrame,
  traceGesture,
  traceLadder,
} from '../src/canvas/trace.js';

/*
 * The viewport trace exists to settle a report about where the canvas ended up
 * (issue 53), and it can only do that if it is on when the bug happens - which
 * is before anyone thought to turn tracing on. So what is tested here is not
 * the wording of a line but the two properties the diagnosis rests on: the
 * lines are kept with no topic enabled, and each one carries the numbers that
 * tell the suspects apart.
 */

beforeEach(() => {
  clearCanvasLog();
});

describe('the kept canvas log', () => {
  it('keeps viewport lines although no topic is on', () => {
    traceAlign({ zoom: 1, panX: 0, panY: 0 }, { zoom: 1.04, panX: 2, panY: 2 });
    expect(canvasLog()).toHaveLength(1);
    expect(canvasLog()[0]).toContain('[viewport]');
  });

  it('keeps nothing for a topic that is off', () => {
    debug('input', 'a wheel event nobody asked to see');
    expect(canvasLog()).toEqual([]);
  });

  it('timestamps each line, so it sorts with the hub lines in a report', () => {
    traceCanvasSize(1920, 980, 1);
    expect(canvasLog()[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[viewport\] /);
  });

  it('drops the oldest rather than growing without limit', () => {
    for (let i = 0; i < RECENT_LOG_LINES + 50; i++) {
      traceCanvasSize(i, i, 1);
    }
    const kept = canvasLog();
    expect(kept).toHaveLength(RECENT_LOG_LINES);
    // The first 50 went; the newest is the last one written.
    expect(kept[0]).toContain('canvas 50x50');
    expect(kept.at(-1)).toContain(`canvas ${RECENT_LOG_LINES + 49}x${RECENT_LOG_LINES + 49}`);
  });
});

describe('what a line says', () => {
  it('gives the zoom change as a percentage, which is what accuses alignment', () => {
    traceAlign({ zoom: 1, panX: 0, panY: 0 }, { zoom: 1.0833, panX: 0, panY: 0 });
    expect(canvasLog()[0]).toContain('dzoom=8.33%');
  });

  it('records the rect a command framed and the canvas it framed it in', () => {
    traceFrame(
      'focus',
      { x: 1200, y: 340, w: 900, h: 600 },
      { zoom: 1, panX: 0, panY: 0 },
      { zoom: 0.9167, panX: -700, panY: -200 },
      { w: 1920, h: 980 },
      'session=s1',
    );
    const line = canvasLog()[0]!;
    expect(line).toContain('focus target=(1200,340 900x600)');
    expect(line).toContain('canvas=1920x980');
    expect(line).toContain('zoom=1 pan=0,0 -> zoom=0.92 pan=-700,-200');
    expect(line).toContain('session=s1');
  });

  /*
   * The panel sits on top of the canvas rather than beside it, so a view
   * centred in the canvas is off-centre on the part of it that is visible.
   * Without this token in the line, that cause is indistinguishable from a
   * command having framed the wrong rect - which is the whole question in
   * issue 53. There is no DOM here, so what is checked is that the trace says
   * something about the panel rather than throwing or going quiet.
   */
  it('says what the panel was doing, without a DOM to ask', () => {
    traceCanvasSize(1920, 980, 2);
    expect(canvasLog()[0]).toMatch(/panel=/);
  });

  it('records a gesture that asked for a flick and did not get one', () => {
    traceGesture('wheel', { ratio: 1.3, durationMs: 420, events: 3 }, null, 'zoom only');
    expect(canvasLog()[0]).toContain(
      'gesture wheel ratio=1.3 ms=420 events=3 intent=none -> zoom only',
    );
  });

  it('records the ladder rungs a step chose from, and that it chose none', () => {
    traceLadder('in', [{ x: 0, y: 0, w: 10, h: 10 }], null);
    const line = canvasLog()[0]!;
    expect(line).toContain('ladder in rungs=[(0,0 10x10)]');
    expect(line).toContain('nothing to step to');
  });
});

describe('the formatters', () => {
  it('rounds to two decimals, so a line stays readable', () => {
    expect(fmtViewport({ zoom: 0.916666, panX: 12.3456, panY: -0.001 })).toBe(
      'zoom=0.92 pan=12.35,0',
    );
    expect(fmtRect({ x: -0.5, y: 2, w: 900.123, h: 600 })).toBe('-0.5,2 900.12x600');
  });
});
