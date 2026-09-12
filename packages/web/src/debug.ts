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
 *   input   wheel events, what xterm made of them, and what left the socket
 *   output  only the mode changes arriving from the program, which are what
 *           decide whether a wheel is the program's business or xterm's
 *   attach  mount, attach, resize, and what a replayed snapshot restores
 *
 * A remote session spans two more processes; both hubs take the same topics
 * through `TERMSCAPE_DEBUG`. See packages/hub/src/debug.ts.
 */
const KEY = 'termscape-debug';

function resolveTopics(): Set<string> {
  let raw = '';
  try {
    raw = localStorage.getItem(KEY) ?? '';
  } catch {
    // Private-mode storage. The query parameter still works for this load.
  }
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

/** One trace line, tagged so a devtools filter of `termscape` finds them all. */
export function debug(topic: string, ...args: unknown[]): void {
  if (!debugOn(topic)) return;
  console.debug(`%c[termscape:${topic}]`, 'color:#7c9cf5', ...args);
}

if (topics.size > 0) {
  console.info(
    `[termscape] tracing ${all ? 'all' : [...topics].join(', ')}. ` +
      'Add ?debug=off to stop. Both hubs take the same topics in TERMSCAPE_DEBUG.',
  );
}
