import {
  PeerRequest,
  PEER_SCHEMA_VERSION,
  type PeerResponse,
  type Session,
} from '@aicanvas/protocol';
import type { WebSocket } from 'ws';
import type { Hub } from '../hub.js';
import { HUB_VERSION } from '../hub.js';

/**
 * The answering half of the hub-to-hub link: it serves requests about *this*
 * hub's sessions and pushes its state changes.
 *
 * It is deliberately independent of who opened the socket. An SSH-deployed hub
 * accepts a socket on `/peer` and runs this over it; a hub that ran the join
 * installer dials out and runs the very same thing over the socket it opened.
 * That split is the whole reason enrollment can invert the direction of the
 * connection without the canvas-owning hub noticing.
 */

export interface PeerServer {
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

  const send = (ws: WebSocket, msg: PeerResponse): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  hub.on('session', (s: Session) => {
    for (const ws of sockets) send(ws, { t: 'sessionUpserted', session: s });
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
            if (!ws) ws = hub.createWorkspace(req.workspaceName, req.rootPath, null);
            const s = await hub.startSession({
              workspaceId: ws.id,
              profile: req.profile,
              name: req.name,
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

          case 'resumeSession': {
            const t = hub.sessions.getByAddress(req.address);
            if (!t) return err(`no agent at address "${req.address}"`);
            return ok(await hub.sessions.resume(t.id));
          }

          case 'attach': {
            attached.get(socket)?.add(req.address);
            const t = hub.sessions.getByAddress(req.address);
            if (t) {
              const snap = hub.sessions.snapshotForAttach(t.id);
              if (snap) send(socket, { t: 'output', address: req.address, data: snap.serialized });
            }
            return ok({ attached: req.address });
          }

          case 'detach':
            attached.get(socket)?.delete(req.address);
            return ok({ detached: req.address });

          case 'input': {
            const t = hub.sessions.getByAddress(req.address);
            if (!t) return err(`no agent at address "${req.address}"`);
            hub.sessions.write(t.id, req.data);
            return ok({ ok: true });
          }

          case 'resize': {
            const t = hub.sessions.getByAddress(req.address);
            if (!t) return err(`no agent at address "${req.address}"`);
            hub.sessions.resize(t.id, req.cols, req.rows);
            return ok({ ok: true });
          }
        }
      } catch (e) {
        err((e as Error).message);
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      attached.delete(socket);
    });
  }

  return {
    serve,
    get size() {
      return sockets.size;
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
