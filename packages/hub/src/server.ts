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
  describeInput,
  describeModeChanges,
  describeSnapshotModes,
} from '@termscape/protocol';
import { Hub, HUB_VERSION } from './hub.js';
import { debug, debugOn } from './debug.js';
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
  /*
   * Accept a POST whose content type nothing else parses, and ignore the body.
   *
   * The hook carries its event in the query string and has no body worth
   * reading, but Fastify answers 415 for a content type it has no parser for -
   * which is how every status hook from Windows was rejected while looking, to
   * the agent, like a hook that simply failed. Registered parsers still win, so
   * /mcp keeps its JSON.
   */
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, _body, done) =>
    done(null, undefined),
  );

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
  /**
   * What a socket may see and touch: `null` for the canvas token (today's
   * full-canvas behaviour, unchanged), or one session id for a share link.
   * Absent entirely before `hello` lands.
   */
  const scopes = new Map<import('ws').WebSocket, string | null>();

  const send = (ws: import('ws').WebSocket, msg: ServerMsg): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  /**
   * Whether a scoped socket may be told this. Only the messages about its own
   * session pass; everything else - another agent's title, a host, a
   * template - is exactly what a reviewer holding one link must not learn.
   * `snapshot`, `error` and `ack` never go through here: they are already
   * addressed to one socket at the point they are sent.
   */
  const scopedBroadcast = (msg: ServerMsg, scope: string): boolean => {
    switch (msg.t) {
      case 'sessionUpserted':
        return msg.session.id === scope;
      case 'sessionRemoved':
        return msg.sessionId === scope;
      default:
        return false;
    }
  };
  const broadcast = (msg: ServerMsg): void => {
    for (const ws of clients) {
      // Not yet authenticated: unset, not null, and left alone rather than
      // filtered - the same as it was before scoping existed. `hello` is the
      // very next thing such a socket will send.
      const scope = scopes.get(ws);
      if (typeof scope === 'string' && !scopedBroadcast(msg, scope)) continue;
      send(ws, msg);
    }
  };
  /**
   * Like `broadcast`, but never back to `origin`.
   *
   * Notes are the one thing on the canvas that changes on every keystroke and
   * every drag frame, sent straight through with no debounce (see
   * `hub.saveNote`). Echoing the write back to the socket that made it would
   * land under an active drag or an active caret a moment after it moved,
   * jittering the drag rect or resetting the textarea's cursor position - the
   * exact bug `moveWindow` never has to worry about, because nothing ever
   * broadcasts a window move at all.
   */
  const broadcastExcept = (origin: import('ws').WebSocket, msg: ServerMsg): void => {
    for (const ws of clients) {
      if (ws === origin) continue;
      const scope = scopes.get(ws);
      if (typeof scope === 'string' && !scopedBroadcast(msg, scope)) continue;
      send(ws, msg);
    }
  };

  const snapshotState = (): HubState => ({
    hubVersion: HUB_VERSION,
    enrollUrl: enrollOrigin ? `${enrollOrigin}/join` : null,
    enrollAltUrl: enrollAltOrigin ? `${enrollAltOrigin}/join` : null,
    lanOrigin,
    lanAltOrigin,
    hosts: hub.store.listHosts(),
    workspaces: hub.store.listWorkspaces(),
    sessions: hub.allSessions(),
    messages: hub.messages(),
    viewport: hub.store.getViewport(),
    // Whatever detection knows right now, which on the first load is usually
    // "not probed yet" - it starts after this server is already listening, on
    // purpose, so nothing about spawning CLIs can delay a page.
    profiles: hub.agents.snapshot(),
    templates: hub.templates.info(),
    // A browser that was closed when a proposal arrived would otherwise never
    // see it, and the agent that asked is still waiting on an answer.
    templateProposals: hub.pendingProposals(),
    hostProfiles: hub.peers.agentsByHost(),
    shares: hub.shares.list(),
    notes: hub.store.listNotes(),
  });

  /**
   * What a share-scoped socket is told on `hello`: the one session it names,
   * its workspace if this hub can resolve one for it, and empty everything
   * else. The browser's own `apply('ready')` needs no change at all - it
   * already replaces its state wholesale on every `ready`, so a state this
   * thin just means a canvas of one window.
   */
  const scopedState = (sessionId: string): HubState => {
    const session = hub.allSessions().find((s) => s.id === sessionId) ?? null;
    // A remote session's workspaceId is the *peer's* local id, meaningless
    // here (see the note on peer-serve's startSession) - getWorkspace simply
    // returns null for it, which is exactly "nothing to show".
    const workspace = session ? hub.store.getWorkspace(session.workspaceId) : null;
    return {
      hubVersion: HUB_VERSION,
      enrollUrl: null,
      enrollAltUrl: null,
      lanOrigin: null,
      lanAltOrigin: null,
      hosts: [],
      workspaces: workspace ? [workspace] : [],
      sessions: session ? [session] : [],
      messages: [],
      viewport: { panX: 0, panY: 0, zoom: 1 },
      profiles: [],
      templates: [],
      templateProposals: [],
      hostProfiles: {},
      shares: [],
      // A reviewer holding one share link sees the one terminal it names,
      // nothing else on the canvas - notes included.
      notes: [],
    };
  };

  hub.on('session', (s) => broadcast({ t: 'sessionUpserted', session: s }));
  hub.on('removed', (id) => broadcast({ t: 'sessionRemoved', sessionId: id }));
  hub.on('workspace', (w) => broadcast({ t: 'workspaceUpserted', workspace: w }));
  hub.on('workspaceRemoved', (id) => broadcast({ t: 'workspaceRemoved', workspaceId: id }));
  hub.on('templates', (templates) => broadcast({ t: 'templatesChanged', templates }));
  hub.on('templateProposed', (proposal) => broadcast({ t: 'templateProposed', proposal }));
  hub.on('templateProposalResolved', (proposalId) =>
    broadcast({ t: 'templateProposalResolved', proposalId }),
  );
  hub.on('message', (m) => broadcast({ t: 'messageSent', message: m }));
  hub.on('host', (h) => broadcast({ t: 'hostUpserted', host: h }));
  hub.on('hostRemoved', (id) => broadcast({ t: 'hostRemoved', hostId: id }));
  hub.on('shares', (shares) => broadcast({ t: 'sharesChanged', shares }));
  // Revocation has to reach an already-open tab, not just the row that let it
  // in - otherwise "revoked" is untrue for the one case it exists for.
  hub.on('shareRevoked', (sessionId: string) => {
    for (const [ws, scope] of scopes) {
      if (scope !== sessionId) continue;
      send(ws, { t: 'error', message: 'unauthorized' });
      ws.close();
    }
  });
  hub.on('agents', (profiles) =>
    broadcast({ t: 'agentsDetected', hostId: null, profiles }),
  );
  hub.on('hostAgents', (hostId, profiles) =>
    broadcast({ t: 'agentsDetected', hostId, profiles }),
  );
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
    /*
     * Not the output itself - only the moments a program changes the terms.
     *
     * Whether a wheel belongs to the program or to xterm's own scrollback is
     * decided entirely by these modes, and they are set once, early, in a
     * chunk indistinguishable from any other. Logging the flips gives a trace
     * the one fact the input side cannot supply: whether the program ever
     * asked for mouse reports at all.
     */
    if (debugOn('output')) {
      const modes = describeModeChanges(chunk);
      if (modes) debug('output', `${sessionId} program set ${modes}`);
    }
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
    // So an agent can be told honestly whether anybody is there to answer it.
    hub.setViewers(clients.size);
    attached.set(socket, new Set());

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      try {
        if (isBinary) {
          if (!authed) return;
          const f = decodeBinaryFrame(new Uint8Array(raw));
          const isInput =
            f.kind === BinaryFrameKind.PtyInput ||
            f.kind === BinaryFrameKind.PtyInputRaw;
          // The gate that matters most: this is the only path that writes to
          // a PTY, and a share link is otherwise indistinguishable from the
          // canvas token once a socket is past `hello`.
          const scope = scopes.get(socket);
          if (isInput && typeof scope === 'string' && f.sessionId !== scope) return;
          if (isInput) {
            // Raw frames are bytes and stay bytes: latin1 is the encoding that
            // survives a JSON hop to a peer without inventing code points, and
            // locally the Buffer never becomes a string at all.
            const bytes = Buffer.from(f.payload);
            const isRaw = f.kind === BinaryFrameKind.PtyInputRaw;
            const remote = hub.peers.find(f.sessionId);
            /*
             * Where a wheel goes, and whether it is still the same bytes.
             *
             * The local and remote branches below are the whole of the
             * asymmetry a scroll bug has to be somewhere in: one of them
             * hands a Buffer to a pty in this process, the other spells it as
             * a string, puts it through JSON, and waits for another machine
             * to answer. Both are traced with the same description of the
             * same bytes, so a report that changes shape between them shows
             * up as two lines that disagree.
             */
            if (debugOn('input')) {
              const where = remote
                ? `remote host=${hub.peers.hostIdFor(f.sessionId) ?? '?'} ` +
                  `link=${remote.peer.connected ? 'up' : 'DOWN'}`
                : 'local';
              debug(
                'input',
                `browser -> hub ${f.sessionId} ${isRaw ? 'raw' : 'utf8'} ` +
                  `${where}: ${describeInput(f.payload)}`,
              );
            }
            if (remote) {
              // Typing into a remote terminal whose PTY has since exited is
              // ordinary, and the peer says so by rejecting. Unhandled, that
              // rejection reaches the process and takes the whole canvas with
              // it — so it is reported to this browser and goes no further.
              const id = randomUUID();
              void remote.peer
                .request({
                  t: 'input',
                  id,
                  address: f.sessionId,
                  data: bytes.toString(isRaw ? 'latin1' : 'utf8'),
                  ...(isRaw ? { encoding: 'binary' as const } : {}),
                })
                .then(() => debug('input', `hub -> peer ${id} accepted`))
                .catch((e: Error) => {
                  // Named rather than counted: "timed out" and "not
                  // connected" are different diagnoses, and a wheel that
                  // silently stops working looks the same either way.
                  debug('input', `hub -> peer ${id} FAILED: ${e.message}`);
                  send(socket, { t: 'error', message: e.message, sessionId: f.sessionId });
                });
              debug(
                'input',
                `hub -> peer ${id} ${f.sessionId} ` +
                  `encoding=${isRaw ? 'binary' : 'utf8'} ${bytes.length}B sent`,
              );
            } else if (isRaw) {
              hub.sessions.writeBytes(f.sessionId, bytes);
            } else {
              hub.sessions.write(f.sessionId, bytes.toString('utf8'));
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
          if (msg.t !== 'hello') {
            send(socket, { t: 'error', message: 'unauthorized' });
            socket.close();
            return;
          }
          if (msg.token === clientToken) {
            authed = true;
            scopes.set(socket, null);
            send(socket, { t: 'ready', state: snapshotState() });
            return;
          }
          // Not the canvas token; try it as a share link before giving up.
          const sharedSessionId = hub.resolveShareToken(msg.token);
          if (sharedSessionId) {
            authed = true;
            scopes.set(socket, sharedSessionId);
            send(socket, { t: 'ready', state: scopedState(sharedSessionId) });
            return;
          }
          send(socket, { t: 'error', message: 'unauthorized' });
          socket.close();
          return;
        }

        void handleClientMsg(socket, msg);
      } catch (err) {
        send(socket, { t: 'error', message: (err as Error).message });
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      hub.setViewers(clients.size);
      attached.delete(socket);
      scopes.delete(socket);
    });
  });

  /**
   * Run one client message and answer for it.
   *
   * A message that carried a requestId gets an `ack` either way, and a failure
   * is *not* also raised as an `error`: the dialog that asked is showing it,
   * and a toast in the corner repeating it is noise. Everything without a
   * requestId keeps the old behaviour, a bare `error`.
   */
  async function handleClientMsg(
    socket: import('ws').WebSocket,
    msg: ClientMsg,
  ): Promise<void> {
    const requestId = 'requestId' in msg ? msg.requestId : undefined;
    try {
      const sessionId = (await dispatchClientMsg(socket, msg)) || undefined;
      if (requestId) send(socket, { t: 'ack', requestId, ok: true, sessionId });
    } catch (err) {
      const message = (err as Error).message;
      if (requestId) send(socket, { t: 'ack', requestId, ok: false, message });
      else send(socket, { t: 'error', message });
    }
  }

  async function dispatchClientMsg(
    socket: import('ws').WebSocket,
    msg: ClientMsg,
  ): Promise<string | void> {
    /*
     * A share-scoped socket may only ask about the one session it was
     * handed. Everything downstream of `hello` for the canvas token is a
     * permission system nobody asked for; this is deliberately not that -
     * one value, checked once, before the switch below ever sees the
     * message. Each allowed message still names its own sessionId, which is
     * checked against the scope rather than trusted.
     *
     * `resize` is deliberately NOT on this list. A share view renders with
     * `grid: 'follow'` and never sends one - it fits itself to the grid the
     * owner's window drives, precisely so two browsers do not fight over one
     * PTY's size and leave the *owner* rendering on a grid the PTY no longer
     * has. Accepting a resize here would be a permission nothing uses whose
     * only effect is to reopen that.
     */
    const scope = scopes.get(socket);
    if (typeof scope === 'string') {
      const allowed = msg.t === 'hello' || msg.t === 'attach' || msg.t === 'detach';
      if (!allowed || ('sessionId' in msg && msg.sessionId !== scope)) {
        throw new Error('not permitted on a shared-session link');
      }
    }

    switch (msg.t) {
      case 'hello':
        return;

      // Remote sessions are keyed by their address, so a single lookup
      // decides whether a request is served locally or forwarded to a peer.
      case 'attach': {
        attached.get(socket)?.add(msg.sessionId);
        const remote = hub.peers.find(msg.sessionId);
        if (remote) {
          /*
           * The other half of the asymmetry, and the one that is easy to miss.
           *
           * A local attach answers with a `snapshot` message. A remote one
           * cannot: the screen lives on the other machine, so it arrives as
           * ordinary output on the stream instead. Same pixels, different
           * route - and the route matters here, because a serialized screen
           * is also what restores the mouse modes into a freshly mounted
           * window. This line says the request went out; the peer's own log
           * says what came back.
           */
          debug('attach', `attach ${msg.sessionId} -> peer (snapshot arrives as output)`);
          await remote.peer.attach(msg.sessionId);
          return;
        }
        const snap = hub.sessions.snapshotForAttach(msg.sessionId);
        if (snap) {
          debug(
            'attach',
            `attach ${msg.sessionId} local ${snap.cols}x${snap.rows} ` +
              `snapshot restores: ${describeSnapshotModes(snap.serialized)}`,
          );
          send(socket, {
            t: 'snapshot',
            sessionId: msg.sessionId,
            serialized: snap.serialized,
            cols: snap.cols,
            rows: snap.rows,
          });
        } else {
          debug('attach', `attach ${msg.sessionId} local, no snapshot`);
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
        /*
         * Worth tracing next to the input, because a mouse report is a pair
         * of coordinates and both ends have to agree on what they can be.
         * xterm drops a report whose column or row falls outside its own
         * grid before it is ever encoded, so a window and a pty that disagree
         * on size lose wheels at the edges and nowhere else - which reads
         * like an intermittent bug rather than a size one.
         */
        debug(
          'attach',
          `resize ${msg.sessionId} -> ${msg.cols}x${msg.rows} ` +
            `(${remote ? 'remote' : 'local'})`,
        );
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

      case 'checkFolder':
        // Nothing to hand back beyond ok/err: the dialog already knows the
        // path it asked about, and a throw here is turned into ack{ok:false}
        // by handleClientMsg the same way any other refusal is.
        await hub.checkHostFolder(msg.hostId ?? null, msg.path);
        return;

      case 'createWorkspace':
        hub.createWorkspace(msg.name, msg.rootPath, msg.hostId ?? null);
        return;

      case 'updateWorkspace':
        hub.updateWorkspace(msg.workspaceId, {
          name: msg.name,
          rootPath: msg.rootPath,
        });
        return;

      case 'removeWorkspace':
        await hub.removeWorkspace(msg.workspaceId);
        return;

      case 'saveTemplate':
        hub.saveTemplate({
          id: msg.id,
          agent: msg.agent,
          description: msg.description,
          model: msg.model,
          effort: msg.effort,
          prompt: msg.prompt,
          env: msg.env,
        });
        return;

      case 'removeTemplate':
        hub.removeTemplate(msg.id);
        return;

      case 'resolveTemplateProposal':
        hub.resolveTemplateProposal(msg.proposalId, msg.accept, {
          id: msg.id,
          agent: msg.agent,
          description: msg.description,
          model: msg.model,
          effort: msg.effort,
          prompt: msg.prompt,
          env: msg.env,
        });
        return;

      case 'startSession': {
        const session = await hub.startSession({
          workspaceId: msg.workspaceId,
          profile: msg.profile,
          model: msg.model,
          effort: msg.effort,
          prompt: msg.prompt,
          name: msg.name,
          cwd: msg.cwd,
        });
        // Back to the asker, in the ack: whoever started this agent is about
        // to want the canvas to fly to it.
        return session.id;
      }

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
        await hub.resumeSession(msg.sessionId);
        return;
      }

      case 'resumeWorkspace':
        await hub.resumeWorkspace(msg.workspaceId);
        return;

      case 'shareSession':
        // The token itself does not ride the ack: it arrives on the
        // `sharesChanged` broadcast that `hub.shareSession` triggers before
        // this even returns, the same way `saveTemplate` answers through
        // `templatesChanged` rather than the ack.
        hub.shareSession(msg.sessionId);
        return;

      case 'unshareSession':
        hub.unshareSession(msg.sessionId);
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

      case 'putNote': {
        // Broadcast the note as the hub clamped it, not as the client sent
        // it - a peer browser applying the raw message would otherwise never
        // see the size floor take effect. A non-finite write is silently
        // dropped (see hub.saveNote) rather than broadcast at all.
        const saved = hub.saveNote(msg.note);
        if (saved) broadcastExcept(socket, { t: 'noteUpserted', note: saved });
        return;
      }

      case 'removeNote':
        hub.removeNote(msg.noteId);
        broadcastExcept(socket, { t: 'noteRemoved', noteId: msg.noteId });
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

      case 'updateHost':
        hub.updateHost(msg.hostId, {
          label: msg.label,
          sshHost: msg.sshHost,
          sshUser: msg.sshUser,
          sshPort: msg.sshPort,
          privateKeyPath: msg.privateKeyPath,
        });
        return;

      case 'removeHost':
        await hub.removeHost(msg.hostId);
        return;

      case 'connectHost':
        await hub.connectHost(msg.hostId);
        return;

      case 'refreshAgents':
        // Not awaited: the answer arrives as `agentsDetected` when each
        // machine has one, and a CLI that hangs must cost a slow dropdown
        // rather than a socket sitting on a reply.
        void hub.agents.refresh();
        hub.peers.refreshAgents();
        return;

      default:
        throw new Error(`unhandled: ${(msg as { t: string }).t}`);
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

  /*
   * Detection starts here, after listen() has resolved, and is deliberately
   * not awaited. It spawns every declared CLI to ask its version and its
   * models; one of them hanging must cost a slow dropdown rather than a hub
   * that will not boot, and the browser is told through `agentsDetected` when
   * each answer lands.
   */
  void hub.agents.refresh().catch(() => {
    // Individual probes already fail softly; this is only here so a bug in
    // the detector cannot become an unhandled rejection that stops the hub.
  });

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
