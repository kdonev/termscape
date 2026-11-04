/**
 * Opt-in tracing in the browser, off unless asked for.
 *
 * The browser is where a scroll bug has to be ruled in or out first, because
 * it is the only place that knows whether a wheel produced a mouse report at
 * all. Everything downstream can only see reports that were sent; nothing
 * downstream can see one that xterm decided not to encode.
 *
 * Turn it on with `?debug=input` on the canvas URL. The value is kept in
 * localStorage so a reload keeps it, and `?debug=off` clears it again.
 *
 * Topics, comma separated, or `all`:
 *   input    wheel events, what xterm made of them, and what left the socket
 *   output   only the mode changes arriving from the program, which are what
 *            decide whether a wheel is the program's business or xterm's
 *   attach   mount, attach, resize, and what a replayed snapshot restores
 *   viewport every zoom and pan decision the canvas makes - see canvas/trace.ts
 *
 * A remote session spans two more processes; both hubs take the same topics
 * through `TERMSCAPE_DEBUG`. See packages/hub/src/debug.ts.
 *
 * Separately from the console, `viewport` is always kept in a ring buffer in
 * memory and travels with a bug report's exported logs, exactly as the hub
 * keeps `deliver` and `attach` whether or not they are on (hub/src/debug.ts).
 * A view that ended up in the wrong place is noticed after the fact, with the
 * console closed and the gesture that did it long gone; a handful of lines per
 * gesture is cheap enough to have on hand. The noisy topics - `input` under
 * mouse tracking, `output` - are kept only while they are on.
 */
const KEY = 'termscape-debug';

function resolveTopics(): Set<string> {
  let raw = '';
  try {
    raw = localStorage.getItem(KEY) ?? '';
  } catch {
    // Private-mode storage. The query parameter still works for this load.
  }
  // No window at all: a unit test importing a module that traces. The kept log
  // still works, which is what a test of it needs; there is no address bar to
  // read a topic from and nothing reading the console either.
  if (typeof window === 'undefined') return new Set();
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('debug');
  if (fromUrl !== null) {
    raw = fromUrl === 'off' || fromUrl === '0' ? '' : fromUrl;
    try {
      if (raw) localStorage.setItem(KEY, raw);
      else localStorage.removeItem(KEY);
    } catch {
      // As above: this load is still traced, the next one is not.
    }
    // Taken out of the address bar for the same reason the token is: a URL
    // that is copied and shared should not turn tracing on for somebody else.
    url.searchParams.delete('debug');
    window.history.replaceState({}, '', url.toString());
  }
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const topics = resolveTopics();
const all = topics.has('all') || topics.has('1') || topics.has('true');

/**
 * Whether a topic is on. Worth checking before building a message: under
 * mouse tracking mode `?1003h` the input topic fires once per motion event,
 * and describing a report costs more than logging one.
 */
export function debugOn(topic: string): boolean {
  return all || topics.has(topic);
}

/** Topics recorded in memory whether or not they are on. */
const ALWAYS_KEPT = new Set(['viewport']);

/**
 * How many lines the in-memory log holds before the oldest go.
 *
 * Smaller than the hub's 5000: this one is sent over the socket when logs are
 * exported, and the bug a viewport trace diagnoses is in the last gesture or
 * two rather than in this morning's.
 */
export const RECENT_LOG_LINES = 2000;

const recent: string[] = [];

/**
 * One line in the kept log.
 *
 * Timestamped here rather than at export, in the same ISO format the hub uses,
 * so the browser's lines and the hub's sort together in a report that holds
 * both - which is the point of keeping them: a resize the canvas asked for and
 * the resize the pty got are one event seen from two ends.
 */
function remember(topic: string, text: string): void {
  recent.push(`${new Date().toISOString()} [${topic}] ${text}`);
  if (recent.length > RECENT_LOG_LINES) recent.splice(0, recent.length - RECENT_LOG_LINES);
}

/**
 * The kept log, oldest first, for the bug-report export.
 *
 * Nothing in it is private by construction: the lines that reach it carry
 * geometry, session ids and gesture timings, never window titles, addresses,
 * terminal contents or the canvas token. Anything added to a kept topic has to
 * hold to that - the file is meant to be sendable.
 */
export function canvasLog(): string[] {
  return [...recent];
}

/** For tests: start from an empty log. */
export function clearCanvasLog(): void {
  recent.length = 0;
}

/**
 * One trace line, tagged so a devtools filter of `termscape` finds them all.
 *
 * `text` is the whole line for the kept log; extra args are for the console
 * only, where an object can be expanded. A kept topic therefore says
 * everything it means in `text`, because that is all the export sees.
 */
export function debug(topic: string, text: string, ...args: unknown[]): void {
  const on = debugOn(topic);
  if (!on && !ALWAYS_KEPT.has(topic)) return;
  if (ALWAYS_KEPT.has(topic)) remember(topic, text);
  if (!on) return;
  console.debug(`%c[termscape:${topic}]`, 'color:#7c9cf5', text, ...args);
}

if (topics.size > 0) {
  console.info(
    `[termscape] tracing ${all ? 'all' : [...topics].join(', ')}. ` +
      'Add ?debug=off to stop. Both hubs take the same topics in TERMSCAPE_DEBUG.',
  );
}
