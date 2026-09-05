import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { hostname, platform, arch, homedir } from 'node:os';
import { dirname } from 'node:path';
import { WebSocket } from 'ws';
import { PEER_SCHEMA_VERSION, PeerResponse, type PeerRequest } from '@aicanvas/protocol';
import type { Hub } from '../hub.js';
import { HUB_VERSION } from '../hub.js';
import { paths } from '../paths.js';
import type { PeerServer } from './peer-serve.js';

/**
 * The joining machine's side of enrollment.
 *
 * It dials the canvas hub and then answers its requests — the same role a hub
 * deployed over SSH plays on its `/peer` endpoint, just over a socket opened
 * from this end. That is why this file is thin: `peer-serve.ts` does the work,
 * and all that is left here is getting a socket to hand it and keeping one.
 *
 * The enrollment token is spent once. What comes back in `welcome` is a
 * durable host token written to disk, so every later start — a reboot, a
 * crash, a dropped link — rejoins silently with no second trip to the
 * download page.
 *
 * The two AICANVAS_JOIN* markers below exist for the installer to grep. A hub
 * that has started is not a hub that has joined, and reporting success on the
 * former is how you end up telling someone they are connected when the canvas
 * refused them.
 */

const MAX_BACKOFF_MS = 15_000;

export interface JoinOptions {
  hub: Hub;
  peerServer: PeerServer;
  /** The canvas hub's origin, e.g. http://192.168.1.40:7333 */
  hubUrl: string;
  /** Single-use enrollment token; ignored once we hold a durable host token. */
  joinToken?: string;
  label?: string;
  /** Where to keep the durable host token. Defaults to the hub home. */
  tokenFile?: string;
  log?: (line: string) => void;
}

export interface JoinLink {
  stop(): void;
}

function readHostToken(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function writeHostToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
}

/** Drop a credential the canvas has told us it does not recognise. */
function clearHostToken(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // Nothing here depends on it being gone; the retry ignores it anyway.
  }
}

/** http://host:port -> ws://host:port/peer-in */
function peerInUrl(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/peer-in';
  u.search = '';
  return u.toString();
}

export function joinCanvas(opts: JoinOptions): JoinLink {
  const log = opts.log ?? ((line: string) => console.log(`[join] ${line}`));
  /**
   * A refusal we cannot retry our way out of. The hub was started only to
   * join, so there is nothing left for it to do; whoever owns the process
   * listens for this and stops, which also frees the install for a re-run.
   */
  const fatal = (message: string): void => {
    stopped = true;
    log(`AICANVAS_JOIN_FAILED=${message}`);
    opts.hub.emit('joinFailed', message);
  };
  const tokenFile = opts.tokenFile ?? paths.hostTokenFile();
  const url = peerInUrl(opts.hubUrl);
  let backoff = 500;
  let stopped = false;
  let socket: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;
  /**
   * Whether the stored host token has already been tried and rejected. Once
   * it has, the enrollment key the installer supplied is the only thing left
   * worth trying, and it is tried exactly once.
   */
  let hostTokenSpent = false;

  function dial(): void {
    if (stopped) return;

    const hostToken = hostTokenSpent ? null : readHostToken(tokenFile);
    if (!hostToken && !opts.joinToken) {
      fatal('no enrollment token and no stored host token; nothing to join with');
      return;
    }

    const ws = new WebSocket(url);
    socket = ws;
    const usedHostToken = hostToken !== null;
    // Set once the canvas hub accepts us, so a rejection is not retried
    // forever as if it were a network blip.
    let welcomed = false;

    ws.on('open', () => {
      const hello: PeerRequest = {
        t: 'hello',
        token: hostToken ?? opts.joinToken!,
        hubVersion: HUB_VERSION,
        schemaVersion: PEER_SCHEMA_VERSION,
        // Only on first contact: after that the host token identifies us and
        // the canvas hub already has a row describing this machine.
        ...(hostToken
          ? {}
          : {
              enroll: {
                label: opts.label || hostname(),
                platform: platform(),
                arch: arch(),
                homeDir: homedir(),
              },
            }),
      };
      ws.send(JSON.stringify(hello));
    });

    const onHandshake = (raw: Buffer): void => {
      if (welcomed) return;
      let parsed;
      try {
        parsed = PeerResponse.safeParse(JSON.parse(raw.toString('utf8')));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const msg = parsed.data;

      if (msg.t === 'err') {
        // A stored host token that the canvas no longer knows means this
        // machine was removed from it — the common case being someone
        // dropping the host and then re-running the join command. The fresh
        // key they were just handed is exactly the answer, so use it rather
        // than failing while holding an unused one.
        if (usedHostToken && opts.joinToken && !hostTokenSpent) {
          hostTokenSpent = true;
          clearHostToken(tokenFile);
          log('this canvas no longer knows this machine; enrolling again');
          ws.close(); // The close handler redials, now without a host token.
          return;
        }
        // Otherwise a bad token or a version gap, which retrying will not fix.
        fatal(msg.message);
        ws.close();
        return;
      }
      if (msg.t !== 'welcome') return;

      if (msg.schemaVersion !== PEER_SCHEMA_VERSION) {
        fatal(
          `schema mismatch: the canvas hub ${msg.hubVersion} speaks v${msg.schemaVersion}, ` +
            `this hub speaks v${PEER_SCHEMA_VERSION}. Update whichever is older.`,
        );
        ws.close();
        return;
      }

      if (msg.hostToken) {
        writeHostToken(tokenFile, msg.hostToken);
        log('enrolled; this machine will rejoin on its own from now on');
      }

      welcomed = true;
      backoff = 500;
      ws.off('message', onHandshake);
      // Hand the socket to the same code that serves an accepted /peer link.
      // The canvas hub drives from here; we answer.
      opts.peerServer.serve(ws, { preAuthed: true });
      // Machine-readable: the installer waits for this, not for the port.
      log(`AICANVAS_JOINED=1 joined ${opts.hubUrl}`);
    };

    ws.on('message', onHandshake);

    ws.on('error', (err: Error) => {
      if (!welcomed) log(`cannot reach ${opts.hubUrl}: ${err.message}`);
    });

    ws.on('close', () => {
      socket = null;
      if (stopped) return;
      if (welcomed) log('link dropped; reconnecting');
      timer = setTimeout(dial, backoff);
      timer.unref?.();
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
  }

  dial();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}
