/**
 * Reading terminal input and output back as what it is, for tracing.
 *
 * Nothing here is on a hot path by itself — every caller is behind a debug
 * switch — but it lives in the protocol package because the interesting
 * question spans four processes. A wheel over a remote terminal is encoded in
 * the browser, framed by the canvas hub, forwarded over the peer link, and
 * written to a pty on another machine; each hop logs separately, and a trace
 * is only worth reading if all four spell the same event the same way.
 *
 * The decoders are deliberately lenient. A log that says "6 bytes" for
 * something it half-recognises is worse than one that says what it saw and
 * lets the reader disagree.
 */

/** A byte burst as hex, capped so a paste cannot fill the log. */
export function hexBytes(bytes: Uint8Array, limit = 32): string {
  const shown = Array.from(bytes.subarray(0, limit))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  return bytes.length > limit ? `${shown} … (${bytes.length}B)` : shown;
}

/** Printable rendering of an input burst, with escapes made visible. */
function asText(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0x1b) out += '\\e';
    else if (b === 0x0d) out += '\\r';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x09) out += '\\t';
    else if (b < 0x20 || b === 0x7f) out += `\\x${b.toString(16).padStart(2, '0')}`;
    else if (b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/**
 * What one mouse button field means.
 *
 * The wheel is the reason this exists: it is not a button in the low two bits
 * but bit 6, so a wheel report and a left-click differ by 64 and read
 * identically to anyone counting buttons. Bits 2-4 are the modifiers.
 */
function describeButton(b: number): string {
  const motion = (b & 32) !== 0;
  const wheel = (b & 64) !== 0;
  const low = b & 3;
  const mods = [
    b & 4 ? 'shift' : '',
    b & 8 ? 'meta' : '',
    b & 16 ? 'ctrl' : '',
  ].filter(Boolean);
  let name: string;
  if (wheel) name = low === 0 ? 'wheel-up' : low === 1 ? 'wheel-down' : `wheel-${low}`;
  else if (low === 3) name = 'release';
  else name = ['left', 'middle', 'right'][low]!;
  if (motion && !wheel) name += '-motion';
  return mods.length ? `${name}+${mods.join('+')}` : name;
}

/**
 * An X10 mouse report: `ESC [ M b x y`, each of the last three offset by 32.
 *
 * This is the encoding a program gets when it enables tracking without also
 * asking for SGR, and it is the one that cannot survive being treated as
 * text: past column or row 95 the coordinate byte is above 0x7f, which is not
 * UTF-8 at all. A trace that shows a two-byte coordinate where this expects
 * one is looking at exactly that corruption.
 */
function decodeX10(bytes: Uint8Array): string | null {
  if (bytes.length < 6) return null;
  if (bytes[0] !== 0x1b || bytes[1] !== 0x5b || bytes[2] !== 0x4d) return null;
  const b = bytes[3]! - 32;
  const col = bytes[4]! - 32;
  const row = bytes[5]! - 32;
  const tail = bytes.length > 6 ? ` +${bytes.length - 6}B` : '';
  return `X10 ${describeButton(b)} col=${col} row=${row}${tail}`;
}

/** An SGR mouse report: `ESC [ < b ; col ; row M|m`, all in decimal. */
function decodeSgr(bytes: Uint8Array): string | null {
  const s = asText(bytes);
  const m = /^\\e\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
  if (!m) return null;
  const press = m[4] === 'M' ? 'press' : 'release';
  return `SGR ${describeButton(Number(m[1]))} col=${m[2]} row=${m[3]} ${press}`;
}

/**
 * One line describing a burst of terminal input.
 *
 * Mouse reports are named because they are what a scroll trace is looking
 * for; everything else is shown as text plus hex, because the failure this
 * exists to catch is a report arriving as the wrong bytes rather than not
 * arriving at all.
 */
export function describeInput(bytes: Uint8Array): string {
  const mouse = decodeX10(bytes) ?? decodeSgr(bytes);
  if (mouse) return `${mouse} [${hexBytes(bytes)}]`;
  return `"${asText(bytes)}" [${hexBytes(bytes)}]`;
}

/** The same, for input a caller is holding as one-byte-per-code-unit text. */
export function describeLatin1(data: string): string {
  const bytes = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
  return describeInput(bytes);
}

/**
 * The modes that decide whether a wheel is the program's business or the
 * terminal's, named by what they do rather than by number.
 *
 * `?1049` is here because it is the one that explains a terminal with no
 * scrollback at all: on the alternate screen there is nothing to scroll to,
 * so a program that has not also asked for mouse reports cannot be scrolled
 * by any means. That combination — alternate screen, no tracking — is the
 * shape a stale CLI leaves behind, and it is worth being able to see it
 * rather than infer it.
 */
const MODE_NAMES: Record<string, string> = {
  '9': 'x10-mouse',
  '1000': 'vt200-mouse',
  '1002': 'drag-mouse',
  '1003': 'any-motion-mouse',
  '1004': 'focus-events',
  '1005': 'utf8-mouse-encoding',
  '1006': 'sgr-mouse-encoding',
  '1015': 'urxvt-mouse-encoding',
  '1016': 'sgr-pixel-encoding',
  '1047': 'alt-screen',
  '1049': 'alt-screen+cursor',
  '47': 'alt-screen-legacy',
};

export interface ModeChange {
  mode: string;
  name: string;
  set: boolean;
}

/**
 * Every mouse or screen mode the program flipped in this chunk of output.
 *
 * Read off the stream rather than off a terminal, because the interesting
 * moment is often before any terminal exists to ask: the hub sees a session's
 * whole life, a freshly mounted window sees only what arrives after it
 * attached. Both ends log through this so the two views can be compared.
 */
export function modeChanges(text: string): ModeChange[] {
  const out: ModeChange[] = [];
  // A single DECSET/DECRST can carry several modes, e.g. `ESC [ ? 1002;1006 h`.
  for (const m of text.matchAll(/\x1b\[\?([\d;]+)([hl])/g)) {
    for (const mode of m[1]!.split(';')) {
      const name = MODE_NAMES[mode];
      if (name) out.push({ mode, name, set: m[2] === 'h' });
    }
  }
  return out;
}

/** Those changes as one loggable phrase, or null when there were none. */
export function describeModeChanges(text: string): string | null {
  const changes = modeChanges(text);
  if (changes.length === 0) return null;
  return changes.map((c) => `${c.set ? '+' : '-'}${c.name}(?${c.mode})`).join(' ');
}

/**
 * What a serialized screen would restore, as far as scrolling is concerned.
 *
 * `@xterm/addon-serialize` replays the tracking mode but not the *encoding*
 * one, so a snapshot can restore `?1003h` without `?1006h` and leave a
 * reattached window sending X10 reports to a program that had been getting
 * SGR ones. Worth being able to see in a trace, because the two ends of a
 * remote session deliver their snapshots by different routes.
 */
export function describeSnapshotModes(serialized: string): string {
  const changes = modeChanges(serialized);
  if (changes.length === 0) return 'no mouse/screen modes';
  return changes.map((c) => `${c.set ? '+' : '-'}${c.name}`).join(' ');
}
