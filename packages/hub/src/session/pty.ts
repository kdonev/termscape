import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { platform } from 'node:process';
import type { AgentStatus } from '@termscape/protocol';
import { buildAgentEnv } from '../agents/env.js';
// Type-only imports are erased at compile time, so they are safe against the
// CJS interop problem described below while still typing the values.
import type { IPty } from 'node-pty';
import type { Terminal as XTerm } from '@xterm/headless';
import type { SerializeAddon as XSerializeAddon } from '@xterm/addon-serialize';

/*
 * node-pty, @xterm/headless and @xterm/addon-serialize are CommonJS, and their
 * typings use `declare module` with named exports. That combination is a trap:
 * `import { Terminal } from '@xterm/headless'` typechecks cleanly and then
 * throws at runtime, because Node's CJS named-export detection cannot see
 * through their bundled output. createRequire gets us the real exports while
 * `typeof import(...)` keeps full type information.
 */
const require = createRequire(import.meta.url);
const pty = require('node-pty') as typeof import('node-pty');
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

export interface PtyStartOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
}

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

/** How much history the hub keeps in memory for live reattach. Never persisted. */
const SCROLLBACK_LINES = 2000;
/** Scrollback included when replaying to a browser that just attached. */
const ATTACH_SCROLLBACK = 1000;

/**
 * How long a `heuristic` profile must be quiet before its last line is worth
 * testing against the prompt pattern.
 */
const HEURISTIC_QUIET_MS = 400;

/**
 * How long a `hooks` profile whose hooks have never arrived must be quiet
 * before it is called idle. Longer, because this path has no prompt pattern to
 * check and only silence to go on - and an agent mid-turn is animating a
 * spinner, which is not silence.
 */
const HOOK_FALLBACK_QUIET_MS = 2000;

/**
 * One PTY plus a headless xterm that mirrors it.
 *
 * The headless terminal earns its keep twice: it produces the serialized
 * screen we persist to SQLite, and it is the in-memory scrollback that backs
 * LOD detach/reattach. Feeding one parser instead of keeping a separate raw
 * ring buffer means the replayed screen is always consistent with what the
 * program actually drew, escape sequences and all.
 */
export class PtySession extends EventEmitter {
  private proc: IPty | null = null;
  private readonly term: XTerm;
  private readonly serializer: XSerializeAddon;
  private lastOutputAt = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private _status: AgentStatus = 'unknown';
  /**
   * Whether this session has ever reported a turn boundary itself. Until it
   * has, a `hooks` profile is indistinguishable from one whose hooks cannot
   * run at all, and the dot has to come from somewhere.
   */
  private hooksSeen = false;
  /** Last title this program set, to keep repeats off the wire. */
  private lastTitle: string | null = null;
  /** argv[0], to recognise the one title the program did not choose. */
  private launchedFile = '';
  private disposed = false;

  constructor(
    readonly id: string,
    public cols: number,
    public rows: number,
    private readonly readyHint: RegExp | null,
    private readonly statusMode: 'hooks' | 'heuristic',
  ) {
    super();
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);

    // OSC 0 and OSC 2, read off the mirror terminal rather than with a regex
    // over the stream. The parser already handles a sequence split across two
    // reads and either terminator, and nothing has to be stripped: the
    // browser's own terminal is entitled to the same bytes.
    this.term.onTitleChange((title) => {
      const next = title.trim();
      if (next === this.lastTitle || this.isLaunchNoise(next)) return;
      this.lastTitle = next;
      this.emit('title', next);
    });
  }

  /**
   * ConPTY announces the child's image path as the terminal title the moment
   * it starts, before the program has said anything at all. That is Windows
   * talking, not the agent, and `C:...node.exe` in a window header is worse
   * than the canvas address it would replace.
   */
  private isLaunchNoise(title: string): boolean {
    if (!this.launchedFile) return false;
    const same = (a: string, b: string) =>
      platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    return (
      same(title, this.launchedFile) || same(title, basename(this.launchedFile))
    );
  }

  get status(): AgentStatus {
    return this._status;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  start(opts: PtyStartOptions): void {
    if (this.proc) throw new Error(`session ${this.id} already running`);
    const [file, ...args] = opts.argv;
    if (!file) throw new Error('empty argv');

    this.launchedFile = file;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.term.resize(opts.cols, opts.rows);

    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      // Strips the parent agent CLI's own session state; see agents/env.ts for
      // why inheriting it wholesale breaks resume and leaks an IPC channel.
      env: buildAgentEnv(process.env, opts.env),
      // ConPTY is the only way to get a real PTY on Windows; node-pty falls
      // back to winpty on older builds, which we do not support.
      useConpty: platform === 'win32' ? true : undefined,
    });

    this.proc.onData((data) => this.ingest(data));
    this.proc.onExit(({ exitCode, signal }) => {
      this.proc = null;
      this.clearIdleTimer();
      this._status = 'unknown';
      this.emit('exit', { exitCode, signal } satisfies PtyExit);
    });

    this.markBusy();
  }

  /** Feed output to subscribers and to the mirror terminal. */
  private ingest(data: string): void {
    if (this.disposed) return;
    this.lastOutputAt = Date.now();
    this.term.write(data);
    this.emit('data', data);
    // A hooked session that has reported a boundary is left to its hooks.
    // One that never has is watched like any other, or it would sit on
    // whatever status it started with for the life of the process.
    if (this.statusMode === 'heuristic' || !this.hooksSeen) this.scheduleIdleCheck();
  }

  /**
   * Idle detection from output alone. Drives the status chip only — never
   * gates delivery, because delivery is immediate by design.
   *
   * Two callers, with different standards of proof. A `heuristic` profile has
   * a prompt pattern, so a short quiet spell plus a matching last line is
   * enough. A `hooks` profile only reaches here while its hooks have never
   * arrived, and has nothing to match against, so it waits out a longer
   * silence and takes that as the answer.
   */
  private scheduleIdleCheck(): void {
    this.markBusy();
    this.clearIdleTimer();
    const fallback = this.statusMode === 'hooks';
    const quiet = fallback ? HOOK_FALLBACK_QUIET_MS : HEURISTIC_QUIET_MS;
    this.idleTimer = setTimeout(() => {
      if (Date.now() - this.lastOutputAt < quiet) return;
      if (fallback) {
        // A hook that arrived while this was pending outranks it.
        if (!this.hooksSeen) this.setStatus('idle');
        return;
      }
      const tail = this.lastNonEmptyLine();
      const looksIdle = this.readyHint ? this.readyHint.test(tail) : true;
      this.setStatus(looksIdle ? 'idle' : 'busy');
    }, quiet + 100);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  markBusy(): void {
    this.setStatus('busy');
  }

  /**
   * A turn boundary the agent reported itself. Exact, where reading the output
   * is a guess — so the first one to arrive retires the fallback for good and
   * this session's status is whatever its hooks say from then on.
   */
  noteHook(s: AgentStatus): void {
    this.hooksSeen = true;
    this.clearIdleTimer();
    this.setStatus(s);
  }

  setStatus(s: AgentStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.emit('status', s);
  }

  write(data: string): void {
    if (!this.proc) throw new Error(`session ${this.id} is not running`);
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    // A dead session still tracks its geometry so the restored window is right.
    this.proc?.resize(cols, rows);
  }

  /** Full-ish history, for a browser that just attached to this window. */
  serializeForAttach(): string {
    return this.serializer.serialize({ scrollback: ATTACH_SCROLLBACK });
  }

  /**
   * Screen only. This is what goes in SQLite: a restart preserves the last
   * screenful, deliberately not the scrollback above it.
   */
  serializeForPersist(): string {
    return this.serializer.serialize({ scrollback: 0 });
  }

  /**
   * The last line the program actually drew, wherever it is on the screen.
   *
   * Not the bottom row: a CLI sitting at its prompt after printing one banner
   * has its prompt at the top and twenty-three blank rows under it, and
   * testing the bottom row against a prompt pattern matched nothing, ever.
   * That is what kept a freshly started window amber for the life of the
   * process.
   */
  private lastNonEmptyLine(): string {
    const drawn = this.tailLines(this.rows);
    return drawn.slice(drawn.lastIndexOf('\n') + 1).trim();
  }

  /**
   * Trailing rendered lines, for the read_screen MCP tool.
   *
   * Rows the terminal wrapped are rejoined. A wrap is a property of how
   * wide the window happens to be, not of the text, so breaking a line
   * there hands the reader a word split down the middle at a column that
   * depends on someone else's terminal size - and the reader here is an
   * agent trying to make sense of what another agent is doing.
   */
  tailLines(n: number): string {
    const buf = this.term.buffer.active;
    const end = buf.baseY + this.term.rows;
    const start = Math.max(0, end - n);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString(true) ?? '';
      if (line?.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    return out.join('\n');
  }

  /** Restore a persisted screen into the mirror so reattach shows it. */
  restore(serialized: string): void {
    if (serialized) this.term.write(serialized);
  }

  kill(): void {
    this.clearIdleTimer();
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      // Already gone; onExit has fired or will not fire. Nothing to do.
    }
    this.proc = null;
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
    this.term.dispose();
    this.removeAllListeners();
  }
}
