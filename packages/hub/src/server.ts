import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import {
  ClientMsg,
  type Session,
  BinaryFrameKind,
  decodeBinaryFrame,
  encodeBinaryFrame,
  type HubState,
  type ServerMsg,
} from '@termscape/protocol';
import { Hub, HUB_VERSION } from './hub.js';
import { createPeerServer, type PeerServer } from './remote/peer-serve.js';
import { registerEnrollment, type Enrollment } from './remote/enroll.js';
import {
  advertisedHost,
  coversLoopback,
  preferredHostname,
  urlHost,
} from './remote/lan.js';
import { buildMcpServer, buildMcpTransport } from './mcp/server.js';

export interface ServeOptions {
  hub: Hub;
  /**
   * Bind address. Defaults to loopback. The CLI decides what a hub started by
   * a person should bind — see listenPlan — and passes the answer here; this
   * default is what the tests and any other caller get.
   */
  host?: string;
  /**
   * Whether `/join` answers. Off unless the operator asked for it, even when
   * the bind is wide: the canvas is token-gated and the join page is not, so
   * being reachable and being enrollable are two different permissions.
   */
  enroll?: boolean;
  /**
   * A port to bind exactly (0 lets the OS pick), or a list of candidates to
   * try in order until one is free.
   */
  port?: number | number[];
  clientToken: string;
  /** Remote hubs serve no UI. */
  headless?: boolean;
}

export interface ServeResult {
  app: FastifyInstance;
  /**
   * How to reach this hub *from this machine*. Agents get it in their
   * generated MCP config, so it stays 127.0.0.1 whenever the bind answers
   * there — an agent's tool endpoint has no business being advertised on the
   * network. It only becomes a real address if the operator bound one
   * specific non-loopback interface, where loopback genuinely will not answer.
   */
  origin: string;
  /**
   * Where another machine can reach this hub at all — the canvas included, so
   * the token URL can be opened on a phone — or null when loopback-bound.
   * Prefers this machine's name over its address.
   */
  lanOrigin: string | null;
  /** The same origin by IP, when `lanOrigin` uses this machine's name. */
  lanAltOrigin: string | null;
  /**
   * Where another machine can reach the join page: `lanOrigin` when
   * enrollment was asked for, and null otherwise. A reachable hub that was
   * not asked to enroll advertises no join page and serves none.
   */
  enrollOrigin: string | null;
  /** The same origin by IP, when `enrollOrigin` uses this machine's name. */
  enrollAltOrigin: string | null;
  port: number;
  /** So a joining hub can answer the canvas hub over a socket it dialled. */
  peerServer: PeerServer;
  /** Mints the single-use tokens the join installers carry. */
  enrollment: Enrollment;
}

/**
 * Ports to try before falling back to whatever the OS hands out.
 *
 * The join page is the one URL someone has to type by hand, on a different
 * machine, from memory — it carries no token precisely so it can be typed. A
 * five-digit ephemeral port makes that miserable, so prefer something a person
 * can hold in their head.
 *
 * Ordered by memorability, skipping ports that common dev tooling squats on:
 * 3000/8000/8080 (everything), 5555 (adb), 8888 (Jupyter), 2222 (alt ssh).
 */
export const MEMORABLE_PORTS = [7777, 4242, 7333, 3333, 9999, 7070, 4040, 1212];

/**
 * Locate the built web assets relative to this file, if they exist.
 *
 * Two layouts have to work. In the monorepo the hub runs from
 * `packages/hub/dist/` and the UI is its sibling at `packages/web/dist`. In the
 * published package there are no siblings: the UI is copied to `web/` beside
 * `dist/`, because npm ships one package and a relative walk out of it would
 * land in whatever the user happens to have installed next door.
 */
function webRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Published layout: <pkg>/dist/server.js -> <pkg>/web
    join(here, '..', 'web'),
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
   * The answering half of the hub-to-hub link. A hub deployed over SSH serves
   * this and the canvas-owning hub dials it through the tunnel, so on that
   * path the endpoint is only ever reachable over loopback on the remote
   * machine. The logic lives in peer-serve.ts because a hub that enrolled
   * itself runs the identical thing over a socket it dialled out instead.
   */
  const peerServer = createPeerServer(hub, clientToken);
  // It is also this hub's link back to whatever canvas it was attached to.
  // On a hub that owns its own canvas nothing ever attaches, and the uplink
  // reports itself as detached forever.
  hub.setUplink(peerServer);

  app.get('/peer', { websocket: true }, (socket) => {
    peerServer.serve(socket);
  });

  /* --------------------------------------------------------------- join */

  // The bind address is not known until listen() resolves, so the enroll
  // routes read it through a closure rather than a captured value.
  let lanOrigin: string | null = null;
  let lanAltOrigin: string | null = null;
  let enrollOrigin: string | null = null;
  let enrollAltOrigin: string | null = null;
  const enrollment = registerEnrollment(app, { hub, enrollOrigin: () => enrollOrigin });

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
    enrollUrl: enrollOrigin ? `${enrollOrigin}/join` : null,
    enrollAltUrl: enrollAltOrigin ? `${enrollAltOrigin}/join` : null,
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
  // Deploy progress. Installing on a remote can take minutes; the panel shows
  // these lines so it is not a frozen button.
  hub.on('hostLog', (hostId, line) => broadcast({ t: 'hostLog', hostId, line }));
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
              // Typing into a remote terminal whose PTY has since exited is
              // ordinary, and the peer says so by rejecting. Unhandled, that
              // rejection reaches the process and takes the whole canvas with
              // it — so it is reported to this browser and goes no further.
              void remote.peer
                .request({ t: 'input', id: randomUUID(), address: f.sessionId, data })
                .catch((e: Error) =>
                  send(socket, { t: 'error', message: e.message, sessionId: f.sessionId }),
                );
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
          await hub.removeWorkspace(msg.workspaceId);
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
          // A remote window's session belongs to its peer. Removing it here
          // would delete nothing and merely hide the window until that peer
          // reported it again.
          if (await hub.peers.removeSession(msg.sessionId)) return;
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
          await hub.removeHost(msg.hostId);
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
    peerServer.closeAll();
    clients.clear();
    attached.clear();
  });

  /* --------------------------------------------------------------- bind */

  // Loopback unless the caller asked otherwise. The CLI widens this for a hub
  // that serves a UI; an SSH-deployed hub is headless, is reached only through
  // its tunnel, and gets the default.
  const host = opts.host ?? '127.0.0.1';
  const address = await listenOnFirstFree(app, host, opts.port ?? 0);
  const port = (app.server.address() as { port: number }).port;

  // Agents' MCP endpoint stays on loopback whenever the bind answers there,
  // which for `--listen lan` it does: that binds the wildcard precisely so
  // this stays true.
  const origin = `http://${coversLoopback(host) ? '127.0.0.1' : urlHost(host)}:${port}`;
  hub.setOrigin(origin);

  const advertised = advertisedHost(host);
  if (advertised) {
    // Prefer this machine's name: it is the URL someone has to carry to
    // another machine and type in. The IP stays available underneath.
    const name = await preferredHostname(advertised);
    lanOrigin = `http://${name ?? advertised}:${port}`;
    lanAltOrigin = name ? `http://${advertised}:${port}` : null;
  }

  // The join page reads enrollOrigin through its closure and 404s on null, so
  // withholding the origin is what withholds the page - there is no second
  // switch to keep in step with this one.
  if (opts.enroll) {
    enrollOrigin = lanOrigin;
    enrollAltOrigin = lanAltOrigin;
  }

  void address;
  return {
    app,
    origin,
    lanOrigin,
    lanAltOrigin,
    enrollOrigin,
    enrollAltOrigin,
    port,
    peerServer,
    enrollment,
  };
}

/**
 * Bind the first candidate that is free.
 *
 * A probe-then-bind would race, so this just tries to bind for real and moves
 * on when the port is taken. The last resort is `0` — an unmemorable port
 * still beats refusing to start.
 */
async function listenOnFirstFree(
  app: FastifyInstance,
  host: string,
  port: number | number[],
): Promise<string> {
  const candidates = Array.isArray(port) ? [...port, 0] : [port];

  for (let i = 0; i < candidates.length; i++) {
    try {
      return await app.listen({ host, port: candidates[i]! });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const inUse = code === 'EADDRINUSE' || code === 'EACCES';
      if (!inUse || i === candidates.length - 1) throw err;
    }
  }
  throw new Error('no port available');
}
