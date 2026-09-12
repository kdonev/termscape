import { describe, expect, it } from 'vitest';
import {
  describeInput,
  describeLatin1,
  describeModeChanges,
  describeSnapshotModes,
  modeChanges,
} from '../src/mouse.js';

const bytes = (...b: number[]) => new Uint8Array(b);

describe('describeInput', () => {
  it('names a wheel-up report in the default encoding', () => {
    // ESC [ M, then button 64 + 32, col 10 + 32, row 3 + 32.
    const out = describeInput(bytes(0x1b, 0x5b, 0x4d, 96, 42, 35));
    expect(out).toContain('X10 wheel-up');
    expect(out).toContain('col=10');
    expect(out).toContain('row=3');
  });

  it('distinguishes wheel-down from wheel-up', () => {
    expect(describeInput(bytes(0x1b, 0x5b, 0x4d, 97, 42, 35))).toContain('wheel-down');
  });

  /*
   * The whole reason the raw input path exists. A coordinate past column 95
   * is a byte above 0x7f; sent as text it would arrive as two bytes, and the
   * report would decode as a different button at a different place. A trace
   * that renders both the same way could not tell them apart, so this pins
   * the intact form.
   */
  it('reads a coordinate that needs a byte above 0x7f', () => {
    const out = describeInput(bytes(0x1b, 0x5b, 0x4d, 96, 32 + 120, 32 + 40));
    expect(out).toContain('col=120');
    expect(out).toContain('row=40');
    expect(out).toContain('98'); // 0x98, the raw coordinate byte, in the hex
  });

  it('names an SGR report, which travels as text instead', () => {
    const out = describeInput(new TextEncoder().encode('\x1b[<64;10;3M'));
    expect(out).toContain('SGR wheel-up');
    expect(out).toContain('col=10');
  });

  it('shows ordinary keystrokes as visible text', () => {
    expect(describeInput(new TextEncoder().encode('ls\r'))).toContain('"ls\\r"');
  });

  it('reads latin1-carried bytes identically to the raw ones', () => {
    const raw = bytes(0x1b, 0x5b, 0x4d, 96, 32 + 120, 32 + 40);
    const carried = String.fromCharCode(...raw);
    expect(describeLatin1(carried)).toBe(describeInput(raw));
  });
});

describe('modeChanges', () => {
  it('names the modes that decide whose job a wheel is', () => {
    const out = modeChanges('\x1b[?1049h\x1b[?1003h\x1b[?1006h');
    expect(out.map((c) => c.name)).toEqual([
      'alt-screen+cursor',
      'any-motion-mouse',
      'sgr-mouse-encoding',
    ]);
    expect(out.every((c) => c.set)).toBe(true);
  });

  it('reads several modes set in one sequence', () => {
    expect(modeChanges('\x1b[?1002;1006h').map((c) => c.mode)).toEqual(['1002', '1006']);
  });

  it('distinguishes setting a mode from clearing it', () => {
    expect(describeModeChanges('\x1b[?1003l')).toBe('-any-motion-mouse(?1003)');
  });

  it('is quiet about output that changes no mode', () => {
    expect(describeModeChanges('hello \x1b[31mworld\x1b[0m')).toBeNull();
  });
});

describe('describeSnapshotModes', () => {
  /*
   * The gap worth being able to see. @xterm/addon-serialize replays the
   * tracking mode but never the encoding one, so a window restored from a
   * snapshot can be sending X10 reports to a program that had been getting
   * SGR ones. Naming what a snapshot does and does not carry is the point.
   */
  it('reports tracking restored without its encoding', () => {
    const out = describeSnapshotModes('some screen\x1b[?1049h\x1b[H\x1b[?1003h');
    expect(out).toContain('+any-motion-mouse');
    expect(out).not.toContain('sgr-mouse-encoding');
  });

  it('says so plainly when a snapshot restores nothing about the mouse', () => {
    expect(describeSnapshotModes('plain screen')).toBe('no mouse/screen modes');
  });
});
