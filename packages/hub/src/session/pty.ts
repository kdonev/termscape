import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { platform } from 'node:process';
import type { AgentStatus } from '@aicanvas/protocol';
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

    this.cols = opts.cols;
    this.rows = opts.rows;
    this.term.resize(opts.cols, opts.rows);

    this.proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as Record<string, string>,
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
    if (this.statusMode === 'heuristic') this.scheduleIdleCheck();
  }

  /**
   * Heuristic idle detection: quiet for a beat, and the last non-empty line
   * looks like a prompt. Drives the status chip only — never gates delivery,
   * because delivery is immediate by design.
   */
  private scheduleIdleCheck(): void {
    this.markBusy();
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (Date.now() - this.lastOutputAt < 400) return;
      const tail = this.tailLines(1).trim();
      const looksIdle = this.readyHint ? this.readyHint.test(tail) : true;
      this.setStatus(looksIdle ? 'idle' : 'busy');
    }, 500);
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

  /** Trailing rendered lines, for the read_screen MCP tool. */
  tailLines(n: number): string {
    const buf = this.term.buffer.active;
    const end = buf.baseY + this.term.rows;
    const start = Math.max(0, end - n);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      out.push(buf.getLine(i)?.translateToString(true) ?? '');
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
