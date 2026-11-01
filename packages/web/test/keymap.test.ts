import { describe, expect, it } from 'vitest';
import {
  globalChord,
  helpRows,
  modeKey,
  reserved,
  type KeyLike,
} from '../src/canvas/keymap.js';

/*
 * The shortcuts, pinned without a DOM (issue 52).
 *
 * Most of these exist because the conflict they guard against is invisible in
 * the code: a terminal cannot distinguish Ctrl+Shift+K from Ctrl+K, so taking
 * the shifted form is free - except for the three places an agent reads the
 * key event itself rather than the byte, and those are what the "leaves X
 * alone" tests are about.
 */

const key = (over: Partial<KeyLike>): KeyLike => ({
  type: 'keydown',
  code: 'KeyK',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

/** A Ctrl+Shift chord on Windows and Linux. */
const chord = (code: string) => key({ code, ctrlKey: true, shiftKey: true });

describe('globalChord', () => {
  it('reads the mode toggle, which has to work while a terminal has the keyboard', () => {
    expect(globalChord(chord('Space'), false)).toBe('mode.toggle');
  });

  it('reads the overlays and the directional selection', () => {
    expect(globalChord(chord('KeyK'), false)).toBe('palette');
    expect(globalChord(chord('KeyF'), false)).toBe('labelJump');
    expect(globalChord(chord('KeyE'), false)).toBe('panel');
    expect(globalChord(chord('ArrowLeft'), false)).toBe('select.left');
    expect(globalChord(chord('ArrowRight'), false)).toBe('select.right');
  });

  it('wants Cmd on a Mac and Ctrl everywhere else, never either', () => {
    const ctrl = key({ code: 'KeyK', ctrlKey: true, shiftKey: true });
    const cmd = key({ code: 'KeyK', metaKey: true, shiftKey: true });
    expect(globalChord(ctrl, false)).toBe('palette');
    expect(globalChord(ctrl, true)).toBeNull();
    expect(globalChord(cmd, true)).toBe('palette');
    expect(globalChord(cmd, false)).toBeNull();
  });

  it('ignores a chord with the other modifier also held', () => {
    // Ctrl+Cmd+Shift+K on a Mac belongs to whatever the user bound it to.
    expect(globalChord(key({ code: 'KeyK', metaKey: true, ctrlKey: true, shiftKey: true }), true))
      .toBeNull();
    expect(globalChord(key({ code: 'KeyK', ctrlKey: true, shiftKey: true, altKey: true }), false))
      .toBeNull();
  });

  it('needs Shift, so Ctrl+K still reaches the agent as kill-to-end-of-line', () => {
    expect(globalChord(key({ code: 'KeyK', ctrlKey: true }), false)).toBeNull();
  });

  it('ignores keyup, so a chord fires once', () => {
    expect(globalChord({ ...chord('KeyK'), type: 'keyup' }, false)).toBeNull();
  });

  it('leaves the letters that browsers and agents own', () => {
    // Copy, paste, tabs, windows, devtools, Firefox's private window.
    for (const code of ['KeyC', 'KeyV', 'KeyT', 'KeyN', 'KeyW', 'KeyI', 'KeyJ', 'KeyQ', 'KeyP']) {
      expect(globalChord(chord(code), false)).toBeNull();
    }
    // Gemini CLI reads these two itself: redo, and open an external editor.
    expect(globalChord(chord('KeyZ'), false)).toBeNull();
    expect(globalChord(chord('KeyG'), false)).toBeNull();
  });
});

describe('the zoom ladder', () => {
  it('takes + and = and the numpad for zooming in', () => {
    expect(globalChord(key({ code: 'Equal', ctrlKey: true }), false)).toBe('zoom.in');
    // `+` is Shift+Equal on the layouts this has to work on.
    expect(globalChord(key({ code: 'Equal', ctrlKey: true, shiftKey: true }), false)).toBe('zoom.in');
    expect(globalChord(key({ code: 'NumpadAdd', ctrlKey: true }), false)).toBe('zoom.in');
  });

  it('takes an unshifted minus for zooming out', () => {
    expect(globalChord(key({ code: 'Minus', ctrlKey: true }), false)).toBe('zoom.out');
    expect(globalChord(key({ code: 'NumpadSubtract', ctrlKey: true }), false)).toBe('zoom.out');
  });

  it('leaves Ctrl+Shift+- alone, because that is undo in Claude Code', () => {
    // The one asymmetry in the whole map, and the reason for it: Ctrl+Shift+-
    // is Ctrl+_ - undo in readline and in Claude Code's own prompt.
    expect(globalChord(key({ code: 'Minus', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(reserved(key({ code: 'Minus', ctrlKey: true, shiftKey: true }), false)).toBe(false);
  });

  it('wants the modifier, so a bare minus still types a minus', () => {
    expect(globalChord(key({ code: 'Minus' }), false)).toBeNull();
    expect(globalChord(key({ code: 'Equal' }), false)).toBeNull();
  });
});

describe('modeKey', () => {
  it('moves the selection on hjkl and pans on the shifted ones', () => {
    expect(modeKey(key({ code: 'KeyH' }))).toBe('select.left');
    expect(modeKey(key({ code: 'KeyJ' }))).toBe('select.down');
    expect(modeKey(key({ code: 'KeyK' }))).toBe('select.up');
    expect(modeKey(key({ code: 'KeyL' }))).toBe('select.right');
    expect(modeKey(key({ code: 'KeyH', shiftKey: true }))).toBe('pan.left');
    expect(modeKey(key({ code: 'KeyL', shiftKey: true }))).toBe('pan.right');
  });

  it('cycles on Tab and reverses on Shift+Tab', () => {
    expect(modeKey(key({ code: 'Tab' }))).toBe('select.next');
    expect(modeKey(key({ code: 'Tab', shiftKey: true }))).toBe('select.prev');
  });

  it('reads 1-9 as a window index, and leaves 0 out', () => {
    expect(modeKey(key({ code: 'Digit1' }))).toEqual({ kind: 'select.index', index: 1 });
    expect(modeKey(key({ code: 'Digit9' }))).toEqual({ kind: 'select.index', index: 9 });
    expect(modeKey(key({ code: 'Digit0' }))).toBeNull();
  });

  it('walks the ladder without a modifier, since the keyboard is already ours', () => {
    expect(modeKey(key({ code: 'Equal' }))).toBe('zoom.in');
    expect(modeKey(key({ code: 'Minus' }))).toBe('zoom.out');
  });

  it('separates the palette from the help list by Shift', () => {
    expect(modeKey(key({ code: 'Slash' }))).toBe('palette');
    expect(modeKey(key({ code: 'Slash', shiftKey: true }))).toBe('help');
  });

  it('acts on the selection, and unwinds on Escape', () => {
    expect(modeKey(key({ code: 'Enter' }))).toBe('focus.enter');
    expect(modeKey(key({ code: 'KeyR' }))).toBe('session.restart');
    expect(modeKey(key({ code: 'KeyX' }))).toBe('session.close');
    expect(modeKey(key({ code: 'KeyA' }))).toBe('new.agent');
    expect(modeKey(key({ code: 'KeyN' }))).toBe('new.note');
    expect(modeKey(key({ code: 'KeyW', shiftKey: true }))).toBe('new.workspace');
    expect(modeKey(key({ code: 'Escape' }))).toBe('escape');
  });

  it('ignores anything carrying a modifier, so the chords still win', () => {
    expect(modeKey(key({ code: 'KeyK', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(modeKey(key({ code: 'KeyH', metaKey: true }))).toBeNull();
    expect(modeKey(key({ code: 'KeyH', altKey: true }))).toBeNull();
  });
});

describe('reserved', () => {
  it('is exactly the chords, so the terminal keeps those from the program', () => {
    expect(reserved(chord('KeyE'), false)).toBe(true);
    expect(reserved(key({ code: 'Minus', ctrlKey: true }), false)).toBe(true);
  });

  it('is not the mode keys, which never reach xterm anyway', () => {
    expect(reserved(key({ code: 'KeyH' }), false)).toBe(false);
    // Ctrl+E is end-of-line and must arrive intact.
    expect(reserved(key({ code: 'KeyE', ctrlKey: true }), false)).toBe(false);
  });
});

describe('helpRows', () => {
  it('spells the modifier the way the caller asks', () => {
    const rows = helpRows('Cmd').flatMap((g) => g.rows);
    expect(rows.some((r) => r.keys === 'Cmd+Shift+Space')).toBe(true);
    expect(rows.some((r) => r.keys.includes('Ctrl'))).toBe(false);
  });

  it('covers every chord, so the overlay cannot drift from the table', () => {
    const printed = helpRows('Ctrl')
      .flatMap((g) => g.rows)
      .map((r) => r.keys)
      .join(' ');
    for (const k of ['Space', 'K', 'F', 'E']) {
      expect(printed).toContain(`Ctrl+Shift+${k}`);
    }
  });
});
