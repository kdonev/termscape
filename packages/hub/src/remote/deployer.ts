import { createServer, type Server as NetServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Client as SshClient, type ConnectConfig } from 'ssh2';

/**
 * Provisions and reaches a hub on a remote machine.
 *
 * The chosen model is a daemon on the remote host rather than an `ssh`
 * subprocess per terminal, so remote sessions survive the SSH link dropping.
 * That costs a deploy step, which is what most of this file is.
 *
 * The remote hub always binds 127.0.0.1 on its own machine. It is reachable
 * only through the tunnel opened here, so it is never exposed on a network
 * interface even briefly.
 */

export interface HostCredentials {
  sshHost: string;
  sshUser: string;
  sshPort: number;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface DeployResult {
  /** Loopback URL on *this* machine that tunnels to the remote hub. */
  localUrl: string;
  remotePort: number;
  remoteHubVersion: string;
  /** Close the tunnel and the SSH connection. */
  dispose: () => Promise<void>;
}

export interface DeployOptions extends HostCredentials {
  /** Token the remote hub will require on its /peer endpoint. */
  token: string;
  /** Local tarball produced by `npm pack`, uploaded when the remote is stale. */
  packagePath?: string;
  expectedVersion: string;
  /** Where the hub lives on the remote machine. */
  remoteDir?: string;
  log?: (line: string) => void;
}

const DEFAULT_REMOTE_DIR = '~/.termscape';

function connectConfig(c: HostCredentials): ConnectConfig {
  const cfg: ConnectConfig = {
    host: c.sshHost,
    port: c.sshPort,
    username: c.sshUser,
    readyTimeout: 20_000,
  };
  if (c.privateKeyPath) {
    cfg.privateKey = readFileSync(c.privateKeyPath);
    if (c.passphrase) cfg.passphrase = c.passphrase;
  } else {
    // Fall back to the user's running SSH agent, which is how most people
    // already authenticate; we never prompt for or store a password.
    cfg.agent = process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? 'pageant' : undefined);
  }
  return cfg;
}

export function sshConnect(c: HostCredentials): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    conn.on('ready', () => resolve(conn));
    conn.on('error', (err) => reject(new Error(`ssh ${c.sshUser}@${c.sshHost}: ${err.message}`)));
    conn.connect(connectConfig(c));
  });
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function exec(conn: SshClient, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d: Buffer) => (stdout += d.toString()));
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      stream.on('close', (code: number) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  });
}

export interface Probe {
  nodeVersion: string | null;
  nodeMajor: number;
  installedVersion: string | null;
}

/** What is already on the remote machine, before we change anything. */
export async function probe(conn: SshClient, remoteDir = DEFAULT_REMOTE_DIR): Promise<Probe> {
  const node = await exec(conn, 'node --version 2>/dev/null || true');
  const nodeVersion = node.stdout.trim() || null;
  const nodeMajor = nodeVersion ? Number(nodeVersion.replace(/^v/, '').split('.')[0]) : 0;

  const installed = await exec(
    conn,
    `cat ${remoteDir}/hub/package.json 2>/dev/null | grep '"version"' || true`,
  );
  const m = installed.stdout.match(/"version"\s*:\s*"([^"]+)"/);
  return { nodeVersion, nodeMajor, installedVersion: m?.[1] ?? null };
}

async function upload(conn: SshClient, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.fastPut(localPath, remotePath, (e) => (e ? reject(e) : resolve()));
    });
  });
}

/**
 * Install or upgrade the hub on the remote machine. Native modules are rebuilt
 * there, because node-pty and better-sqlite3 prebuilds are per platform and
 * per architecture and the remote is frequently neither.
 */
export async function provision(
  conn: SshClient,
  opts: DeployOptions,
): Promise<void> {
  const remoteDir = opts.remoteDir ?? DEFAULT_REMOTE_DIR;
  const log = opts.log ?? (() => {});
  if (!opts.packagePath) {
    throw new Error(
      'remote hub is missing or out of date and no package tarball was supplied; ' +
        'run `npm pack -w @termscape/hub` and pass its path',
    );
  }

  const tarball = basename(opts.packagePath);
  log(`uploading ${tarball}`);
  await exec(conn, `mkdir -p ${remoteDir}`);
  await upload(conn, opts.packagePath, `${remoteDir}/${tarball}`);

  log('installing on remote');
  // The dependency tree is the slowest thing to rebuild over there and the
  // tarball never carries one, so it is moved aside rather than deleted along
  // with the install it lives in.
  await exec(
    conn,
    `cd ${remoteDir} && rm -rf node_modules.kept` +
      ` && if [ -d hub/node_modules ]; then mv hub/node_modules node_modules.kept; fi` +
      ` && rm -rf hub && mkdir -p hub && tar xzf ${tarball} -C hub --strip-components=1` +
      ` && if [ -d node_modules.kept ]; then mv node_modules.kept hub/node_modules; fi`,
  );

  // What the tree already there has to match to be worth keeping: the
  // fingerprint the tarball shipped, plus the two things it cannot know - the
  // Node ABI those modules were built against, and the platform.
  const stamp =
    `"$(cat deps.fingerprint 2>/dev/null || echo none)-` +
    `$(node -p 'process.versions.node.split(".")[0] + "-" + process.platform + "-" + process.arch')"`;

  // The stamp claims the tree still works; the import confirms it does.
  // Trusting the stamp alone would trade a slow deploy for a remote hub that
  // cannot load its own modules.
  //
  // The hub's own entry rather than the two native modules, because linking
  // the whole graph is what catches a stale @termscape/protocol - a missing
  // named export is a link-time error and nothing a `require` of node-pty
  // would ever notice. Importing it starts nothing; only cli.js does.
  const reusable = await exec(
    conn,
    `cd ${remoteDir}/hub && [ -d node_modules ]` +
      ` && [ "$(cat ../deps.stamp 2>/dev/null)" = ${stamp} ]` +
      ` && node -e 'import("./dist/hub.js").catch(e => { console.error(e); process.exit(1) })'`,
  );
  if (reusable.code === 0) {
    log('dependencies unchanged; keeping the modules already there');
    return;
  }

  // A half-finished tree must not inherit the last deploy's stamp.
  await exec(conn, `rm -f ${remoteDir}/deps.stamp`);

  // And the vendored workspace package goes before npm runs. Every other
  // dependency is a registry package whose version moves when its code does;
  // @termscape/protocol is a `file:` tarball whose version stands still while
  // its code changes underneath, and npm reads the copy already in
  // node_modules as satisfying the spec and leaves last deploy's there. The
  // native modules beside it - the whole reason the tree is kept - are not
  // touched.
  await exec(conn, `rm -rf ${remoteDir}/hub/node_modules/@termscape`);

  // Prebuilt binaries first: node-pty and better-sqlite3 publish them for the
  // mainstream platforms, and downloading one beats compiling it every time.
  let install = await exec(
    conn,
    `cd ${remoteDir}/hub && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -20`,
  );
  if (install.code !== 0) {
    log('no prebuilt binaries for this platform; compiling instead');
    install = await exec(
      conn,
      `cd ${remoteDir}/hub && npm install --omit=dev --no-audit --no-fund --build-from-source 2>&1 | tail -20`,
    );
  }
  if (install.code !== 0) {
    throw new Error(
      `remote install failed (exit ${install.code}). This host has no prebuilt ` +
        `binaries and no C++ toolchain for node-pty and better-sqlite3.\n` +
        `${install.stdout}\n${install.stderr}`,
    );
  }
  await exec(conn, `cd ${remoteDir}/hub && printf '%s' ${stamp} > ../deps.stamp`);
  log('installed');
}

/**
 * Start the remote hub detached, so it outlives this SSH session — the whole
 * reason for running a daemon instead of an ssh subprocess.
 */
export async function startRemoteHub(
  conn: SshClient,
  opts: DeployOptions,
): Promise<{ port: number; version: string }> {
  const remoteDir = opts.remoteDir ?? DEFAULT_REMOTE_DIR;
  const logFile = `${remoteDir}/hub.log`;

  // Reuse an already-running daemon rather than starting a second one.
  const existing = await exec(conn, `cat ${remoteDir}/hub.port 2>/dev/null || true`);
  const existingPort = Number(existing.stdout.trim());
  if (existingPort > 0) {
    const alive = await exec(
      conn,
      `curl -s -m 2 http://127.0.0.1:${existingPort}/health || true`,
    );
    const m = alive.stdout.match(/"hubVersion"\s*:\s*"([^"]+)"/);
    if (m) return { port: existingPort, version: m[1]! };
  }

  await exec(
    conn,
    `cd ${remoteDir}/hub && TERMSCAPE_HOME=${remoteDir} nohup node dist/cli.js --headless --port 0 --token '${opts.token}' > ${logFile} 2>&1 &`,
  );

  // The CLI prints TERMSCAPE_PORT=<n> precisely so this can be parsed.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const out = await exec(conn, `grep -m1 TERMSCAPE_PORT= ${logFile} 2>/dev/null || true`);
    const m = out.stdout.match(/TERMSCAPE_PORT=(\d+)/);
    if (m) {
      const port = Number(m[1]);
      await exec(conn, `echo ${port} > ${remoteDir}/hub.port`);
      const v = await exec(conn, `curl -s -m 3 http://127.0.0.1:${port}/health || true`);
      const vm = v.stdout.match(/"hubVersion"\s*:\s*"([^"]+)"/);
      return { port, version: vm?.[1] ?? 'unknown' };
    }
  }

  const tail = await exec(conn, `tail -30 ${logFile} 2>/dev/null || true`);
  throw new Error(`remote hub did not report a port.\n${tail.stdout}`);
}

/**
 * Local TCP listener that pipes every connection through the SSH channel to
 * the remote hub's loopback port. Gives us a plain ws:// URL to hand the peer
 * client, which keeps SSH entirely out of the peer protocol.
 */
export function openTunnel(
  conn: SshClient,
  remotePort: number,
): Promise<{ localPort: number; server: NetServer }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      conn.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (err, stream) => {
        if (err) {
          socket.destroy();
          return;
        }
        socket.pipe(stream).pipe(socket);
        stream.on('error', () => socket.destroy());
        socket.on('error', () => stream.destroy());
      });
    });
    server.on('error', reject);
    // Loopback only: the tunnel entrance must not be reachable from the network.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('tunnel bind failed'));
      resolve({ localPort: addr.port, server });
    });
  });
}

/** Probe, provision if needed, start, and tunnel. */
export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const log = opts.log ?? (() => {});
  const conn = await sshConnect(opts);

  try {
    const p = await probe(conn, opts.remoteDir);
    if (!p.nodeVersion) {
      throw new Error('no node on the remote host; install Node 22 or newer there first');
    }
    if (p.nodeMajor < 22) {
      throw new Error(`remote node is ${p.nodeVersion}; this hub needs Node 22 or newer`);
    }
    log(`remote node ${p.nodeVersion}, hub ${p.installedVersion ?? 'not installed'}`);

    if (p.installedVersion !== opts.expectedVersion) {
      await provision(conn, opts);
    }

    const { port, version } = await startRemoteHub(conn, opts);
    log(`remote hub ${version} on 127.0.0.1:${port}`);

    const { localPort, server } = await openTunnel(conn, port);
    log(`tunnel ready on 127.0.0.1:${localPort}`);

    return {
      localUrl: `ws://127.0.0.1:${localPort}/peer`,
      remotePort: port,
      remoteHubVersion: version,
      dispose: async () => {
        await new Promise<void>((res) => server.close(() => res()));
        conn.end();
      },
    };
  } catch (err) {
    conn.end();
    throw err;
  }
}
