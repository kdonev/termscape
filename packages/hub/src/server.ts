import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  ClientMsg,
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
    sessions: hub.sessions.list(),
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
            hub.sessions.write(f.sessionId, Buffer.from(f.payload).toString('utf8'));
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

        case 'attach': {
          attached.get(socket)?.add(msg.sessionId);
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

        case 'detach':
          attached.get(socket)?.delete(msg.sessionId);
          return;

        case 'resize':
          hub.sessions.resize(msg.sessionId, msg.cols, msg.rows);
          return;

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

        case 'stopSession':
          hub.sessions.stop(msg.sessionId);
          return;

        case 'removeSession':
          hub.sessions.remove(msg.sessionId);
          return;

        case 'resumeSession':
          await hub.sessions.resume(msg.sessionId);
          return;

        case 'resumeWorkspace':
          await hub.resumeWorkspace(msg.workspaceId);
          return;

        case 'moveWindow':
          hub.moveWindow(msg.sessionId, msg.rect);
          return;

        case 'setViewport':
          hub.setViewport(msg.viewport);
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
      await app.register(fastifyStatic, { root, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/mcp')) {
          return reply.code(404).send({ error: 'not found' });
        }
        return reply.sendFile('index.html');
      });
    }
  }

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
