import { spawn, type ChildProcess } from 'node:child_process';
import { EXIT_RESTART, takeRestartPlan, type RestartPlan } from './update/restart.js';
import { isInstalledPackage } from './update/install.js';

/**
 * The process a terminal actually holds, when the hub can update itself.
 *
 * An update replaces the hub, and the hub cannot restart itself: the new one
 * needs the old one's port, so the old one has to be gone first. Something
 * has to outlive it, and this is that thing. It does nothing but run the hub
 * as a child with the terminal passed straight through, and start whatever
 * the hub left in its restart plan when it exits with EXIT_RESTART - so the
 * terminal stays attached, logs keep printing, and Ctrl+C still stops it.
 *
 * It must stay this small. It never loads the hub, and so never loads a
 * native module: on Windows a loaded .node cannot be replaced, and a global
 * update has to replace exactly those files while this is still running.
 */

type Values = {
  headless?: boolean;
  join?: string;
  version?: boolean;
  help?: boolean;
};

/**
 * Only an installed copy of the published package is supervised: that is the
 * only kind that can update itself. A checkout, a joined machine (updated
 * from its canvas, by an installer that expects to find the hub in hub.pid)
 * and a headless hub all run exactly as before.
 */
export function shouldSupervise(
  values: Values,
  cliPath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.TERMSCAPE_SUPERVISED === '1' || env.TERMSCAPE_NO_SUPERVISOR === '1') return false;
  if (values.version || values.help || values.headless || values.join) return false;
  return isInstalledPackage(cliPath);
}

/** How long a hub that said it is exiting gets to actually be gone. */
const EXIT_GRACE_MS = 5_000;

/**
 * Stop a hub that is stuck on its way out, and anything it still holds. On
 * Windows only taskkill reaches the whole tree; its agents' terminals were
 * closed already, but a straggler would keep the new hub's files busy.
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  console.error('[termscape] the hub did not exit; stopping it');
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGKILL');
  }
}

/** Tell the supervisor, if there is one, that this hub is exiting and how. */
export function announceExit(code: number): Promise<void> {
  const send = process.send?.bind(process);
  if (!send || !process.connected) return Promise.resolve();
  return new Promise((resolve) => {
    // A supervisor that went away must not hold this exit up.
    const timer = setTimeout(resolve, 500);
    send({ t: 'exiting', code }, undefined, {}, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Run the hub, and every hub an update asks for after it, until one exits for good. */
export async function supervise(cliPath: string): Promise<never> {
  let child: ChildProcess | null = null;
  // Ctrl+C reaches every process on the terminal, the hub included, and the
  // hub is the one that decides what stopping means. This only waits for it.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (child) child.kill(sig);
      else process.exit(1);
    });
  }

  const code = await runHubs(
    { command: process.execPath, args: [...process.execArgv, cliPath, ...process.argv.slice(2)] },
    { onChild: (c) => (child = c) },
  );
  process.exit(code);
}

/**
 * The loop itself: start a hub, and when it exits asking to be restarted,
 * start what it left in its restart plan. Resolves with the exit code of the
 * first hub that exits for any other reason.
 */
export async function runHubs(
  first: RestartPlan,
  opts: { stdio?: Array<'ignore' | 'inherit' | 'pipe'>; onChild?: (child: ChildProcess | null) => void } = {},
): Promise<number> {
  // Anything left over from a restart that never happened is not ours to run.
  takeRestartPlan();

  const [stdin, stdout, stderr] =
    opts.stdio ?? ['inherit', 'inherit', 'inherit'];

  let plan = first;
  for (;;) {
    const started = spawn(plan.command, plan.args, {
      // The extra channel is how a hub says it is on its way out; see below.
      stdio: [stdin, stdout, stderr, 'ipc'],
      env: { ...process.env, ...plan.env, TERMSCAPE_SUPERVISED: '1' },
    });
    opts.onChild?.(started);
    const code = await new Promise<number>((resolve) => {
      /*
       * A hub announces its exit, and its code, before calling process.exit -
       * because on Windows that call has been seen to never return once an
       * agent's terminal had been open, leaving a process with its state
       * saved and its port closed that nothing would ever restart. Past the
       * grace period it is killed here, and its announced code stands.
       */
      let announced: number | null = null;
      let watchdog: NodeJS.Timeout | null = null;
      started.on('message', (msg: unknown) => {
        const m = msg as { t?: string; code?: unknown };
        if (m?.t !== 'exiting' || typeof m.code !== 'number' || watchdog) return;
        announced = m.code;
        watchdog = setTimeout(() => killTree(started), EXIT_GRACE_MS);
      });
      started.on('error', (err) => {
        console.error(`[termscape] could not start the hub: ${err.message}`);
        resolve(1);
      });
      started.on('exit', (c, signal) => {
        if (watchdog) clearTimeout(watchdog);
        resolve(announced ?? c ?? (signal ? 1 : 0));
      });
    });
    opts.onChild?.(null);

    if (code !== EXIT_RESTART) return code;
    const next = takeRestartPlan();
    if (!next) {
      console.error('[termscape] the hub asked to be restarted but left no plan; stopping');
      return 1;
    }
    console.log('\n[termscape] restarting\n');
    plan = next;
  }
}
