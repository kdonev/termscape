import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  PeerRequest,
  PEER_SCHEMA_VERSION,
  type PeerAgent,
  type PeerRelayAsk,
  type AgentProfileInfo,
  type PeerResponse,
  type Session,
  describeInput,
  describeLatin1,
  describeModeChanges,
  describeSnapshotModes,
} from '@termscape/protocol';
import type { WebSocket } from 'ws';
import type { Hub } from '../hub.js';
import { HUB_VERSION } from '../hub.js';
import { debug, debugOn } from '../debug.js';
import { checkFolder } from '../folders.js';

/**
 * The answering half of the hub-to-hub link: it serves requests about *this*
 * hub's sessions and pushes its state changes.
 *
 * It is deliberately independent of who opened the socket. An SSH-deployed hub
 * accepts a socket on `/peer` and runs this over it; a hub that ran the join
 * installer dials out and runs the very same thing over the socket it opened.
 * That split is the whole reason enrollment can invert the direction of the
 * connection without the canvas-owning hub noticing.
 *
 * It is also this hub's *uplink*: the one link back to the canvas it was
 * attached to. Answering is most of what it does, but not all — it holds the
 * directory the canvas sends of who else is out there, and it can ask the
 * canvas to deliver a message to any of them. Without those an agent here can
 * neither see nor reach anything beyond this machine.
 */

/** How long a relayed ask waits for the canvas to report what happened. */
const RELAY_TIMEOUT_MS = 15_000;
/**
 * A relayed spawn waits for a real PTY to start, possibly on a third machine
 * the canvas still has to reach — longer than any other ask gets. No deadlock
 * from holding it open that long: when the canvas turns this into a
 * `startSession` frame down the same socket, this hub's own message handler
 * serves that independently of the relay awaiting its result.
 */
export const SPAWN_RELAY_TIMEOUT_MS = 60_000;

/**
 * The link back to the canvas, as the rest of this hub needs it. Separated
 * from the serving machinery because a hub that owns a canvas has no uplink at
 * all, and the difference should be a null check rather than a special case.
 */
export interface Uplink {
  /** True while a canvas is attached to this hub. */
  readonly attached: boolean;
  /** Agents the canvas has told us about. Never this hub's own. */
  agents(): PeerAgent[];
  /**
   * What the canvas calls this machine, or null before its first `directory`
   * has arrived. This hub holds no row for itself — only the canvas does —
   * so this is the only way it can answer `host: 'local'`/`'self'` about its
   * own agents, or recognise a spawn_agent `host` naming itself.
   */
  hostLabel(): string | null;
  /** Ask the canvas to act on something we cannot resolve ourselves. */
  ask<T>(ask: PeerRelayAsk, opts?: { timeoutMs?: number }): Promise<T>;
}

export interface PeerServer extends Uplink {
  /** Wire one accepted or dialled socket into this hub. */
  serve(socket: WebSocket, opts?: { preAuthed?: boolean }): void;
  /** Number of peers currently attached. */
  readonly size: number;
  closeAll(): void;
}

export function createPeerServer(hub: Hub, clientToken: string): PeerServer {
  const sockets = new Set<WebSocket>();
  /** Which addresses each peer asked to stream output for. */
  const attached = new Map<WebSocket, Set<string>>();
  /**
   * Who else is on the canvas, as the canvas last described it. Replaced
   * wholesale on every `directory`, so an agent that went away over there
   * cannot linger here.
   */
  let directory: PeerAgent[] = [];
  /** What the canvas calls this machine, from the same `directory` frame. */
  let youAre: string | null = null;
  /** Asks sent to the canvas and still waiting for their answer. */
  const relays = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  const send = (ws: WebSocket, msg: PeerResponse): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  hub.on('session', (s: Session) => {
    for (const ws of sockets) send(ws, { t: 'sessionUpserted', session: s });
  });
  // Detection over here finishing. Unsolicited, because it completes after
  // the link is already up and nobody on the canvas knows to ask again.
  hub.on('agents', (agents: AgentProfileInfo[]) => {
    for (const ws of sockets) send(ws, { t: 'agents', agents });
  });
  hub.on('removed', (_id: string, address: string | null) => {
    // Peers address sessions by name, not by this hub's internal id, which is
    // why the address travels with the event rather than being looked up
    // after the row is already gone.
    if (!address) return;
    for (const ws of sockets) send(ws, { t: 'sessionRemoved', address });
  });
  hub.on('data', (sessionId: string, chunk: string) => {
    if (sockets.size === 0) return;
    const s = hub.sessions.get(sessionId);
    if (!s) return;
    // Logged before the attachment check, deliberately: a program that turned
    // mouse tracking on while no canvas was watching still turned it on, and
    // a trace that only shows what was forwarded cannot tell that from a
    // program that never asked.
    if (debugOn('output')) {
      const modes = describeModeChanges(chunk);
      if (modes) debug('output', `${s.address} program set ${modes}`);
    }
    for (const ws of sockets) {
      if (attached.get(ws)?.has(s.address)) {
        send(ws, { t: 'output', address: s.address, data: chunk });
      }
    }
  });

  function serve(socket: WebSocket, opts: { preAuthed?: boolean } = {}): void {
    // A dialled-out link authenticated itself in its own hello, so there is no
    // second token to check here; an accepted one must present ours first.
    let authed = opts.preAuthed ?? false;
    if (authed) {
      sockets.add(socket);
      attached.set(socket, new Set());
    }

    socket.on('message', async (raw: Buffer) => {
      let parsed;
      try {
        parsed = PeerRequest.safeParse(JSON.parse(raw.toString('utf8')));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const req = parsed.data;

      if (!authed) {
        if (req.t !== 'hello' || req.token !== clientToken) {
          socket.close();
          return;
        }
        authed = true;
        sockets.add(socket);
        attached.set(socket, new Set());
        send(socket, {
          t: 'welcome',
          hubVersion: HUB_VERSION,
          schemaVersion: PEER_SCHEMA_VERSION,
        });
        return;
      }
      if (req.t === 'hello') return;

      const ok = (result: unknown) => send(socket, { t: 'ok', id: req.id, result });
      const err = (message: string) => send(socket, { t: 'err', id: req.id, message });

      try {
        switch (req.t) {
          case 'listSessions':
            return ok(hub.sessions.list());

          case 'listAgents':
            // Answered from what is already known rather than probing now:
            // the canvas asks on connect, and a CLI that hangs on --version
            // must not hold the link open behind it. A refresh over here
            // arrives later as an unsolicited `agents`.
            void hub.agents.refresh();
            return ok(hub.agents.snapshot());

          case 'directory':
            // Replaced wholesale: this is the canvas's whole view, minus our
            // own agents, and a merge would keep agents it has dropped.
            directory = req.agents;
            if (req.youAre !== undefined) youAre = req.youAre;
            return ok({ agents: req.agents.length });

          case 'relayResult': {
            const p = relays.get(req.relayId);
            if (!p) return ok({ unknown: req.relayId });
            relays.delete(req.relayId);
            clearTimeout(p.timer);
            if (req.ok) p.resolve(req.result);
            else p.reject(new Error(req.error ?? 'the canvas could not do that'));
            return ok({ ok: true });
          }

          case 'deliver': {
            // The originating hub already authenticated the sender, so its
            // reported `from` is trusted. Attribution is still applied here,
            // so the receiving agent sees the true origin address.
            const r = hub.router.send(req.from, req.to, req.body);
            return r.delivered ? ok({ delivered: true }) : err(r.error ?? 'delivery failed');
          }

          case 'readScreen': {
            const target = hub.sessions.getByAddress(req.address);
            if (!target) return err(`no agent at address "${req.address}"`);
            const pty = hub.sessions.pty(target.id);
            return ok({
              address: req.address,
              running: pty?.running ?? false,
              screen: pty ? pty.tailLines(req.lines ?? 40) : '(not running)',
            });
          }

          case 'startSession': {
            let ws = hub.store.getWorkspaceByName(req.workspaceName);
            if (!ws) {
              // Resolved against this machine's home, never its cwd — which
              // the join installer leaves at the hub's own install directory
              // (join-script.ts), not anywhere a person would mean by a
              // relative workspace root. Doing it here, before
              // createWorkspace, means a bad root fails with the real reason
              // instead of being glued under the wrong base and reported as
              // one indecipherable path.
              const { path } = checkFolder(req.rootPath, { base: homedir() });
              ws = hub.createWorkspace(req.workspaceName, path, null);
            }
            // `profile` is an agent id here, not a template: the canvas
            // resolved the template on its own side precisely because the two
            // machines do not share config. The model and effort arrive as
            // values, and this hub's own profile says how to spell them.
            const s = await hub.startResolved({
              workspaceId: ws.id,
              // The canvas chose this id so it can recognise the child on
              // the wire — its first upsert crosses before the reply does.
              id: req.sessionId,
              agent: req.profile,
              template: req.template ?? null,
              model: req.model,
              effort: req.effort,
              prompt: req.prompt,
              env: req.env,
              name: req.name,
              // Deliberately no `spawnedBy` here even though the request
              // carries one: the spawner lives on the canvas hub, its id
              // would break this table's foreign key, and lineage is the
              // canvas's concern anyway — the registry stamps it there.
            });
            return ok(s);
          }

          case 'shutdown':
            // Answer first: the canvas hub is waiting, and a moment later
            // this process is gone. Whoever owns the process lifecycle
            // listens for this; nothing here calls process.exit, so an
            // in-process test hub is not taken down with it.
            ok({ stopping: true });
            setTimeout(() => hub.emit('peerShutdown'), 50);
            return;

          case 'stopSession': {
            const t = hub.sessions.getByAddress(req.address);
            if (!t) return err(`no agent at address "${req.address}"`);
            hub.sessions.stop(t.id);
            return ok({ stopped: req.address });
          }

          case 'removeSession': {
            const t = hub.sessions.getByAddress(req.address);
            // Already gone is the outcome that was asked for, not an error:
            // the canvas retries deferred removals and must not stall on one
            // that a previous attempt already applied.
            if (!t) return ok({ removed: req.address });
            hub.sessions.remove(t.id);
            return ok({ removed: req.address });
          }

          case 'resumeSession': {
            const t = hub.sessions.getByAddress(req.address);
            if (!t) return err(`no agent at address "${req.address}"`);
            return ok(await hub.resumeSession(t.id));
          }

          case 'attach': {
            attached.get(socket)?.add(req.address);
            const t = hub.sessions.getByAddress(req.address);
            if (t) {
              const snap = hub.sessions.snapshotForAttach(t.id);
              if (snap) {
                // What the canvas's window will be holding the moment it
                // opens. The serializer replays the tracking mode but not the
                // encoding one, so a snapshot can restore `?1003h` without
                // `?1006h` and leave the window sending X10 reports to a
                // program that had been getting SGR.
                debug(
                  'attach',
                  `attach ${req.address} ${snap.cols}x${snap.rows} ` +
                    `snapshot restores: ${describeSnapshotModes(snap.serialized)}`,
                );
                send(socket, { t: 'output', address: req.address, data: snap.serialized });
              } else {
                debug('attach', `attach ${req.address}, no snapshot`);
              }
            } else {
              debug('attach', `attach ${req.address} REFUSED: no such agent here`);
            }
            return ok({ attached: req.address });
          }

          case 'detach':
            attached.get(socket)?.delete(req.address);
            return ok({ detached: req.address });

          case 'input': {
            const t = hub.sessions.getByAddress(req.address);
            /*
             * The far end of a remote wheel, and the last place it can be
             * lost quietly.
             *
             * `req.id` is the id the canvas minted for this request, so this
             * line and the canvas's `hub -> peer` line are the same event
             * seen from both machines. If the canvas logged the send and this
             * never appears, the loss is on the link; if this appears with a
             * different byte count or a doubled coordinate, the loss is the
             * encoding.
             */
            if (debugOn('input')) {
              const what =
                req.encoding === 'binary'
                  ? describeLatin1(req.data)
                  : describeInput(Buffer.from(req.data, 'utf8'));
              debug(
                'input',
                `peer -> pty ${req.id} ${req.address} ` +
                  `encoding=${req.encoding ?? 'utf8(default)'} ` +
                  `${t ? `session=${t.id}` : 'NO SUCH AGENT'}: ${what}`,
              );
            }
            if (!t) return err(`no agent at address "${req.address}"`);
            // `binary` carries bytes one per code unit; anything else, including
            // an older canvas that sends no encoding at all, is text.
            if (req.encoding === 'binary') {
              hub.sessions.writeBytes(t.id, Buffer.from(req.data, 'latin1'));
            } else {
              hub.sessions.write(t.id, req.data);
            }
            return ok({ ok: true });
          }

          case 'resize': {
            const t = hub.sessions.getByAddress(req.address);
            debug(
              'attach',
              `resize ${req.address} -> ${req.cols}x${req.rows}` +
                (t ? '' : ' REFUSED: no such agent here'),
            );
            if (!t) return err(`no agent at address "${req.address}"`);
            hub.sessions.resize(t.id, req.cols, req.rows);
            return ok({ ok: true });
          }

          case 'checkFolder':
            // A throw here is already turned into `err` by the catch below,
            // which is what lets the Add/Edit-workspace dialog on the canvas
            // show the real reason — "does not exist", "not a folder", or the
            // wrong-platform message — instead of a guess made on a machine
            // that cannot see this one's filesystem. `homedir()`, never
            // `cwd()`: the same reasoning as `startSession` above.
            return ok(checkFolder(req.path, { base: homedir() }));
        }
      } catch (e) {
        err((e as Error).message);
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      attached.delete(socket);
      // Nothing left to answer a relay, and a caller waiting on one would
      // otherwise sit there until the timeout for no reason.
      if (sockets.size === 0) {
        directory = [];
        // Not `youAre`: a link drop is not the canvas renaming this machine,
        // and the next reconnect gets a fresh `directory` anyway.
        for (const [, p] of relays) {
          clearTimeout(p.timer);
          p.reject(new Error('the link to the canvas closed'));
        }
        relays.clear();
      }
    });
  }

  return {
    serve,
    get size() {
      return sockets.size;
    },
    get attached() {
      return sockets.size > 0;
    },
    agents(): PeerAgent[] {
      return sockets.size > 0 ? directory : [];
    },

    hostLabel(): string | null {
      return youAre;
    },

    /**
     * Hand something to the canvas to do. Only the canvas knows where every
     * address on it lives, so this is the only way an agent here reaches one
     * anywhere else — including on the machine the canvas itself runs on.
     */
    ask<T>(ask: PeerRelayAsk, opts: { timeoutMs?: number } = {}): Promise<T> {
      const socket = [...sockets].find((ws) => ws.readyState === ws.OPEN);
      if (!socket) return Promise.reject(new Error('not attached to a canvas'));

      const relayId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          relays.delete(relayId);
          reject(new Error('the canvas did not answer'));
        }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
        relays.set(relayId, { resolve: (v) => resolve(v as T), reject, timer });
        send(socket, { t: 'relay', relayId, ask });
      });
    },

    closeAll(): void {
      for (const ws of sockets) {
        try {
          ws.terminate();
        } catch {
          // Already gone.
        }
      }
      sockets.clear();
      attached.clear();
    },
  };
}
