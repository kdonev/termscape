import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { PtySession, useUnicode11 } from '../src/session/pty.js';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');

/**
 * What a serialized screen costs when it is parsed at the wrong width.
 *
 * A browser that attaches is sent the whole screen and writes it into a fresh
 * terminal. Which grid that terminal has at the time is not a detail: a
 * snapshot is a screenful of text, and the width it is parsed at decides where
 * every line of it wraps. `TerminalView` used to create its terminal at
 * xterm's 80x24 default and size it a moment later, so a snapshot that a
 * previous mount had left unread was parsed at 80 columns and then reflowed
 * into the real grid. This is the measurement that says what that did, and so
 * why the terminal is now created at the measured grid instead.
 */

const COLS = 120;
const ROWS = 30;

const live: PtySession[] = [];

afterEach(() => {
  while (live.length > 0) live.pop()!.dispose();
});

const settle = () => new Promise((r) => setTimeout(r, 50));

/** A screen with the two things a width change can spoil: a wrap, and a box. */
async function sourceScreen(): Promise<string> {
  const p = new PtySession('snapshot-grid', COLS, ROWS, null, 'heuristic');
  live.push(p);
  p.restore(
    '$ claude\r\n' +
      `${'prose long enough to wrap at a hundred and twenty columns, '.repeat(3)}\r\n` +
      `\u256d${'\u2500'.repeat(COLS - 2)}\u256e\r\n` +
      `\u2502 > ask it something${' '.repeat(COLS - 21)}\u2502\r\n` +
      `\u2570${'\u2500'.repeat(COLS - 2)}\u256f`,
  );
  await settle();
  return p.serializeForAttach();
}

/** A browser's terminal, built the way TerminalView builds one. */
function restoreInto(cols: number, rows: number) {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  useUnicode11(term);
  return {
    term,
    write: (d: string) => new Promise<void>((r) => term.write(d, r)),
    read: () => {
      const b = term.buffer.active;
      const out: string[] = [];
      for (let i = b.baseY; i < b.baseY + term.rows; i++) {
        const line = b.getLine(i);
        out.push(`${line?.isWrapped ? '>' : ' '}${line?.translateToString(true) ?? ''}`);
      }
      while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
      return out.join('\n');
    },
    cursor: () => `${term.buffer.active.cursorY},${term.buffer.active.cursorX}`,
  };
}

describe('a snapshot restored into a browser terminal', () => {
  it('comes back exactly when the terminal is already at the right grid', async () => {
    const snapshot = await sourceScreen();
    const source = restoreInto(COLS, ROWS);
    await source.write(snapshot);

    const direct = restoreInto(COLS, ROWS);
    await direct.write(snapshot);

    // Named, so this cannot pass by comparing two blank screens.
    expect(source.read()).toContain('> ask it something');
    expect(direct.read()).toBe(source.read());
    expect(direct.cursor()).toBe(source.cursor());
    direct.term.dispose();
    source.term.dispose();
  });

  it('does not, when it is parsed at 80 columns and resized afterwards', async () => {
    const snapshot = await sourceScreen();
    const source = restoreInto(COLS, ROWS);
    await source.write(snapshot);

    const reflowed = restoreInto(80, 24);
    await reflowed.write(snapshot);
    reflowed.term.resize(COLS, ROWS);
    await reflowed.write('');

    /*
     * The assertion is about xterm's reflow, not about our code: widening does
     * not undo a wrap, so the box drawn to the full width comes back broken
     * across two rows. If this ever starts passing, the ordering in
     * TerminalView is no longer load-bearing and this file can go.
     */
    expect(reflowed.read()).not.toBe(source.read());

    // The one that does the damage. Every redraw a TUI makes is measured from
    // the cursor, and the reflow leaves it on another row entirely.
    expect(reflowed.cursor()).not.toBe(source.cursor());
    reflowed.term.dispose();
    source.term.dispose();
  });
});
