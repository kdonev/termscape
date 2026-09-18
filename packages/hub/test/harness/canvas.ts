/**
 * A disposable two-hub canvas with real agent CLIs in the PTYs.
 *
 * Why this exists: the bugs worth chasing here - a message that arrives and is
 * never submitted, an opening instruction spent on a question, an instruction
 * that goes missing after the first one - are properties of a real agent TUI's
 * paste debounce and hook timing. A scripted stand-in can only confirm what we
 * already modelled, and the live canvas a developer is using is the wrong thing
 * to experiment on. So: hubs stood up from this checkout, thrown away
 * afterwards, running the CLI a user actually runs.
 *
 * What it gives a test:
 *
 *   - a canvas hub, in this process, with its own home, db and port;
 *   - any number of *worker* hubs, each a real child process that joined over
 *     the real `--join` handshake, with its own home and port;
 *   - real `claude` sessions on either side, and an MCP client authenticated as
 *     any of them, so a test calls `spawn_agent` / `send_message` /
 *     `read_screen` exactly as an agent does.
 *
 * Two things about it are load-bearing and easy to undo by accident.
 *
 * `paths.hubHome()` reads `process.env.TERMSCAPE_HOME` on every call, so that
 * variable is the only handle an in-process hub has on its state - which means
 * exactly one canvas per process. `startLiveCanvas` enforces that rather than
 * letting two hubs quietly share a database. Worker hubs are immune: their home
 * reaches them through their spawn environment, which is the whole reason a
 * child process is a more faithful test than `enroll.test.ts`'s in-process
 * join (that one has to inject `tokenFile` and `machineIdFile` overrides to
 * fake two machines inside one).
 *
 * And a worker hub does not die when its canvas goes away - `joinCanvas`
 * reconnects forever - so a leaked worker is a permanent stray holding a port
 * and a `claude` process. Teardown is therefore graceful-then-forced, and
 * `stopLiveCanvases` is registered by every test file's `afterAll`.
 *
 * Manual sweep, if a run is killed in a way that defeats both:
 *   Windows:  Get-CimInstance Win32_Process | ? { $_.CommandLine -match 'termscape-live-worker' } | % { taskkill /PID $_.ProcessId /T /F }
 *   POSIX:    pkill -f termscape-live-worker
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Session, Workspace } from '@termscape/protocol';
import { Hub } from '../../src/hub.js';
import { serve } from '../../src/server.js';
import { BUILTIN_PROFILES } from '../../src/agents/profiles.js';
import { which } from '../../src/agents/resolve.js';
import { removeTree } from '../tmp.js';

/**
 * Every wait has its own budget, so a failure says which phase timed out.
 * Vitest's own timeout should never be the thing that fires first: it aborts
 * the test without telling you where it was.
 */
export const LIVE_TIMEOUTS = {
  /** For `beforeAll`/`afterAll`'s third argument. */
  hook: 240_000,
  /** For `it`'s third argument. */
  test: 300_000,
  /** The child hub printing its port. */
  hubSpawn: 20_000,
  /** The child hub reporting it joined. */
  join: 30_000,
  /** The canvas seeing the host row go connected. */
  hostConnected: 15_000,
  /** A fresh agent answering its readiness ping. */
  agentBoot: 120_000,
  /** One turn of a real agent, once it is up. */
  turn: 120_000,
  /** A child hub asked nicely to stop. */
  gracefulExit: 15_000,
  /** The same child after it was killed. */
  forcedExit: 5_000,
} as const;

/** How much of a child hub's output is kept for failure messages. */
const OUTPUT_CAP = 64 * 1024;

/** How often a screen is re-read while waiting for something to appear on it. */
const POLL_MS = 500;

/** How long the canvas server gets to close before it is left to the process. */
const SERVER_CLOSE_DEADLINE_MS = 2000;

/** The prefix every worker home and label carries, for the manual sweep. */
const WORKER_TAG = 'termscape-live-worker';

/**
 * The workspace-trust dialog, as seen on the screen.
 *
 * Matched rather than inferred from the profile's `askingHint`: answering it
 * needs to know which option is which, not merely that it is up. The hint is
 * what the *hub* uses to decide not to type at all (see `typeWhenReady`), and
 * that stays its business.
 */
const TRUST_OPTION = /No, exit|Yes, I trust this folder/;
const TRUST_ACCEPT = /Yes, I trust this folder/;
/** What Claude Code draws beside the highlighted item of a select list. */
const SELECT_CURSOR = '❯';
/**
 * Ways of moving a select list, tried in order until one of them does.
 *
 * Normal cursor keys first, then the application-cursor-mode forms a TUI that
 * has set DECCKM expects instead, then Tab. Which of them a program listens
 * for is not knowable from outside it, and guessing wrong is silent.
 */
const MOVE_KEYS = [
  { down: '\x1b[B', up: '\x1b[A' },
  { down: '\x1bOB', up: '\x1bOA' },
  { down: '\t', up: '\x1b[Z' },
] as const;
/** How long between attempts at it, for as long as it is on screen. */
const TRUST_RETRY_MS = 4000;
/**
 * Gap between the keystrokes that answer it. A TUI coalesces input that
 * arrives inside one frame, and an arrow folded into the Enter after it moves
 * nothing and confirms the wrong option.
 */
const KEY_GAP_MS = 120;

/* ------------------------------------------------------------------- gate */

/** Whether the live suite was opted into. `vitest.live.config.ts` sets this. */
export function liveEnabled(): boolean {
  return process.env.TERMSCAPE_LIVE === '1';
}

/**
 * `describe`, skipped unless the live suite was opted into.
 *
 * Belt and braces: the file name already keeps these out of `npm test`'s
 * glob, and this keeps them out even if someone points another config at them.
 */
export function describeLive(name: string, fn: () => void): void {
  describe.skipIf(!liveEnabled())(name, fn);
}

/**
 * The agent CLI, or a failure that says what to do about it.
 *
 * Deliberately a throw rather than a skip. The developer opted in by running
 * `npm run test:live`; a silent skip there is a green run that proved nothing.
 * Called before anything is spawned, so nobody waits two minutes to find out
 * the CLI is absent.
 */
export function requireAgentCli(agent = 'claude'): string {
  const found = which(BUILTIN_PROFILES[agent]?.command ?? agent);
  if (found) return found;
  throw new Error(
    `live tests need the ${agent} CLI, and "${agent}" is not on PATH.\n` +
      `Install it, or point a [${agent}] profile at an absolute command.\n` +
      "These tests only run under `npm run test:live`; plain `npm test` never collects them.",
  );
}

/* ---------------------------------------------------------------- markers */

/**
 * A token to assert on, and the prompt that asks for it.
 *
 * The needle never appears in the prompt. That is the whole point: an agent
 * CLI echoes injected input into its own transcript, so asserting on a string
 * the prompt contains passes the instant the message lands and proves nothing
 * about the agent having read it. Asking for two halves to be joined means the
 * needle's literal form can only come from the agent.
 *
 * Kept short, because a screen is rendered text: a long needle gets wrapped at
 * whatever column the window happens to be and no longer matches.
 */
export function joinMarker(tag = 'ANS'): { prompt: string; needle: string } {
  const nonce = randomBytes(3).toString('hex');
  return {
    needle: `${tag}-${nonce}`,
    prompt:
      `Reply with one line: the word ${tag}, then a hyphen, then ${nonce} - ` +
      'no spaces around the hyphen. Say nothing else, use no tools, and do ' +
      'not read or write any files.',
  };
}

/* ------------------------------------------------------------------ types */

export interface McpAgent {
  /** Call a hub tool the way an agent does, and get its JSON back. */
  call<T = unknown>(tool: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export interface LiveAgent {
  /** The session id, which both hubs agree on even for a remote agent. */
  readonly sessionId: string;
  /** `workspace/name`, the address other agents use. */
  readonly address: string;
  /** The worker whose hub owns this PTY, or null for the canvas. */
  readonly worker: LiveWorker | null;
  /** An MCP client authenticated as this agent. Cached. */
  mcp(): Promise<McpAgent>;
  /** Trailing rendered lines of its terminal. */
  screen(lines?: number): Promise<string>;
  /** Type raw input at it, wherever it lives. */
  type(data: string): Promise<void>;
}

export interface LiveWorker {
  readonly label: string;
  /** The host row id on the canvas. */
  readonly hostId: string;
  readonly home: string;
  /** A real folder on this machine that its agents run in. */
  readonly workspaceRoot: string;
  /** The canvas-side workspace row pinned to this host. */
  readonly workspace: Workspace;
  readonly pid: number | undefined;
  /** Start a real agent on this worker, through the real relay. */
  startAgent(opts?: StartAgentOptions): Promise<LiveAgent>;
  /** Everything the child hub has printed, capped. */
  output(): string;
}

export interface StartAgentOptions {
  profile?: string;
  name?: string;
  /**
   * Wait for the agent to answer a readiness ping before returning. On by
   * default, and worth leaving on: an unauthenticated CLI, a pending update or
   * a trust dialog then fails here, in the first two minutes, with its screen
   * in the message - rather than five minutes later inside an assertion about
   * something else.
   */
  expectReady?: boolean;
  readyTimeoutMs?: number;
}

export interface LiveCanvasOptions {
  /** Worker hubs to stand up and join. Default 1. */
  workers?: number;
  /** Appended to the claude profile's argv, for both hubs. */
  claudeArgs?: string[];
  /**
   * Point the agent CLIs this test does not use at a command that does not
   * exist, so neither hub's boot probe spawns them. Default true.
   */
  isolateProfiles?: boolean;
  /** Mirror worker output to the console. Default from TERMSCAPE_LIVE_VERBOSE. */
  echoWorkers?: boolean;
  /** Leave homes and logs on disk. Default from TERMSCAPE_LIVE_KEEP. */
  keepArtifacts?: boolean;
  spawnCap?: number;
}

export interface LiveCanvas {
  readonly hub: Hub;
  readonly app: FastifyInstance;
  readonly origin: string;
  readonly home: string;
  /** The canvas's own workspace, on a real temp folder. */
  readonly workspace: Workspace;
  readonly workspaceRoot: string;
  readonly workers: LiveWorker[];
  /** Start a real agent on the canvas itself. */
  startAgent(opts?: StartAgentOptions): Promise<LiveAgent>;
  /** Trailing lines of any address, local or remote. No visibility check. */
  screenOf(address: string, lines?: number): Promise<string>;
  /** Poll until `fn` holds, or fail saying what was being waited for. */
  waitFor(fn: () => boolean | Promise<boolean>, label: string, timeoutMs?: number): Promise<void>;
  /** Poll a screen until `needle` is on it; returns the screen that matched. */
  waitForScreen(
    target: LiveAgent | string,
    needle: string | RegExp,
    opts?: { timeoutMs?: number; label?: string },
  ): Promise<string>;
  stop(): Promise<void>;
}

/* --------------------------------------------------------------- registry */

/**
 * Live canvases, and every child hub any of them started.
 *
 * Module level because the exit hook below has no other way to reach them, and
 * because a canvas that failed half way through building still has to be
 * stoppable.
 */
const canvases = new Set<LiveCanvas>();
const children = new Set<ChildProcess>();
let owner: LiveCanvas | null = null;

/**
 * Kill anything still running when this process goes away.
 *
 * Synchronous by necessity: an exit handler cannot await. This is the layer
 * that catches an assertion that threw past `afterAll`; a `globalSetup` sweep
 * catches the one that catches nothing, when the whole fork is terminated.
 */
process.once('exit', () => {
  for (const child of children) forceKill(child);
});

/** Stop every live canvas this module started. For `afterAll`. */
export async function stopLiveCanvases(): Promise<void> {
  for (const canvas of [...canvases]) await canvas.stop();
}

/* ----------------------------------------------------------------- canvas */

export async function startLiveCanvas(opts: LiveCanvasOptions = {}): Promise<LiveCanvas> {
  requireAgentCli();
  if (owner) {
    throw new Error(
      'a live canvas is already running in this worker, and only one in-process ' +
        'hub can own TERMSCAPE_HOME. Call stopLiveCanvases() first.',
    );
  }

  const keep = opts.keepArtifacts ?? !!process.env.TERMSCAPE_LIVE_KEEP;
  const echo = opts.echoWorkers ?? !!process.env.TERMSCAPE_LIVE_VERBOSE;
  const home = mkdtempSync(join(tmpdir(), 'termscape-live-canvas-'));
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'termscape-live-ws-'));
  const configDir = mkdtempSync(join(tmpdir(), 'termscape-live-cfg-'));
  const previousHome = process.env.TERMSCAPE_HOME;

  seedClaudeConfig(configDir);
  grantTrust(configDir, workspaceRoot);

  // Before the Hub is constructed: its constructor loads the profile and
  // template registries through paths.profiles(), and every session it starts
  // afterwards resolves its run directory the same way.
  process.env.TERMSCAPE_HOME = home;
  writeProfileFixture(home, opts, configDir);

  const workers: LiveWorker[] = [];
  /** Every MCP client handed out, so teardown can close their sockets. */
  const clients: McpAgent[] = [];
  let hub: Hub | null = null;
  let app: FastifyInstance | null = null;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    // Workers first, while the canvas is still up: the graceful stop travels
    // over the peer link, and there is nothing else on Windows - SIGTERM there
    // is TerminateProcess, so the child's own shutdown handler never runs and
    // its agent CLIs are orphaned inside a conhost that holds directories open.
    for (const worker of workers) await stopWorker(hub, worker, keep);
    // Agents' own MCP sockets, which nothing else owns. Left open they are
    // one more client `app.close()` waits on below.
    for (const client of clients) await client.close().catch(() => {});
    try {
      hub?.shutdown();
    } catch (err) {
      console.warn(`[live] canvas shutdown: ${(err as Error).message}`);
    }
    // Deadlined, not waited out - the same bound `cli.ts` puts on its own
    // shutdown and for the same reason: close() waits for every websocket to
    // finish its close handshake, and a peer that has already been killed
    // never answers. By this point there is nothing left to lose but a
    // goodbye.
    await Promise.race([
      app?.close().catch(() => {}) ?? Promise.resolve(),
      pause(SERVER_CLOSE_DEADLINE_MS),
    ]);
    if (keep) console.log(`[live] keeping ${home}, ${workspaceRoot} and ${configDir}`);
    else {
      await removeTree(workspaceRoot);
      await removeTree(home);
      // Holds a copy of the OAuth token; it does not outlive the run.
      await removeTree(configDir);
    }
    if (previousHome === undefined) delete process.env.TERMSCAPE_HOME;
    else process.env.TERMSCAPE_HOME = previousHome;
    canvases.delete(canvas);
    if (owner === canvas) owner = null;
  };

  const waitFor = (
    fn: () => boolean | Promise<boolean>,
    label: string,
    timeoutMs = LIVE_TIMEOUTS.turn,
  ): Promise<void> => pollUntil(fn, label, timeoutMs, () => workerOutputs(workers));

  const canvas: LiveCanvas = {
    // Assigned below, once serve() has answered. Declared here so `stop` can
    // be registered before the first long wait: a canvas that fails half way
    // through building still has to be stoppable by afterAll.
    get hub() {
      return hub!;
    },
    get app() {
      return app!;
    },
    origin: '',
    home,
    workspace: null as unknown as Workspace,
    workspaceRoot,
    workers,
    startAgent: () => {
      throw new Error('canvas is not up yet');
    },
    screenOf: () => {
      throw new Error('canvas is not up yet');
    },
    waitFor,
    waitForScreen: () => {
      throw new Error('canvas is not up yet');
    },
    stop,
  };
  canvases.add(canvas);
  owner = canvas;

  try {
    hub = new Hub({ dbPath: join(home, 'state.db'), spawnCap: opts.spawnCap });
    const served = await serve({
      hub,
      port: 0,
      clientToken: `live-${randomBytes(8).toString('hex')}`,
      headless: true,
    });
    app = served.app;

    const live = hub;
    const mutable = canvas as {
      origin: string;
      workspace: Workspace;
      startAgent: LiveCanvas['startAgent'];
      screenOf: LiveCanvas['screenOf'];
      waitForScreen: LiveCanvas['waitForScreen'];
    };
    mutable.origin = served.origin;
    mutable.workspace = live.createWorkspace('canvasws', workspaceRoot);

    const screenOf = async (address: string, lines = 60): Promise<string> => {
      const found = live.peers.find(address);
      if (found) {
        const answer = (await live.peers.readScreen(address, lines)) as { screen?: string };
        return answer.screen ?? '';
      }
      const session = live.sessions.getByAddress(address);
      const pty = session ? live.sessions.pty(session.id) : null;
      return pty?.tailLines(lines) ?? '';
    };
    mutable.screenOf = screenOf;

    const waitForScreen = async (
      target: LiveAgent | string,
      needle: string | RegExp,
      o: { timeoutMs?: number; label?: string } = {},
    ): Promise<string> => {
      const address = typeof target === 'string' ? target : target.address;
      const match = (s: string) => (typeof needle === 'string' ? s.includes(needle) : needle.test(s));
      let last = '';
      await pollUntil(
        async () => {
          last = await screenOf(address);
          return match(last);
        },
        o.label ?? `${needle} on ${address}`,
        o.timeoutMs ?? LIVE_TIMEOUTS.turn,
        () => [`--- ${address}, last screen ---\n${last}`, ...workerOutputs(workers)],
      );
      return last;
    };
    mutable.waitForScreen = waitForScreen;

    const makeAgent = (session: Session, worker: LiveWorker | null): LiveAgent => {
      let client: McpAgent | null = null;
      return {
        sessionId: session.id,
        address: session.address,
        worker,
        screen: (lines) => screenOf(session.address, lines),
        async type(data) {
          const found = live.peers.find(session.address);
          if (!found) return void live.sessions.write(session.id, data);
          await found.peer.request({
            t: 'input',
            id: randomUUID(),
            address: session.address,
            data,
          });
        },
        async mcp() {
          if (client) return client;
          const token = worker
            ? await workerAgentToken(worker.home, session.address)
            : live.tokens.get(session.id);
          if (!token) throw new Error(`no MCP token for ${session.address}`);
          client = await mcpClient(worker ? workerOrigin(worker) : served.origin, token);
          clients.push(client);
          return client;
        },
      };
    };

    /**
     * Answer the one question an agent CLI asks before it will take a prompt.
     *
     * A fresh temp folder is a folder Claude Code has never been trusted in,
     * and the hub waits out such a screen indefinitely on purpose - the human
     * is expected to answer it. Here there is no human, so the harness plays
     * one.
     *
     * It plays one properly rather than pressing Enter, and that distinction
     * cost a test run to learn: the dialog's default option is "No, exit", so
     * a bare Enter answers "no" and kills the agent. So the cursor is found
     * among the options, moved onto the affirmative one, and only then
     * confirmed.
     *
     * Deliberately not `--dangerously-skip-permissions`, which would make the
     * dialog disappear. That flag changes how the agent behaves for the whole
     * session, which is a bigger change than the thing under test; answering
     * the question grants nothing beyond the empty temp folder the harness
     * created a moment ago. A caller who wants the flag can pass it through
     * `claudeArgs`.
     */
    const optionsOn = async (agent: LiveAgent): Promise<string[]> =>
      (await agent.screen(40)).split('\n').filter((l) => TRUST_OPTION.test(l));
    /** Which option the list is highlighting, or -1 before it has drawn one. */
    const cursorIn = (options: string[]): number =>
      options.findIndex((l) => l.includes(SELECT_CURSOR));

    const answerIfAsking = async (agent: LiveAgent): Promise<boolean> => {
      let options = await optionsOn(agent);
      const target = options.findIndex((l) => TRUST_ACCEPT.test(l));
      if (target < 0) return false;

      try {
        // Which sequence moves the list is the terminal's business, not ours:
        // a TUI that has asked for application cursor keys wants ESC O B and
        // ignores ESC [ B entirely. So try each and keep whichever moves it.
        for (const keys of MOVE_KEYS) {
          if (cursorIn(options) === target) break;
          const from = Math.max(0, cursorIn(options));
          const down = target > from;
          for (let i = 0; i < Math.abs(target - from); i++) {
            await agent.type(down ? keys.down : keys.up);
            await pause(KEY_GAP_MS);
          }
          options = await optionsOn(agent);
        }

        // Confirm only what can be seen to be selected. This dialog's default
        // option is "No, exit", so an Enter sent hopefully does not fail
        // harmlessly - it answers no and the agent shuts down. Returning false
        // here instead leaves the dialog up for the next attempt, and
        // eventually puts the screen in the failure message.
        if (cursorIn(options) !== target) {
          if (echo) console.log(`[live] trust dialog on ${agent.address} would not move`);
          return false;
        }
        await agent.type('\r');
      } catch (err) {
        // It exited from under us; the screen goes in the failure message.
        if (echo) console.log(`[live] trust keys failed: ${(err as Error).message}`);
        return false;
      }
      return true;
    };

    const readyCheck = async (agent: LiveAgent, marker: string, timeoutMs: number) => {
      let last = '';
      let answeredAt = 0;
      await pollUntil(
        async () => {
          last = await agent.screen(60);
          if (last.includes(marker)) return true;
          // Retried for as long as the dialog is up, rather than a few times
          // and then never again. A CLI draws that screen before it is reading
          // stdin, so the first answers can go into a program that is not
          // listening yet - and a cap spent inside that window looks exactly
          // like a dialog that cannot be answered at all.
          if (Date.now() - answeredAt >= TRUST_RETRY_MS && (await answerIfAsking(agent))) {
            answeredAt = Date.now();
          }
          return false;
        },
        `${agent.address} to answer its readiness ping`,
        timeoutMs,
        () => [`--- ${agent.address}, last screen ---\n${last}`, ...workerOutputs(workers)],
      );
    };

    /**
     * Start an agent and wait for it to prove it is listening.
     *
     * The readiness ping is the whole opening instruction, never merged with a
     * caller's own first prompt: a test about what happens to a first prompt
     * cannot have the harness spend it.
     */
    const startOn = async (
      workspaceId: string,
      worker: LiveWorker | null,
      o: StartAgentOptions,
    ): Promise<LiveAgent> => {
      const ping = joinMarker('READY');
      const session = await live.startSession({
        workspaceId,
        profile: o.profile ?? 'claude',
        name: o.name,
        prompt: ping.prompt,
      });
      const agent = makeAgent(session, worker);
      if (o.expectReady !== false) {
        await readyCheck(agent, ping.needle, o.readyTimeoutMs ?? LIVE_TIMEOUTS.agentBoot);
      }
      return agent;
    };

    mutable.startAgent = (o = {}) => startOn(canvas.workspace.id, null, o);

    for (let i = 0; i < (opts.workers ?? 1); i++) {
      workers.push(
        await startWorker({
          canvas: live,
          origin: served.origin,
          mintJoinToken: () => served.enrollment.mint(),
          index: i,
          opts,
          configDir,
          echo,
          keep,
          startOn,
        }),
      );
    }

    return canvas;
  } catch (err) {
    await stop();
    throw err;
  }
}

/* ----------------------------------------------------------------- worker */

interface WorkerSetup {
  canvas: Hub;
  origin: string;
  mintJoinToken: () => string;
  index: number;
  opts: LiveCanvasOptions;
  /** Shared with the canvas: one throwaway Claude Code config per run. */
  configDir: string;
  echo: boolean;
  keep: boolean;
  startOn: (
    workspaceId: string,
    worker: LiveWorker | null,
    o: StartAgentOptions,
  ) => Promise<LiveAgent>;
}

/** Bookkeeping the harness keeps about a worker that its public face hides. */
interface WorkerInternals {
  child: ChildProcess;
  port: number;
}

const internals = new WeakMap<LiveWorker, WorkerInternals>();

function workerOrigin(worker: LiveWorker): string {
  const port = internals.get(worker)?.port;
  if (!port) throw new Error(`worker ${worker.label} has no port`);
  return `http://127.0.0.1:${port}`;
}

async function startWorker(setup: WorkerSetup): Promise<LiveWorker> {
  const { canvas, origin, index, opts, configDir, echo, keep } = setup;
  const label = `${WORKER_TAG}-${index + 1}-${randomBytes(3).toString('hex')}`;
  const home = mkdtempSync(join(tmpdir(), `${WORKER_TAG}-`));
  const workspaceRoot = mkdtempSync(join(tmpdir(), `${WORKER_TAG}-ws-`));
  writeProfileFixture(home, opts, configDir);
  // Before this worker's hub exists, let alone an agent in that folder.
  grantTrust(configDir, workspaceRoot);

  const joinToken = setup.mintJoinToken();
  // tsx rather than dist/cli.js, and deliberately: the point of this harness is
  // catching bugs in current source, and a built artifact silently tests
  // whatever was compiled last - the worst possible failure mode for a
  // debugging tool. The transform costs a fraction of an agent's boot.
  const loader = import.meta.resolve('tsx');
  const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

  const child = spawn(
    process.execPath,
    [
      '--import',
      loader,
      cli,
      '--headless',
      // Every value-bearing flag takes the `=` form, and that is not style:
      // a base64url token can begin with `-`, which strict parseArgs reads as
      // the next option. See cli-args.ts.
      '--port=0',
      `--join=${origin}`,
      `--join-token=${joinToken}`,
      `--label=${label}`,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, TERMSCAPE_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A process group of its own, so teardown can kill the group. On Windows
      // `detached` would allocate a console instead, and `taskkill /T` walks
      // the tree there anyway.
      detached: process.platform !== 'win32',
    },
  );
  children.add(child);

  let output = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const absorb = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (echo) process.stdout.write(`[${label}] ${text}`);
    output = (output + text).slice(-OUTPUT_CAP);
  };
  // Drained continuously, not read at the end: a pipe nobody reads fills at
  // 8-64KB and blocks the child mid-write.
  child.stdout?.on('data', absorb);
  child.stderr?.on('data', absorb);
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const worker: LiveWorker = {
    label,
    hostId: '',
    home,
    workspaceRoot,
    workspace: null as unknown as Workspace,
    get pid() {
      return child.pid;
    },
    output: () => output,
    startAgent: () => {
      throw new Error(`worker ${label} is not joined yet`);
    },
  };
  internals.set(worker, { child, port: 0 });

  const context = () => [`--- ${label} ---\n${output}`];
  const spawnFailure = (): string | null => {
    if (exited) return `the worker hub exited (code ${exited.code}, signal ${exited.signal})`;
    const refused = /^TERMSCAPE_JOIN_FAILED=(.*)$/m.exec(output);
    return refused ? `the canvas refused the join: ${refused[1]}` : null;
  };

  try {
    // Its own port first: "listening" is not "joined", and the two markers
    // exist precisely so the difference is visible.
    await pollUntil(
      () => /^TERMSCAPE_PORT=\d+$/m.test(output),
      `worker ${label} to start listening`,
      LIVE_TIMEOUTS.hubSpawn,
      context,
      spawnFailure,
    );
    internals.set(worker, {
      child,
      port: Number(/^TERMSCAPE_PORT=(\d+)$/m.exec(output)![1]),
    });

    await pollUntil(
      () => output.includes('TERMSCAPE_JOINED='),
      `worker ${label} to join the canvas`,
      LIVE_TIMEOUTS.join,
      context,
      spawnFailure,
    );

    // And the canvas's own view of it, which is what every feature under test
    // consults - waiting only for the child's own word leaves a race where a
    // spawn lands before the host is adopted.
    await pollUntil(
      () => canvas.store.listHosts().some((h) => h.label === label && h.state === 'connected'),
      `the canvas to see ${label} connected`,
      LIVE_TIMEOUTS.hostConnected,
      context,
      spawnFailure,
    );

    const host = canvas.store.listHosts().find((h) => h.label === label)!;
    const mutable = worker as { hostId: string; workspace: Workspace; startAgent: LiveWorker['startAgent'] };
    mutable.hostId = host.id;
    // A remote root is stored verbatim and checked on the far side, so it has
    // to be a folder that really exists there. Here "there" is this machine.
    mutable.workspace = canvas.createWorkspace(`${WORKER_TAG}ws`, workspaceRoot, host.id);
    mutable.startAgent = (o = {}) => setup.startOn(worker.workspace.id, worker, o);

    return worker;
  } catch (err) {
    await stopWorker(canvas, worker, keep);
    throw err;
  }
}

/**
 * Stop a worker hub: ask, then insist.
 *
 * Asking is the peer protocol's `shutdown`, which makes the child run its own
 * shutdown - snapshots written, PTYs disposed, the database closed. That is the
 * only graceful stop available on Windows. `peers.requestShutdown` rather than
 * `hub.removeHost`, which would also delete the host row a test may still want
 * to assert on.
 *
 * Never throws. This runs in teardown, after the assertions that matter have
 * already passed or failed, and a Windows process that will not die is not a
 * hub bug.
 */
async function stopWorker(canvas: Hub | null, worker: LiveWorker, keep: boolean): Promise<void> {
  const inner = internals.get(worker);
  const child = inner?.child;
  if (child) {
    try {
      if (worker.hostId && canvas) await canvas.peers.requestShutdown(worker.hostId);
    } catch {
      // Already gone, which is the outcome we wanted.
    }
    if (child.exitCode === null && !(await exitedWithin(child, LIVE_TIMEOUTS.gracefulExit))) {
      forceKill(child);
      if (!(await exitedWithin(child, LIVE_TIMEOUTS.forcedExit))) {
        console.warn(`[live] worker ${worker.label} (pid ${child.pid}) would not die`);
      }
    }
    children.delete(child);
  }
  if (keep) {
    console.log(`[live] keeping ${worker.home} and ${worker.workspaceRoot}`);
    return;
  }
  // Only now: while the child lives it holds its database, its run directory,
  // and a console whose working directory is inside the workspace folder.
  await removeTree(worker.workspaceRoot);
  await removeTree(worker.home);
}

function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<boolean>((res) => setTimeout(() => res(false), ms).unref()),
  ]);
}

/**
 * Kill a child hub and everything under it.
 *
 * The tree matters more than the process: a force-killed hub leaves its agent
 * CLIs, and on Windows the conhost they run in, alive and holding directories
 * open. Synchronous, so it can also be used from an exit handler.
 */
function forceKill(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // It is already gone, or it was never ours to kill.
    }
  }
}

/* ------------------------------------------------------------------ pieces */

/**
 * A private Claude Code configuration for the run, and why there is one.
 *
 * Left to itself, an agent started in a fresh temp folder opens by asking
 * whether the folder is trusted, and the hub waits out that screen for as long
 * as it is up - correctly, because a human is meant to answer it. A harness has
 * no human, and answering the dialog by typing at it proved unreliable: the
 * arrow keys a select list responds to are not knowable from outside the
 * program, and a wrongly-confirmed dialog answers "No, exit" and kills the
 * agent.
 *
 * The answer is to grant the trust up front instead, which is a line in
 * Claude Code's own config. That config is the user's, so it is copied rather
 * than edited: `CLAUDE_CONFIG_DIR` points the agents at a throwaway copy, the
 * trust entries go in the copy, and the real `~/.claude.json` is never written
 * by a test. The OAuth token has to come along or every agent starts at a
 * login prompt - it lives beside the state directory, not inside the config
 * file - so it is copied too, 0600, into a directory teardown removes.
 */
function seedClaudeConfig(configDir: string): void {
  const source = join(homedir(), '.claude.json');
  const target = join(configDir, '.claude.json');
  writeFileSync(target, existsSync(source) ? readFileSync(source, 'utf8') : '{}', {
    mode: 0o600,
  });
  const credentials = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credentials)) {
    writeFileSync(join(configDir, '.credentials.json'), readFileSync(credentials), {
      mode: 0o600,
    });
  }
}

/**
 * Mark a folder trusted in the throwaway config.
 *
 * The key is the path with forward slashes, which is the shape Claude Code
 * writes for itself; an entry under any other spelling is simply not found and
 * the dialog appears anyway.
 */
function grantTrust(configDir: string, folder: string): void {
  const file = join(configDir, '.claude.json');
  const config = JSON.parse(readFileSync(file, 'utf8')) as {
    projects?: Record<string, Record<string, unknown>>;
  };
  config.projects ??= {};
  const key = folder.replace(/\\/g, '/');
  config.projects[key] = { ...(config.projects[key] ?? {}), hasTrustDialogAccepted: true };
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * The profile overlay both hubs load.
 *
 * Derived from the built-ins rather than copied: `ProfileRegistry.load`
 * *replaces* `args`, so a hand-written list here would silently rot the day
 * the real profile gains a flag.
 */
function writeProfileFixture(home: string, opts: LiveCanvasOptions, configDir: string): void {
  const claude = BUILTIN_PROFILES.claude!;
  const extra = opts.claudeArgs ?? [];
  const lines = [
    '# Written by the live test harness. Not a user config.',
    '[claude]',
    `args = ${JSON.stringify([...claude.args, ...extra])}`,
    `resume_args = ${JSON.stringify([...(claude.resumeArgs ?? []), ...extra])}`,
    `env = { CLAUDE_CONFIG_DIR = ${JSON.stringify(configDir)} }`,
  ];
  if (opts.isolateProfiles ?? true) {
    // Every hub probes each declared CLI for its version and models at boot.
    // Pointing the ones this suite does not use at nothing means `which`
    // returns null and no probe is spawned at all.
    for (const id of Object.keys(BUILTIN_PROFILES)) {
      if (id === 'claude') continue;
      lines.push('', `[${id}]`, 'command = "termscape-live-absent"');
    }
  }
  writeFileSync(join(home, 'agents.toml'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** An MCP client speaking as one agent, exactly as messaging.test.ts does. */
async function mcpClient(origin: string, token: string): Promise<McpAgent> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'termscape-live-harness', version: '0.0.0' });
  await client.connect(transport);
  return {
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        content?: { text?: string }[];
      };
      const text = res.content?.[0]?.text;
      if (typeof text !== 'string') throw new Error(`${tool} returned no text content`);
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as T;
      }
    },
    close: () => client.close(),
  };
}

/**
 * A worker-side agent's bearer token.
 *
 * Per-agent tokens live in memory on the hub that minted them, so the canvas
 * cannot hand one over. What it can do is read the config that hub wrote for
 * the agent - the same file the CLI itself reads.
 *
 * Found by address rather than by id, and that is not a detail: a session that
 * crosses the peer link is re-keyed to its address on this side
 * (`localizeRemoteSession`), so the id the canvas holds for a remote agent is
 * its address and names no directory at all. The brief in each run directory
 * says whose it is, so that is what is matched.
 */
async function workerAgentToken(home: string, address: string): Promise<string | null> {
  const run = join(home, 'run');
  let dirs: string[];
  try {
    dirs = await readdir(run);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    try {
      const brief = await readFile(join(run, dir, 'brief.md'), 'utf8');
      if (!brief.includes(address)) continue;
      const parsed = JSON.parse(await readFile(join(run, dir, 'mcp.json'), 'utf8')) as {
        mcpServers?: { termscape?: { headers?: Record<string, string> } };
      };
      const header = parsed.mcpServers?.termscape?.headers?.Authorization ?? '';
      return header.replace(/^Bearer\s+/i, '') || null;
    } catch {
      // Not this one, or half-written. Keep looking.
    }
  }
  return null;
}

function workerOutputs(workers: LiveWorker[]): string[] {
  return workers.map((w) => `--- ${w.label} ---\n${w.output()}`);
}

/**
 * Poll until something holds, and fail with everything worth knowing.
 *
 * The context blocks are the difference between a debuggable failure and a
 * bare timeout: a worker's log says the join was refused, and an agent's
 * screen says the CLI is sitting on a login prompt.
 */
async function pollUntil(
  fn: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
  context: () => string[] = () => [],
  abort: () => string | null = () => null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    const reason = abort();
    if (reason) throw new Error(describeFailure(`${label}: ${reason}`, context()));
    if (Date.now() >= deadline) {
      throw new Error(describeFailure(`timed out after ${timeoutMs}ms waiting for ${label}`, context()));
    }
    await new Promise((res) => setTimeout(res, POLL_MS).unref());
  }
}

function describeFailure(message: string, blocks: string[]): string {
  return [message, ...blocks].join('\n');
}

function pause(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms).unref());
}
