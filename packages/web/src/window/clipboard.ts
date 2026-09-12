/**
 * Clipboard access that survives a non-secure context.
 *
 * The canvas is meant to be opened from a phone or a second machine on the
 * LAN (see packages/hub/src/remote/lan.ts and the http listener it serves
 * from), and on anything but localhost that is a non-secure context by the
 * browser's own definition - `navigator.clipboard` is `undefined` there, not
 * merely permission-denied. Neither helper below may assume the API exists.
 *
 * The two directions are not symmetric. `document.execCommand('copy')` is a
 * deprecated but still-implemented escape hatch that works from a detached,
 * off-screen textarea regardless of context, so writing has a fallback.
 * Reading has no equivalent: there is no non-secure-context API that returns
 * clipboard contents, synthesised or otherwise, so a read on such an origin
 * comes back `null` rather than pretending to succeed.
 */

/**
 * Write `text` to the clipboard, trying the async API first and an
 * `execCommand` textarea if that is missing or refuses. Returns whether
 * anything actually landed, so a caller can decide whether it is safe to
 * clear a selection it just tried to copy.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Falls through to the textarea below - permission denied, or the async
    // API exists but rejected for a reason of its own.
  }

  const el = document.createElement('textarea');
  el.value = text;
  // Off-screen rather than hidden: execCommand('copy') requires a selection,
  // and an element display:none has no selectable rendered text.
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  document.body.appendChild(el);
  el.focus();
  el.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(el);
  }
}

/**
 * Read the clipboard, or `null` when it cannot be read at all - either the
 * API is absent (a non-secure context) or the user declined the permission
 * prompt. There is no fallback for reading: unlike a copy, a paste has
 * nothing to synthesise from, so the caller must be able to tell "nothing to
 * paste" apart from "this failed silently" and trace the difference.
 */
export async function readClipboard(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}
