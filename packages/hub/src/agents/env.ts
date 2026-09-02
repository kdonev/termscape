/**
 * Environment sanitizing for spawned agents.
 *
 * Agents inherit the hub's environment so they can find their tools and
 * credentials. But when the hub itself is launched from inside an agent CLI —
 * which is not exotic; it is how you would develop this app — that parent's
 * private session state is in the environment too, and inheriting it is
 * actively harmful:
 *
 *   CLAUDE_CODE_CHILD_SESSION   marks the child as a sub-session, which turns
 *                               transcript saving OFF. Since --resume reads
 *                               that transcript, inheriting this silently
 *                               breaks the resume feature entirely.
 *   CLAUDE_CODE_MESSAGING_SOCKET / _TOKEN
 *                               the parent session's private IPC channel. A
 *                               spawned agent must not be handed it.
 *   CLAUDE_CODE_SESSION_ID / _HOST_SESSION_ID / CLAUDE_PID
 *                               identify the parent run; a child adopting them
 *                               confuses session bookkeeping on both sides.
 *
 * So anything that identifies the *parent agent process* is stripped, while
 * ordinary user configuration (PATH, HOME, ANTHROPIC_API_KEY, proxy settings)
 * is passed through untouched.
 */

/** Exact names that must never reach a spawned agent. */
const STRIP_EXACT = new Set(['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT']);

/** Prefixes whose whole family is parent-session state. */
const STRIP_PREFIXES = [
  'CLAUDE_CODE_',
  'CLAUDE_AGENT_SDK_',
  'CLAUDE_PREVIEW_',
];

export function shouldStrip(name: string): boolean {
  const upper = name.toUpperCase();
  if (STRIP_EXACT.has(upper)) return true;
  return STRIP_PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * Base environment for a spawned agent: the hub's environment minus the
 * parent-session variables, plus the profile's own overrides.
 *
 * Profile overrides win, so a profile can deliberately re-add something that
 * would otherwise be stripped.
 */
export function buildAgentEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (shouldStrip(k)) continue;
    out[k] = v;
  }
  return { ...out, ...overrides };
}

/** Names that were removed, for logging and for the tests to assert on. */
export function strippedNames(base: NodeJS.ProcessEnv): string[] {
  return Object.keys(base).filter(shouldStrip).sort();
}
