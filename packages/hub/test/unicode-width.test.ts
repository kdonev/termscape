import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { PtySession, useUnicode11 } from '../src/session/pty.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

/**
 * How wide a column is, which decides where a redraw lands.
 *
 * A TUI does not say where to put its next frame; it says how far up from
 * here. Ink works that distance out as `ceil(width / columns)` of the frame it
 * drew last, counting with a current Unicode table, so the terminal has to
 * agree with that table or the frame lands on the wrong row. xterm ships
 * Unicode 6, which predates every emoji block and counts an emoji as one
 * column where the font paints two, and that is issue 50: a mod with an emoji
 * in each segment of its `AbovePrompt` band made Claude Code redraw a line too
 * high every second, wiping the status line above it.
 *
 * The band is fed to the mirror rather than to a real pty on purpose. ConPTY
 * is a terminal emulator in its own right with a width table of its own, so on
 * Windows a spawned program would be measuring that instead of this.
 */

const live: PtySession[] = [];

afterEach(() => {
  while (live.length > 0) live.pop()!.dispose();
});

/**
 * The mirror the hub gives every window, fed one stream of output.
 *
 * xterm parses a write on its own schedule, so the screen is read back only
 * once it has settled rather than on the next line.
 */
async function mirror(cols: number, rows: number, output: string): Promise<PtySession> {
  const p = new PtySession(`width-${live.length}`, cols, rows, null, 'heuristic');
  live.push(p);
  p.restore(output);
  await new Promise((r) => setTimeout(r, 50));
  return p;
}

const COLS = 20;

/*
 * Four emoji the agent writes as two columns each, then ASCII filler up to one
 * column past the right edge. The program therefore knows this frame wrapped
 * onto two rows; a terminal counting the emoji as one column each sees 17
 * columns and one row, and that single row is the whole defect.
 */
const WIDE = '\u{1F914}\u{1F527}\u{1F528}\u{1F52C}';
const WIDE_COLS = 8;
const band = (tag: string) => WIDE + tag.repeat(COLS + 1 - WIDE_COLS);

describe('the width table a terminal counts with', () => {
  it('spends two columns on an emoji, as the program that wrote it did', async () => {
    const term = new Terminal({ cols: 40, rows: 4, allowProposedApi: true });
    useUnicode11(term);
    expect(term.unicode.activeVersion).toBe('11');

    await new Promise<void>((r) => term.write(WIDE, r));
    // Unicode 6 has none of these in its wide ranges and stops at 4.
    expect(term.buffer.active.cursorX).toBe(WIDE_COLS);
    term.dispose();
  });
});

describe('a frame redrawn above the cursor', () => {
  it('leaves the line above it alone', async () => {
    // The redraw Ink emits for a frame it knows took two rows: up one, back to
    // the left edge, erase from there, draw again.
    const redraw = `\x1b[1A\r\x1b[J${band('b')}`;
    const p = await mirror(COLS, 6, `status\r\n${band('a')}${redraw}`);

    // With Unicode 6 widths the band sat on one row, so this went up onto the
    // status line and erased it along with everything under it.
    expect(p.tailLines(6)).toBe(`status\n${band('b')}`);
  });
});
