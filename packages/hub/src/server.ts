import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  ClientMsg,
  PeerRequest,
  PEER_SCHEMA_VERSION,
  type PeerResponse,
  type Session,
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type HubState,
  type ServerMsg,
} from '@aicanvas/protocol';
import { Hub, HUB_VERSION } from './hub.js';
import { buildMcpServer, buildMcpTransport } from './mcp/server.js';

export interface ServeOptions {
  hub: Hub;
  host?: string;
  port?: number;
  clientToken: string;
  /** Remote hubs serve no UI. */
  headless?: boolean;
}

export interface ServeResult {
  app: FastifyInstance;
  origin: string;
  port: number;
}

/** Locate the built web assets relative to this file, if they exist. */
function webRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'web', 'dist'),
    join(here, '..', '..', '..', 'web', 'dist'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export async function serve(opts: ServeOptions): Promise<ServeResult> {
  const { hub, clientToken } = opts;
  const app = Fastify({ logger: false });

  await app.register(websocket, {
    options: { maxPayload: 8 * 1024 * 1024 },
  });

  /* ------------------------------------------------------------- health */

  app.get('/health', async () => ({
    ok: true,
    hubVersion: HUB_VERSION,
    pid: process.pid,
  }));

  /* -------------------------------------------------------------- hooks */

  /**
   * Agent CLIs POST here at turn boundaries. The path carries the agent's own
   * bearer token, which is also how we know which window changed state.
   */
  app.post<{ Params: { token: string }; Querystring: { event?: string } }>(
    '/hook/:token',
    async (req, reply) => {
      const sessionId = hub.tokens.resolve(req.params.token);
      if (!sessionId) return reply.code(404).send({ ok: false });
      const event = req.query.event === 'idle' ? 'idle' : 'busy';
      hub.sessions.setStatusFromHook(sessionId, event);
      return { ok: true };
    },
  );

  /* ---------------------------------------------------------------- MCP */

  app.all('/mcp', async (req, reply) => {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const sessionId = token ? hub.tokens.resolve(token) : null;
    if (!sessionId) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'unauthorized' },
        id: null,
      });
    }

    // Stateless: a fresh server + transport per request, bound to this caller.
    const server = buildMcpServer(sessionId, hub);
    const transport = buildMcpTransport();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    return reply;
  });

  /* --------------------------------------------------------- peer (hub↔hub) */

  /**
   * The server half of the hub-to-hub link. A remote hub serves this; the
   * local hub connects to it through an SSH tunnel, so this endpoint is only
   * ever reachable over loopback on the remote machine.
   */
  const peerSockets = new Set<import('ws').WebSocket>();
  const peerAttached = new Map<import('ws').WebSocket, Set<string>>();

  const peerSend = (ws: import('ws').WebSocket, msg: PeerResponse): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  hub.on('session', (s: Session) => {
    for (const ws of peerSockets) peerSend(ws, { t: 'sessionUpserted', session: s });
  });
  hub.on('removed', (_id: string, address: string | null) => {
    // Peers address sessions by name, not by this hub's internal id, which is
    // why the address travels with the event rather than being looked up
    // after the row is already gone.
    if (!address) return;
    for (const ws of peerSockets) peerSend(ws, { t: 'sessionRemoved', address });
  });
  hub.on('data', (sessionId: string, chunk: string) => {
    if (peerSockets.size === 0) return;
    const s = hub.sessions.get(sessionId);
    if (!s) return;
    for (const ws of peerSockets) {
      if (peerAttached.get(ws)?.has(s.address)) {
        peerSend(ws, { t: 'output', address: s.address, data: chunk });
      }
    }
  });

  app.get('/peer', { websocket: true }, (socket) => {
    let authed = false;

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
        peerSockets.add(socket);
        peerAttached.set(socket, new Set());
        peerSend(socket, {
          t: 'welcome',
          hubVersion: HUB_VERSION,
          schemaVersion: PEER_SCHEMA_VERSION,
        });
        return;
      }
      if (req.t === 'hello') return;

      const ok = (result: unknown) => peerSend(socket, { t: 'ok', id: req.id, result });
      const err = (message: string) => peerSend(socket, { t: 'err', id: req.id, message });

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
            peerAttached.get(socket)?.add(req.address);
            const t = hub.sessions.getByAddress(req.address);
            if (t) {
              const snap = hub.sessions.snapshotForAttach(t.id);
              if (snap) peerSend(socket, { t: 'output', address: req.address, data: snap.serialized });
            }
            return ok({ attached: req.address });
          }

          case 'detach':
            peerAttached.get(socket)?.delete(req.address);
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
      peerSockets.delete(socket);
      peerAttached.delete(socket);
    });
  });

  /* ---------------------------------------------------------- WebSocket */

  const clients = new Set<import('ws').WebSocket>();

  const send = (ws: import('ws').WebSocket, msg: ServerMsg): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMsg): void => {
    for (const ws of clients) send(ws, msg);
  };

  const snapshotState = (): HubState => ({
    hubVersion: HUB_VERSION,
    hosts: hub.store.listHosts(),
    workspaces: hub.store.listWorkspaces(),
    sessions: hub.allSessions(),
    messages: hub.messages(),
    viewport: hub.store.getViewport(),
    profiles: hub.profiles.list().map((p) => ({
      id: p.id,
      description: p.description,
      mcp: p.mcp,
      resumable: !!p.resumeArgs,
    })),
  });

  hub.on('session', (s) => broadcast({ t: 'sessionUpserted', session: s }));
  hub.on('removed', (id) => broadcast({ t: 'sessionRemoved', sessionId: id }));
  hub.on('workspace', (w) => broadcast({ t: 'workspaceUpserted', workspace: w }));
  hub.on('workspaceRemoved', (id) => broadcast({ t: 'workspaceRemoved', workspaceId: id }));
  hub.on('message', (m) => broadcast({ t: 'messageSent', message: m }));
  hub.on('host', (h) => broadcast({ t: 'hostUpserted', host: h }));
  hub.on('hostRemoved', (id) => broadcast({ t: 'hostRemoved', hostId: id }));
  // A peer connecting, dropping, or resyncing changes many sessions at
  // once, so push the whole list rather than diffing it here.
  hub.on('peersChanged', () => {
    for (const s of hub.peers.sessions()) broadcast({ t: 'sessionUpserted', session: s });
  });

  // Terminal output goes only to clients that have attached to that window,
  // so a canvas showing 20 terminals zoomed out is not paying for 20 streams.
  const attached = new Map<import('ws').WebSocket, Set<string>>();
  hub.on('data', (sessionId: string, chunk: string) => {
    const frame = encodeBinaryFrame(
      BinaryFrameKind.PtyOutput,
      sessionId,
      Buffer.from(chunk, 'utf8'),
    );
    for (const ws of clients) {
      if (attached.get(ws)?.has(sessionId) && ws.readyState === ws.OPEN) ws.send(frame);
    }
  });

  app.get('/ws', { websocket: true }, (socket) => {
    let authed = false;
    clients.add(socket);
    attached.set(socket, new Set());

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      try {
        if (isBinary) {
          if (!authed) return;
          const f = decodeBinaryFrame(new Uint8Array(raw));
          if (f.kind === BinaryFrameKind.PtyInput) {
            const data = Buffer.from(f.payload).toString('utf8');
            const remote = hub.peers.find(f.sessionId);
            if (remote) {
              void remote.peer.request({
                t: 'input', id: randomUUID(), address: f.sessionId, data,
              });
            } else {
              hub.sessions.write(f.sessionId, data);
            }
          }
          return;
        }

        const parsed = ClientMsg.safeParse(JSON.parse(raw.toString('utf8')));
        if (!parsed.success) {
          send(socket, { t: 'error', message: 'malformed message' });
          return;
        }
        const msg = parsed.data;

        if (!authed) {
          if (msg.t !== 'hello' || msg.token !== clientToken) {
            send(socket, { t: 'error', message: 'unauthorized' });
            socket.close();
            return;
          }
          authed = true;
          send(socket, { t: 'ready', state: snapshotState() });
          return;
        }

        void handleClientMsg(socket, msg);
      } catch (err) {
        send(socket, { t: 'error', message: (err as Error).message });
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      attached.delete(socket);
    });
  });

  async function handleClientMsg(
    socket: import('ws').WebSocket,
    msg: ClientMsg,
  ): Promise<void> {
    try {
      switch (msg.t) {
        case 'hello':
          return;

        // Remote sessions are keyed by their address, so a single lookup
        // decides whether a request is served locally or forwarded to a peer.
        case 'attach': {
          attached.get(socket)?.add(msg.sessionId);
          const remote = hub.peers.find(msg.sessionId);
          if (remote) {
            await remote.peer.attach(msg.sessionId);
            return;
          }
          const snap = hub.sessions.snapshotForAttach(msg.sessionId);
          if (snap) {
            send(socket, {
              t: 'snapshot',
              sessionId: msg.sessionId,
              serialized: snap.serialized,
              cols: snap.cols,
              rows: snap.rows,
            });
          }
          return;
        }

        case 'detach': {
          attached.get(socket)?.delete(msg.sessionId);
          const remote = hub.peers.find(msg.sessionId);
          if (remote) await remote.peer.detach(msg.sessionId);
          return;
        }

        case 'resize': {
          const remote = hub.peers.find(msg.sessionId);
          if (remote) {
            await remote.peer.request({
              t: 'resize',
              id: randomUUID(),
              address: msg.sessionId,
              cols: msg.cols,
              rows: msg.rows,
            });
            return;
          }
          hub.sessions.resize(msg.sessionId, msg.cols, msg.rows);
          return;
        }

        case 'createWorkspace':
          hub.createWorkspace(msg.name, msg.rootPath, msg.hostId ?? null);
          return;

        case 'removeWorkspace':
          hub.removeWorkspace(msg.workspaceId);
          return;

        case 'startSession':
          await hub.startSession({
            workspaceId: msg.workspaceId,
            profile: msg.profile,
            name: msg.name,
            cwd: msg.cwd,
          });
          return;

        case 'stopSession': {
          const remote = hub.peers.find(msg.sessionId);
          if (remote) {
            await remote.peer.request({ t: 'stopSession', id: randomUUID(), address: msg.sessionId });
            return;
          }
          hub.sessions.stop(msg.sessionId);
          return;
        }

        case 'removeSession':
          hub.sessions.remove(msg.sessionId);
          return;

        case 'resumeSession': {
          const remote = hub.peers.find(msg.sessionId);
          if (remote) {
            await remote.peer.request({ t: 'resumeSession', id: randomUUID(), address: msg.sessionId });
            return;
          }
          await hub.sessions.resume(msg.sessionId);
          return;
        }

        case 'resumeWorkspace':
          await hub.resumeWorkspace(msg.workspaceId);
          return;

        case 'moveWindow':
          // Layout is always local, even for a peer's session.
          if (!hub.peers.saveLayout(msg.sessionId, msg.rect)) {
            hub.moveWindow(msg.sessionId, msg.rect);
          }
          return;

        case 'setViewport':
          hub.setViewport(msg.viewport);
          return;

        case 'addHost': {
          const host = hub.addHost(msg);
          // Connect immediately: adding a host the user then has to connect
          // by hand is a pointless second step.
          void hub.connectHost(host.id).catch((e) =>
            send(socket, { t: 'error', message: `connect ${host.label}: ${e.message}` }),
          );
          return;
        }

        case 'removeHost':
          hub.removeHost(msg.hostId);
          return;

        case 'connectHost':
          await hub.connectHost(msg.hostId);
          return;

        default:
          send(socket, { t: 'error', message: `unhandled: ${(msg as { t: string }).t}` });
      }
    } catch (err) {
      send(socket, { t: 'error', message: (err as Error).message });
    }
  }

  /* ------------------------------------------------------------- static */

  if (!opts.headless) {
    const root = webRoot();
    if (root) {
      await app.register(fastifyStatic, {
        root,
        wildcard: false,
        // Asset filenames are content-hashed by vite, so they may be cached
        // forever. index.html must NOT be: a cached copy points at the
        // previous build's hashed bundle, which now 404s, leaving a blank
        // page that only a manual hard-reload fixes.
        setHeaders: (res, filePath) => {
          const immutable = filePath.includes(`${sep}assets${sep}`);
          res.header(
            'cache-control',
            immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      });

      // SPA fallback, but only for navigations. Serving index.html for a
      // missing /assets/*.js turns a cache-stale asset into a confusing MIME
      // type error instead of an honest 404, so anything that looks like a
      // file must 404 as a file.
      app.setNotFoundHandler((req, reply) => {
        const url = (req.raw.url ?? '/').split('?')[0]!;
        const looksLikeFile = /\.[a-z0-9]+$/i.test(url);
        const isApi = url.startsWith('/mcp') || url.startsWith('/hook') || url.startsWith('/ws');
        if (looksLikeFile || isApi) {
          return reply.code(404).send({ error: 'not found', path: url });
        }
        return reply.sendFile('index.html');
      });
    }
  }

  /* ----------------------------------------------------------- shutdown */

  /**
   * Fastify's close() waits for open connections to drain, and a WebSocket
   * never drains on its own — an idle browser tab or a connected peer would
   * hang shutdown indefinitely. Terminate them explicitly instead.
   */
  app.addHook('onClose', async () => {
    for (const ws of clients) {
      try {
        ws.terminate();
      } catch {
        // Already gone.
      }
    }
    for (const ws of peerSockets) {
      try {
        ws.terminate();
      } catch {
        // Already gone.
      }
    }
    clients.clear();
    peerSockets.clear();
    attached.clear();
    peerAttached.clear();
  });

  /* --------------------------------------------------------------- bind */

  // Loopback only, always. The remote hub is reached through an SSH tunnel,
  // never by listening on a public interface.
  const host = opts.host ?? '127.0.0.1';
  const address = await app.listen({ host, port: opts.port ?? 0 });
  const port = (app.server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  hub.setOrigin(origin);

  void address;
  return { app, origin, port };
}
