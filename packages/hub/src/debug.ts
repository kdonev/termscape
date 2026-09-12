/**
 * Opt-in tracing, off unless asked for.
 *
 * Off by default because the thing worth tracing is also the noisiest: mouse
 * tracking mode `?1003h` reports every motion, so a hub that logged input
 * unasked would spend more on the log than on the pty. Set
 * `TERMSCAPE_DEBUG=input` to turn it on.
 *
 * Topics, comma separated, or `all`:
 *   input   every keystroke, paste and mouse report, at each hop it takes
 *   output  only the mode changes in a program's output — what it asked the
 *           terminal for, which is what decides whose job a wheel is
 *   attach  attach, detach, resize, and what a replayed snapshot restores
 *
 * A remote session is two hubs, and each logs only its own half. To see a
 * wheel all the way to the program, set this on the canvas machine *and* on
 * the attached machine — the peer request id appears on both sides, so the
 * two logs line up on it.
 */
const topics = new Set(
  (process.env.TERMSCAPE_DEBUG ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const all = topics.has('all') || topics.has('1') || topics.has('true');

/**
 * Whether a topic is on. Exported so a caller can skip building a message it
 * is about to throw away — describing a mouse report costs more than logging
 * one, and on `?1003h` that is per motion event.
 */
export function debugOn(topic: string): boolean {
  return all || topics.has(topic);
}

/** One trace line on stderr, so it never lands in a piped stdout. */
export function debug(topic: string, message: string): void {
  if (!debugOn(topic)) return;
  console.error(`[${topic}] ${message}`);
}

/** Which topics are on, for the banner. Empty when tracing is off. */
export function debugTopics(): string[] {
  if (all) return ['all'];
  return [...topics];
}
