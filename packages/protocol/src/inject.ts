/**
 * Encoding for text written into another agent's PTY.
 *
 * Two properties matter here and both are security-relevant:
 *
 *  1. Attribution cannot be forged. The `from` address is supplied by the hub
 *     from the sender's bearer token, never by the sending agent.
 *
 *  2. A message cannot break out of its own paste. Bracketed paste is framed
 *     by ESC[200~ ... ESC[201~; a body containing the terminator would end the
 *     paste early and let the remainder be interpreted as keystrokes. We strip
 *     the terminator (and bare ESC) from the body before framing.
 */

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

export type InjectMode = 'bracketed' | 'raw';

/** Strip anything that would let a body escape its paste framing. */
export function sanitizeMessageBody(text: string): string {
  return text
    .replace(/\x1b/g, '') // no escape sequences of any kind survive
    .replace(/\r\n?/g, '\n') // normalize newlines; CR would submit early
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // other control chars
}

/** The visible, unspoofable prefix a receiving agent sees. */
export function formatMessage(from: string, text: string): string {
  return `[from ${from}] ${sanitizeMessageBody(text)}`;
}

/**
 * The keypress that submits an injected message.
 *
 * Deliberately not part of `encodeInjection`, and the split is the whole
 * point of it. The CR used to be appended to the paste and written in the
 * same go, on the reasonable-sounding grounds that a terminal sees the paste
 * end and then an Enter. Agent TUIs do not behave that way: they debounce a
 * paste - Claude Code among them, and deliberately, so that a pasted block
 * full of newlines cannot fire off half-written prompts - and anything
 * arriving inside that window is folded into the pasted text. A CR glued to
 * the end of the paste therefore became a literal newline in the composer,
 * and the message sat there fully typed and never sent. From the outside
 * that looked like an agent messaging another and getting no answer, with
 * its text plainly visible in the other's terminal.
 *
 * So it goes in on its own, once the paste has landed. `PtySession.inject`
 * owns that timing.
 */
export const INJECT_SUBMIT = '\r';

/**
 * Wire bytes for injecting `body` into a PTY - the message itself, without
 * the keypress that sends it.
 *
 * Bracketed paste makes a multi-line body arrive as one atomic paste rather
 * than as a line-by-line keystroke stream, so a CLI that reads line-at-a-time
 * does not act on a half-delivered message. `INJECT_SUBMIT` follows separately.
 */
export function encodeInjection(body: string, mode: InjectMode): string {
  const clean = sanitizeMessageBody(body);
  if (mode === 'raw') return clean;
  return `${PASTE_START}${clean}${PASTE_END}`;
}
