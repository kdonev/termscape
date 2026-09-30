import { format } from 'node:util';

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
 *   deliver messages and first instructions on their way into an agent: the
 *           route taken, the wait for a CLI to be ready, the hooks it reports,
 *           and every Enter - the first, and any sent again, and why not
 *
 * For a message that sits unsent in a composer, `deliver` on the machine that
 * owns the agent is the one that matters: that hub types it, and that hub
 * decides whether to press Enter again.
 *
 * A remote session is two hubs, and each logs only its own half. To see a
 * wheel all the way to the program, set this on the canvas machine *and* on
 * the attached machine — the peer request id appears on both sides, so the
 * two logs line up on it.
 *
 * Separately from stderr, `deliver` and `attach` are always kept in memory,
 * with whatever the hub printed to the console, for the bug-report export
 * (see bug-report.ts). A lost message is noticed after the fact, when it is
 * too late to restart the hub with tracing on; the few lines per message
 * these topics cost are worth having on hand. `input` and `output` are kept
 * only when they are on, for the reason above.
 */
const topics = new Set(
  (process.env.TERMSCAPE_DEBUG ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const all = topics.has('all') || topics.has('1') || topics.has('true');

/** Topics recorded in memory whether or not they are on. */
const ALWAYS_KEPT = new Set(['deliver', 'attach']);

/** How many lines the in-memory log holds before the oldest go. */
export const RECENT_LOG_LINES = 5000;

const recent: string[] = [];

/** Values that must never reach the in-memory log, however they got printed. */
const secrets = new Set<string>();

/**
 * Keep a value out of the in-memory log from now on.
 *
 * The banner prints the canvas URL with its token, for the person at the
 * terminal. That line is fine on their screen and wrong in a file they may
 * send to somebody else, so it is replaced as it is recorded.
 */
export function redactFromLog(secret: string): void {
  if (secret.length >= 8) secrets.add(secret);
}

function remember(line: string): void {
  for (const s of secrets) {
    if (line.includes(s)) line = line.split(s).join('<redacted>');
  }
  recent.push(`${new Date().toISOString()} ${line}`);
  if (recent.length > RECENT_LOG_LINES) recent.splice(0, recent.length - RECENT_LOG_LINES);
}

/** The in-memory log, oldest first, each line prefixed with its time. */
export function recentLog(): string[] {
  return [...recent];
}

/** For tests: start from an empty log. */
export function clearRecentLog(): void {
  recent.length = 0;
  secrets.clear();
}

/**
 * Whether a topic is on. Exported so a caller can skip building a message it
 * is about to throw away — describing a mouse report costs more than logging
 * one, and on `?1003h` that is per motion event.
 */
export function debugOn(topic: string): boolean {
  return all || topics.has(topic);
}

/** Set while `debug` prints, so the console tee does not record it twice. */
let printing = false;

/** One trace line on stderr, so it never lands in a piped stdout. */
export function debug(topic: string, message: string): void {
  const on = debugOn(topic);
  if (!on && !ALWAYS_KEPT.has(topic)) return;
  const line = `[${topic}] ${message}`;
  remember(line);
  if (!on) return;
  printing = true;
  try {
    console.error(line);
  } finally {
    printing = false;
  }
}

/** Which topics are on, for the banner. Empty when tracing is off. */
export function debugTopics(): string[] {
  if (all) return ['all'];
  return [...topics];
}

let captured = false;

/**
 * Keep what the hub prints to the console in the in-memory log as well.
 *
 * `[peer]`, `[warn]`, `[unhandled]` and the rest are printed straight to the
 * console from wherever they happen, and a hub started from a shortcut or by
 * the supervisor has nobody reading that console. Idempotent.
 */
export function captureConsole(): void {
  if (captured) return;
  captured = true;
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (!printing) remember(format(...args));
      original(...args);
    };
  }
}
