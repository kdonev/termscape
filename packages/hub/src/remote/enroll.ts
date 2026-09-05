import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  PeerRequest,
  PEER_SCHEMA_VERSION,
  type Host,
  type PeerResponse,
} from '@aicanvas/protocol';
import type { Hub } from '../hub.js';
import { HUB_VERSION } from '../hub.js';
import { joinScriptPosix, joinScriptPowerShell } from './join-script.js';
import { hubTarballPath } from './tarball.js';

/**
 * The pull half of attaching a machine.
 *
 * Instead of this hub reaching out over SSH, the other machine opens this
 * hub's page, downloads an installer, runs it, and dials back. That inverts
 * who needs credentials — nobody types an SSH key here — and it puts install
 * failures in the terminal of the person who can actually fix them.
 *
 * Enrollment tokens are single-use and short-lived, and live in memory only.
 * A hub restart invalidates outstanding downloads, which is the right trade
 * for a credential that is supposed to be spent within minutes of minting.
 */

const ENROLL_TTL_MS = 15 * 60 * 1000;
/**
 * Minting is unauthenticated, so it has to be bounded. Nobody has 64 machines
 * mid-join at once; anything past that is someone hammering the page, and the
 * oldest unspent token is the safest thing to drop.
 */
const MAX_PENDING = 64;

export interface EnrollOptions {
  hub: Hub;
  /** Origin another machine can reach us on, or null when we are loopback-bound. */
  enrollOrigin: () => string | null;
}

export interface Enrollment {
  /** Mint a single-use token for one download. */
  mint(): string;
  pendingCount(): number;
}

export function registerEnrollment(
  app: FastifyInstance,
  opts: EnrollOptions,
): Enrollment {
  const { hub, enrollOrigin } = opts;
  /** token -> expiry. Single-use: matching deletes. */
  const pending = new Map<string, number>();

  function sweep(): void {
    const now = Date.now();
    for (const [token, expires] of pending) {
      if (expires <= now) pending.delete(token);
    }
  }

  function mint(): string {
    sweep();
    while (pending.size >= MAX_PENDING) {
      // Insertion-ordered, so the first key is the oldest still-unspent token.
      pending.delete(pending.keys().next().value!);
    }
    const token = randomBytes(24).toString('base64url');
    pending.set(token, Date.now() + ENROLL_TTL_MS);
    return token;
  }

  function consume(token: string): boolean {
    sweep();
    if (!pending.has(token)) return false;
    pending.delete(token);
    return true;
  }

  /* ------------------------------------------------------------- the page */

  /**
   * The one route served without the client token. It is reachable only when
   * the hub was deliberately bound off loopback, and it exposes nothing but a
   * command to copy.
   */
  app.get('/join', async (_req, reply) => {
    const origin = enrollOrigin();
    if (!origin) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(notReachablePage());
    }
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(joinPage(origin));
  });

  app.get('/join.sh', async (_req, reply) => {
    const origin = enrollOrigin();
    if (!origin) return reply.code(404).send('# this hub is not reachable from other machines\n');
    return reply
      .type('text/x-shellscript; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(joinScriptPosix(origin, mint()));
  });

  app.get('/join.ps1', async (_req, reply) => {
    const origin = enrollOrigin();
    if (!origin) return reply.code(404).send('# this hub is not reachable from other machines\n');
    return reply
      .type('text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(joinScriptPowerShell(origin, mint()));
  });

  app.get('/hub.tgz', async (_req, reply) => {
    const tarball = hubTarballPath();
    if (!tarball) {
      return reply
        .code(503)
        .send('hub package not built; run `npm run build` on the hub machine\n');
    }
    return reply.type('application/gzip').send(createReadStream(tarball));
  });

  /* --------------------------------------------------------- inbound peers */

  /**
   * A host dialling in. It speaks first, exactly as we would if we had dialled
   * it; the only difference is that its token is an enrollment or host token
   * rather than one we minted for a deploy.
   */
  app.get('/peer-in', { websocket: true }, (socket: WebSocket) => {
    let settled = false;

    const reply = (msg: PeerResponse): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const refuse = (message: string): void => {
      reply({ t: 'err', id: 'hello', message });
      socket.close();
    };

    const onHello = (raw: Buffer): void => {
      // Everything after the handshake belongs to the PeerConnection that
      // adopts this socket, not to us.
      if (settled) return;

      let parsed;
      try {
        parsed = PeerRequest.safeParse(JSON.parse(raw.toString('utf8')));
      } catch {
        return refuse('unparseable hello');
      }
      if (!parsed.success || parsed.data.t !== 'hello') {
        return refuse('expected hello');
      }
      const hello = parsed.data;

      if (hello.schemaVersion !== PEER_SCHEMA_VERSION) {
        return refuse(
          `peer schema mismatch: you speak v${hello.schemaVersion}, this hub speaks ` +
            `v${PEER_SCHEMA_VERSION}. Re-run the join command to get a matching hub.`,
        );
      }

      let host: Host | null = null;
      let issuedToken: string | undefined;

      const known = hub.store.hostByToken(hello.token);
      if (known) {
        // A host we have seen before, coming back after a restart or a drop.
        host = { ...known, hubVersion: hello.hubVersion };
        hub.store.upsertHost(host);
      } else if (consume(hello.token)) {
        if (!hello.enroll) return refuse('enrollment token used without host details');
        issuedToken = randomBytes(24).toString('base64url');
        host = {
          id: randomUUID(),
          label: hello.enroll.label,
          kind: 'enrolled',
          sshHost: null,
          sshUser: null,
          sshPort: 22,
          platform: `${hello.enroll.platform}-${hello.enroll.arch}`,
          hubVersion: hello.hubVersion,
          state: 'connecting',
          lastSeenAt: null,
          error: null,
        };
        hub.store.upsertHost({ ...host, hostToken: issuedToken });
        hub.emit('host', host);
      } else {
        return refuse('unknown or expired enrollment token; open the join page again');
      }

      settled = true;
      reply({
        t: 'welcome',
        hubVersion: HUB_VERSION,
        schemaVersion: PEER_SCHEMA_VERSION,
        ...(issuedToken ? { hostToken: issuedToken } : {}),
      });
      hub.peers.addInbound(host, socket, hello.hubVersion);
    };

    socket.on('message', onHello);
  });

  return { mint, pendingCount: () => (sweep(), pending.size) };
}

/* ------------------------------------------------------------------ pages */

const PAGE_CSS = `
  :root { color-scheme: dark; }
  body {
    margin: 0; padding: 48px 24px;
    background: #0a0c10; color: #d5dae2;
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 660px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  p.lede { color: #7c8596; margin: 0 0 32px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
       color: #7c8596; font-weight: 600; margin: 28px 0 8px; }
  pre {
    background: #12161e; border: 1px solid #262d3b; border-radius: 6px;
    padding: 12px 14px; overflow-x: auto; margin: 0;
    font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: #d5dae2;
  }
  .note { color: #7c8596; font-size: 12.5px; margin-top: 10px; }
  .warn { color: #d8b271; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
`;

function joinPage(origin: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join this canvas</title>
<style>${PAGE_CSS}</style>
<main>
  <h1>Add this machine to the canvas</h1>
  <p class="lede">Run one of these here. It installs the hub under
    <code>~/.aicanvas</code> and connects back to <code>${escapeHtml(origin)}</code>.</p>

  <h2>macOS &middot; Linux</h2>
  <pre>curl -fsSL ${escapeHtml(origin)}/join.sh | sh</pre>

  <h2>Windows (PowerShell)</h2>
  <pre>irm ${escapeHtml(origin)}/join.ps1 | iex</pre>

  <p class="note">Needs Node 22 or newer. The installer says exactly what is
    missing before it changes anything.</p>
  <p class="note warn">Each download carries its own single-use key, good for
    15 minutes. Run the command soon after copying it.</p>
</main>
`;
}

function notReachablePage(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Not reachable</title>
<style>${PAGE_CSS}</style>
<main>
  <h1>This hub is bound to loopback</h1>
  <p class="lede">Nothing outside this machine can reach it, so there is
    nothing to join yet.</p>
  <p class="note">Restart the hub with <code>--listen lan</code> to make it
    reachable on your local network, then reload this page.</p>
</main>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
