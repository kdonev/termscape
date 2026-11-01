/**
 * Every keyboard shortcut on the canvas, in one place.
 *
 * Three things read this module and must agree, which is why it is one
 * module: the canvas's own keydown listener, the help overlay that lists the
 * shortcuts, and the terminal's custom key handler - which has to know a
 * chord is ours *before* xterm encodes it, or the agent receives the key too.
 *
 * ## Why Ctrl+Shift
 *
 * A terminal cannot tell Ctrl+Shift+K from Ctrl+K: both are the byte 0x0B,
 * because the control range has no room for a shift bit. So a TUI can never
 * bind the shifted form, and taking it costs the agent nothing - Ctrl+K still
 * reaches it as Ctrl+K. That is also why every terminal emulator puts its own
 * commands there, so the shape is already familiar.
 *
 * Three programs do distinguish the shifted form, by reading the browser's or
 * their runtime's key event rather than the byte, and those are left alone:
 *
 * - Claude Code: Ctrl+Shift+- is undo (the same thing as Ctrl+_).
 * - Gemini CLI: Ctrl+Shift+Z is redo, Ctrl+Shift+G opens an external editor.
 *
 * Also avoided, because the canvas runs in a webview and in a browser tab:
 * Ctrl+Shift+C/V (copy and paste), T/N/W/Tab/Q (tabs and windows), I/J
 * (devtools), P (Firefox's private window); and on a Mac Cmd+Shift+digit
 * (screenshots) and Cmd+Shift+/ (the Help menu).
 *
 * ## Why e.code and not e.key
 *
 * `e.key` is the character the layout produces, so with a Cyrillic layout
 * active Ctrl+Shift+K arrives as `к` and every letter shortcut stops working.
 * `e.code` is the physical key whatever the layout, which is what a shortcut
 * means. The cost is that a Dvorak user gets the Qwerty positions; that is
 * the same trade every editor makes.
 *
 * Kept pure so it can be tested without a DOM, like paste.ts and
 * rightClick.ts.
 */

/** Everything a key can ask the canvas to do. */
export type Action =
  /* ---- the one chord that works while a terminal has the keyboard ---- */
  | 'mode.toggle'
  /* ---- overlays ---- */
  | 'palette'
  | 'labelJump'
  | 'panel'
  | 'help'
  /* ---- the zoom ladder ---- */
  | 'zoom.in'
  | 'zoom.out'
  /* ---- moving the selection ---- */
  | 'select.left'
  | 'select.down'
  | 'select.up'
  | 'select.right'
  | 'select.next'
  | 'select.prev'
  /* ---- moving the viewport ---- */
  | 'pan.left'
  | 'pan.down'
  | 'pan.up'
  | 'pan.right'
  /* ---- acting on what is selected ---- */
  | 'focus.enter'
  | 'session.restart'
  | 'session.close'
  /* ---- making things ---- */
  | 'new.agent'
  | 'new.note'
  | 'new.workspace'
  /* ---- unwinding ---- */
  | 'escape';

export interface KeyLike {
  type: string;
  /** Physical key - `KeyH`, `Digit3`, `Equal`. See the note above. */
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Jumping straight to the nth window of a workspace. Separate from `Action`
 * because it carries the number, and only canvas mode has it - as a global
 * chord it would collide with the Mac's screenshot keys.
 */
export interface IndexAction {
  kind: 'select.index';
  /** 1-based, as printed on the key. */
  index: number;
}

export type Command = Action | IndexAction;

/* --------------------------------------------------------- modifiers */

/**
 * Whether this event carries exactly the canvas's modifier and nothing else.
 *
 * Cmd on a Mac, Ctrl everywhere else, and the other one must be *up*: without
 * that, Ctrl+Cmd+K on a Mac would fire the palette as a side effect of some
 * other binding the user has.
 */
function hasMod(e: KeyLike, isMac: boolean): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/* ------------------------------------------------------- the two tables */

/**
 * Ctrl/Cmd+Shift chords, by physical key. These work everywhere, including
 * while a terminal has the keyboard, which is the whole reason they are
 * modified at all.
 *
 * Deliberately short. Everything that does not earn a chord of its own lives
 * in the palette, and that is what keeps this table from growing into a
 * second mode nobody can remember.
 */
const CHORDS: Record<string, Action> = {
  Space: 'mode.toggle',
  KeyK: 'palette',
  KeyF: 'labelJump',
  KeyE: 'panel',
  ArrowLeft: 'select.left',
  ArrowDown: 'select.down',
  ArrowUp: 'select.up',
  ArrowRight: 'select.right',
};

/**
 * Canvas mode, where the keyboard belongs to the canvas and plain keys act.
 * `hjkl` moves the selection and Shift with it moves the viewport, so the
 * same four keys mean "go there" and "look there".
 */
const MODE_KEYS: Record<string, Action> = {
  KeyH: 'select.left',
  KeyJ: 'select.down',
  KeyK: 'select.up',
  KeyL: 'select.right',
  ArrowLeft: 'select.left',
  ArrowDown: 'select.down',
  ArrowUp: 'select.up',
  ArrowRight: 'select.right',
  Tab: 'select.next',
  Enter: 'focus.enter',
  KeyF: 'labelJump',
  KeyP: 'panel',
  KeyA: 'new.agent',
  KeyN: 'new.note',
  KeyR: 'session.restart',
  KeyX: 'session.close',
  Slash: 'palette',
  Escape: 'escape',
};

/** The shifted half of canvas mode. Checked before MODE_KEYS. */
const MODE_SHIFT_KEYS: Record<string, Action> = {
  KeyH: 'pan.left',
  KeyJ: 'pan.down',
  KeyK: 'pan.up',
  KeyL: 'pan.right',
  ArrowLeft: 'pan.left',
  ArrowDown: 'pan.down',
  ArrowUp: 'pan.up',
  ArrowRight: 'pan.right',
  Tab: 'select.prev',
  KeyW: 'new.workspace',
  // Shift because `?` is the shifted slash on every layout we can name, and
  // because a bare `/` is the palette one row up.
  Slash: 'help',
};

/* ------------------------------------------------------- the zoom ladder */

/**
 * Which way Ctrl/Cmd and a plus or minus key want to move the ladder.
 *
 * Asymmetric on purpose, and it is the one rule in here worth stating twice:
 * zoom in takes Equal with or without Shift, because `+` *is* Shift+Equal on
 * the layouts we care about and both spellings should work. Zoom out takes
 * Minus only *unshifted*, because Ctrl+Shift+- is Claude Code's undo and
 * readline's Ctrl+_. Stealing undo to save one keystroke's worth of symmetry
 * is not a trade worth making.
 */
function zoomDirection(e: KeyLike): Action | null {
  if (e.code === 'NumpadAdd') return 'zoom.in';
  if (e.code === 'NumpadSubtract') return 'zoom.out';
  if (e.code === 'Equal') return 'zoom.in';
  if (e.code === 'Minus') return e.shiftKey ? null : 'zoom.out';
  return null;
}

/* ----------------------------------------------------------- the lookups */

/**
 * The command a chord asks for, or null. Valid wherever the keyboard is,
 * terminal included - see `reserved` for how it gets there.
 */
export function globalChord(e: KeyLike, isMac: boolean): Command | null {
  if (e.type !== 'keydown' || e.altKey || !hasMod(e, isMac)) return null;

  // The ladder is unshifted-or-either, so it is checked before the Shift gate
  // below rules out everything without it.
  const zoom = zoomDirection(e);
  if (zoom) return zoom;

  if (!e.shiftKey) return null;
  return CHORDS[e.code] ?? null;
}

/**
 * The command a plain key asks for while canvas mode is on. Only ever
 * consulted when the mode is on, so there is nothing here to guard against a
 * stray `x` closing a window at the wrong moment.
 */
export function modeKey(e: KeyLike): Command | null {
  if (e.type !== 'keydown' || e.altKey || e.ctrlKey || e.metaKey) return null;
  if (e.shiftKey) return MODE_SHIFT_KEYS[e.code] ?? null;

  // 1-9, as printed. Digit0 is left out: there is no zeroth window, and a
  // ten-window workspace is past the point where counting beats label jump.
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { kind: 'select.index', index: Number(digit[1]) };

  // Plus and minus walk the same ladder as the chord, without the modifier:
  // in canvas mode the keyboard is already ours, so asking for Ctrl as well
  // would be ceremony.
  const zoom = zoomDirection(e);
  if (zoom) return zoom;

  return MODE_KEYS[e.code] ?? null;
}

/**
 * Whether the terminal must keep this key away from the program.
 *
 * `Terminal.tsx` returns false from xterm's custom key handler on a true
 * here. Without it xterm encodes the chord and writes it to the pty, so the
 * agent acts on a key the canvas has already acted on - Ctrl+Shift+E both
 * opening the panel and reaching Claude Code as Ctrl+E, "end of line".
 *
 * Only the chords: canvas mode takes the keyboard away from the terminal
 * entirely, so a mode key never reaches xterm to begin with.
 */
export function reserved(e: KeyLike, isMac: boolean): boolean {
  return globalChord(e, isMac) !== null;
}

/* ----------------------------------------------------------- the help text */

/** One row of the help overlay. */
export interface HelpRow {
  keys: string;
  what: string;
}

/**
 * What the help overlay and the palette print. Written out rather than
 * derived from the tables above, because "Ctrl+Shift+H/J/K/L" is one row to a
 * reader and four entries to a lookup, and because the order that teaches is
 * not the order that looks up.
 *
 * `mod` is spelled by the caller, which knows whether it is on a Mac.
 */
export function helpRows(mod: string): { title: string; rows: HelpRow[] }[] {
  return [
    {
      title: 'Anywhere, including while typing to an agent',
      rows: [
        { keys: `${mod}+Shift+Space`, what: 'Canvas mode on or off' },
        { keys: `${mod}+Shift+K`, what: 'Command palette' },
        { keys: `${mod}+Shift+F`, what: 'Jump to a window by its badge' },
        { keys: `${mod}+Shift+E`, what: 'Side panel' },
        { keys: `${mod}+Shift+←↓↑→`, what: 'Select the next window or note' },
        { keys: `${mod}+ + / -`, what: 'Zoom in to the window, out to the workspace, out to everything' },
      ],
    },
    {
      title: 'Canvas mode',
      rows: [
        { keys: 'h j k l', what: 'Select the next window or note' },
        { keys: 'Shift+h j k l', what: 'Pan' },
        { keys: '+ / -', what: 'The same zoom ladder' },
        { keys: 'Tab / Shift+Tab', what: 'Next or previous window' },
        { keys: '1 - 9', what: 'The nth window of this workspace' },
        { keys: 'Enter', what: 'Type to the selected agent, or into the note' },
        { keys: 'f', what: 'Jump to a window by its badge' },
        { keys: '/', what: 'Command palette' },
        { keys: 'p', what: 'Side panel' },
        { keys: 'a / n / Shift+W', what: 'New agent here, new note, new workspace' },
        { keys: 'r / x', what: 'Resume or restart, close' },
        { keys: '?', what: 'This list' },
        { keys: 'Esc', what: 'Close, then deselect, then leave canvas mode' },
      ],
    },
  ];
}
