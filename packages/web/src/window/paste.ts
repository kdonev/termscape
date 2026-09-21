/**
 * Which keys paste into a terminal, and what a paste carries.
 *
 * xterm turns Ctrl+V into `^V` and cancels the keydown, so on its own the
 * browser never fires a `paste` at all; and when one does fire, xterm reads
 * only its `text/plain` - an image on the clipboard is dropped. Issue 33 is
 * both halves of that.
 *
 * An image is not pasted as an image, because a terminal has no such thing.
 * It is saved on the machine running the session, and its *path* is pasted
 * instead: the agent CLIs attach an image when its path is pasted into their
 * prompt. That is the one route that works for every CLI and wherever the
 * browser and the agent each are - a CLI reading the OS clipboard itself
 * would only ever see the clipboard of its own machine.
 *
 * Two ways of reading the clipboard, because they have different reach:
 *
 * - `native`: let the browser fire its own `paste` event and take the image
 *   out of `clipboardData`. Works everywhere, including a plain-http canvas
 *   opened from another machine, where `navigator.clipboard` does not exist.
 *   Ctrl+V and Shift+Insert, and Cmd+V on a Mac, which needs nothing from us.
 * - `async`: `navigator.clipboard.read()`, secure contexts only. Ctrl+Shift+V
 *   needs it because the browser's own Ctrl+Shift+V is "paste as plain text"
 *   and strips the image; right-click needs it because a click is not a paste.
 *
 * Kept pure so it can be tested without a DOM, like rightClick.ts.
 */
import { PASTE_IMAGE_TYPES, type PasteImageType } from '@termscape/protocol';

export interface PasteChord {
  route: 'native' | 'async';
  /**
   * What the key means to a program when there turns out to be nothing on
   * the clipboard, so taking it over costs nothing in that case: Ctrl+V is
   * still `^V` to anything that reads the clipboard itself on it.
   */
  fallback?: string;
}

export interface KeyLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function pasteChord(e: KeyLike, isMac: boolean): PasteChord | null {
  if (e.type !== 'keydown' || e.altKey || e.metaKey) return null;
  const v = e.key === 'v' || e.key === 'V';
  // On a Mac, Cmd+V already pastes natively and Ctrl+V is a terminal's ^V.
  if (!isMac && e.ctrlKey && v) {
    return e.shiftKey ? { route: 'async' } : { route: 'native', fallback: '\x16' };
  }
  if (e.shiftKey && !e.ctrlKey && e.key === 'Insert') return { route: 'native' };
  return null;
}

export function isPasteImageType(type: string): type is PasteImageType {
  return Object.hasOwn(PASTE_IMAGE_TYPES, type);
}

interface ItemLike {
  kind: string;
  type: string;
  getAsFile(): File | null;
}

/** The first image a native paste carries, or null. */
export function pastedImage(
  dt: { items: ArrayLike<ItemLike> } | null | undefined,
): File | null {
  if (!dt) return null;
  for (let i = 0; i < dt.items.length; i++) {
    const item = dt.items[i]!;
    if (item.kind === 'file' && isPasteImageType(item.type)) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

/**
 * base64 of some bytes, for the `pasteImage` frame. Chunked because
 * `String.fromCharCode(...bytes)` on a multi-megabyte screenshot overflows
 * the argument limit.
 */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
