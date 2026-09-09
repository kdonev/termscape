import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { encodeInjection, INJECT_SUBMIT, PASTE_END } from '@termscape/protocol';
import { PtySession } from '../src/session/pty.js';
import { removeTree } from './tmp.js';

/**
 * How an injected message reaches the program on the other side of the PTY.
 *
 * The bug: an agent messaged another, the message arrived and was plainly
 * visible in the recipient's composer, and it was never sent. The Enter was
 * appended to the bracketed paste and written in one go, which reads fine and
 * is wrong — an agent TUI debounces a paste on purpose, so that a pasted block
 * full of newlines cannot fire off half-written prompts, and a CR arriving
 * inside that window is folded into the pasted text rather than acted on.
 *
 * So the property under test is not what the bytes are, it is that they arrive
 * as two separate reads with a gap between them. That is only observable
 * against a real PTY, which is why this spawns one.
 *
 * What it records goes to a file rather than back out of the PTY: a terminal
 * wraps and reflows what is written to it, which would corrupt the record on
 * its way to being read.
 */
const RECORD_PROGRAM = `
  const fs = require('fs');
  const out = process.argv[1];
  const t0 = Date.now();
  // Raw mode, or there is nothing to measure. A Windows console left in line
  // mode buffers input until it sees an Enter and then hands the child one
  // cooked line - the paste and the submit merged, the escape sequences gone.
  // Every agent TUI raises raw mode for itself; this stands in for that.
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', (b) => {
    fs.appendFileSync(out, JSON.stringify({ at: Date.now() - t0, data: b.toString('utf8') }) + '\\n');
  });
  setTimeout(() => {}, 30000);
`;

interface Read {
  at: number;
  data: string;
}

const home = mkdtempSync(join(tmpdir(), 'termscape-inject-'));
const live: PtySession[] = [];
/**
 * Never reset, unlike `live` - which is emptied after every test, so numbering
 * from it handed the third recorder the first one's file and its records with
 * it.
 */
let recorders = 0;

function startRecorder(): { pty: PtySession; reads: () => Read[] } {
  const n = recorders++;
  const file = join(home, `reads-${n}.jsonl`);
  const p = new PtySession(`inject-${n}`, 120, 24, null, 'heuristic');
  live.push(p);
  p.start({
    argv: [process.execPath, '-e', RECORD_PROGRAM, file],
    env: {},
    cwd: process.cwd(),
    cols: 120,
    rows: 24,
  });
  const reads = (): Read[] => {
    try {
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Read);
    } catch {
      // Nothing written yet, which is "no reads" rather than a failure.
      return [];
    }
  };
  return { pty: p, reads };
}

function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Let the child install its stdin handler before anything is written at it. */
async function ready(pty: PtySession): Promise<void> {
  await waitFor(() => pty.running, 5000);
  await new Promise((r) => setTimeout(r, 700));
}

afterEach(() => {
  while (live.length > 0) live.pop()!.dispose();
});

afterAll(() => removeTree(home));

describe('injecting a message into a PTY', () => {
  it('sends the Enter as its own read, after the paste', async () => {
    const { pty, reads } = startRecorder();
    await ready(pty);

    pty.inject(encodeInjection('[from ws/other] take a look', 'bracketed'), INJECT_SUBMIT);

    const arrived = await waitFor(
      () => reads().some((r) => r.data.includes(INJECT_SUBMIT)),
      5000,
    );
    expect(arrived, `reads: ${JSON.stringify(reads())}`).toBe(true);

    const all = reads();
    const paste = all.find((r) => r.data.includes(PASTE_END));
    const submit = all.find((r) => r.data.includes(INJECT_SUBMIT))!;

    // Two reads, not one. A single read carrying both is exactly the bug.
    expect(paste, `reads: ${JSON.stringify(all)}`).toBeDefined();
    expect(paste).not.toBe(submit);
    expect(paste!.data).not.toContain(INJECT_SUBMIT);
    expect(submit.data).toBe(INJECT_SUBMIT);

    // And with a real gap, not merely a separate write in the same tick: a
    // debounce measured in frames has to have expired by then.
    expect(submit.at - paste!.at).toBeGreaterThanOrEqual(50);
  }, 20_000);

  it('waits for a long message to finish going in before sending it', async () => {
    // A message past one write chunk is fed in paced pieces. An Enter timed
    // from the first of them would land in the middle of the paste, which is
    // worse than landing glued to the end of it.
    const { pty, reads } = startRecorder();
    await ready(pty);

    pty.inject(encodeInjection('x'.repeat(5000), 'bracketed'), INJECT_SUBMIT);

    await waitFor(() => reads().some((r) => r.data.includes(INJECT_SUBMIT)), 10_000);

    const all = reads();
    const submitIndex = all.findIndex((r) => r.data.includes(INJECT_SUBMIT));
    expect(submitIndex, `reads: ${all.length}`).toBeGreaterThan(0);
    // The Enter is the last thing in: everything else arrived before it.
    expect(submitIndex).toBe(all.length - 1);
    expect(all[submitIndex]!.data).toBe(INJECT_SUBMIT);
  }, 30_000);

  it('sends one Enter when two messages land back to back', async () => {
    // Two pending submits would put a stray Enter into an empty composer,
    // which an agent CLI reads as a prompt of its own.
    const { pty, reads } = startRecorder();
    await ready(pty);

    pty.inject(encodeInjection('first', 'bracketed'), INJECT_SUBMIT);
    pty.inject(encodeInjection('second', 'bracketed'), INJECT_SUBMIT);

    await waitFor(() => reads().some((r) => r.data.includes(INJECT_SUBMIT)), 5000);
    await new Promise((r) => setTimeout(r, 600));

    const all = reads();
    expect(
      all.filter((r) => r.data.includes(INJECT_SUBMIT)),
      `reads: ${JSON.stringify(all)}`,
    ).toHaveLength(1);
  }, 20_000);
});
