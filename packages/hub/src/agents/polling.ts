/**
 * Catches an agent watching a screen instead of waiting for a reply.
 *
 * The wording and the brief say waiting means ending your turn, but that only
 * ever reaches a model that reads it before it acts - and one already mid-loop
 * on `read_screen` has nothing left to read. This is what lands *after* the
 * loop has started: `Hub.readScreen` attaches a `note` to the third read of
 * the same screen inside a minute, telling the agent to stop.
 *
 * No hub dependency, so it unit-tests on its own.
 */

export const POLL_WINDOW_MS = 60_000;
/** Reads of one screen inside the window before a note is attached. */
export const POLL_NUDGE_AFTER = 3;

const SEP = '\0';
const keyOf = (a: string, b: string) => `${a}${SEP}${b}`;

export class PollWatch {
  /** Last `send_message` from one address to another, keyed `from\0to`. */
  private readonly sent = new Map<string, number>();
  /** Read timestamps, keyed `reader\0target`, newest last. */
  private readonly reads = new Map<string, number[]>();

  noteMessage(from: string, to: string, at: number = Date.now()): void {
    this.prune(at);
    this.sent.set(keyOf(from, to), at);
  }

  /** Records the read and returns the line to attach, or null. */
  noteRead(reader: string, target: string, at: number = Date.now()): string | null {
    this.prune(at);
    const k = keyOf(reader, target);
    const times = [...(this.reads.get(k) ?? []), at];
    this.reads.set(k, times);

    if (times.length < POLL_NUDGE_AFTER) return null;

    const outstanding = this.sent.has(keyOf(reader, target));
    return outstanding
      ? `You asked ${target} something and have read their screen ${times.length} times ` +
          'since. Watching does not make an answer arrive — a reply is typed into your ' +
          'terminal and starts your next turn. Stop here and wait.'
      : `You have read this screen ${times.length} times in the last minute. If you are ` +
          'waiting on something, ask for it with send_message and then end your turn; the ' +
          'answer is typed into your terminal. To see only whether an agent is working, ' +
          'list_agents says idle or busy in one call.';
  }

  /**
   * Drops anything older than the window and any entry that leaves empty, so
   * neither map grows with a hub that has been up for a week. Run on every
   * touch rather than on a timer: both maps are sized by the number of
   * address pairs actually talking, which stays small.
   */
  private prune(at: number): void {
    const cutoff = at - POLL_WINDOW_MS;
    for (const [k, sentAt] of this.sent) {
      if (sentAt <= cutoff) this.sent.delete(k);
    }
    for (const [k, times] of this.reads) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) this.reads.delete(k);
      else this.reads.set(k, kept);
    }
  }
}
