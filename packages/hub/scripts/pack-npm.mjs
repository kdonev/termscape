#!/usr/bin/env node
/**
 * Builds the publishable npm package: one tarball a stranger can install with
 * `npx @kdonev/termscape`.
 *
 * The repo is a workspace monorepo of three private packages, which is not a
 * shape npm can publish. This assembles the one package that makes sense to a
 * user - the hub, plus the UI it serves, plus the protocol library it imports -
 * in a staging directory, and packs that.
 *
 * Three things need care:
 *
 * - `@termscape/protocol` is a private workspace package that will never be on
 *   the registry, so it is bundled: dropped into the staged `node_modules` and
 *   named in `bundleDependencies`, which is the one mechanism npm has for
 *   shipping a dependency inside a package rather than resolving it.
 * - The web UI is copied to `web/` beside `dist/`. In the monorepo the hub
 *   finds it as a sibling package; there are no siblings inside a published
 *   package. `webRoot()` in src/server.ts knows both layouts.
 * - `dist/hub.tgz` must survive. The hub hands that tarball to machines
 *   joining the canvas, so a published hub without it can serve a UI but can
 *   never attach a second machine. Note this is the opposite of the `files`
 *   field in packages/hub/package.json, which excludes it - that field governs
 *   `npm pack -w @termscape/hub`, which is a different artifact for a
 *   different purpose.
 *
 * Nothing here rewrites the repo's own package.json; staging holds every
 * modification.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgRoot, '..', '..');
const hubDist = join(pkgRoot, 'dist');
const webDist = join(repoRoot, 'packages', 'web', 'dist');
const protocolRoot = join(repoRoot, 'packages', 'protocol');
const outDir = join(pkgRoot, 'npm');

/** What the package is called on the registry, as opposed to in the workspace. */
const PUBLISHED_NAME = '@kdonev/termscape';
const PROTOCOL_NAME = '@termscape/protocol';

/* ----------------------------------------------------------- preconditions */

const required = [
  [join(hubDist, 'cli.js'), 'run `npm run build` first'],
  [join(hubDist, 'hub.tgz'), 'run `npm run build -w @termscape/hub` first'],
  [join(webDist, 'index.html'), 'run `npm run build -w @termscape/web` first'],
  [join(protocolRoot, 'dist', 'index.js'), 'run `npm run build -w @termscape/protocol` first'],
];
for (const [path, hint] of required) {
  if (!existsSync(path)) {
    console.error(`pack-npm: missing ${path} - ${hint}`);
    process.exit(1);
  }
}

/* -------------------------------------------------------------- staging */

const staging = mkdtempSync(join(tmpdir(), 'termscape-npm-'));
try {
  // The hub's compiled JS, hub.tgz included.
  cpSync(hubDist, join(staging, 'dist'), { recursive: true });

  // The UI, flattened: packages/web/dist -> web/
  cpSync(webDist, join(staging, 'web'), { recursive: true });

  // The protocol package, bundled rather than depended on.
  const bundled = join(staging, 'node_modules', PROTOCOL_NAME);
  mkdirSync(bundled, { recursive: true });
  cpSync(join(protocolRoot, 'dist'), join(bundled, 'dist'), { recursive: true });
  const protocolManifest = JSON.parse(
    readFileSync(join(protocolRoot, 'package.json'), 'utf8'),
  );
  // A bundled package that still says `private` is fine to install, but the
  // flag only ever meant "do not publish me on my own".
  delete protocolManifest.private;
  delete protocolManifest.devDependencies;
  delete protocolManifest.scripts;
  writeFileSync(
    join(bundled, 'package.json'),
    `${JSON.stringify(protocolManifest, null, 2)}\n`,
  );

  /* ------------------------------------------------------------ manifest */

  const hub = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  const manifest = {
    name: PUBLISHED_NAME,
    version: hub.version,
    description: hub.description,
    license: hub.license,
    author: hub.author,
    homepage: hub.homepage,
    repository: hub.repository,
    bugs: hub.bugs,
    keywords: hub.keywords,
    type: hub.type,
    bin: { termscape: './dist/cli.js' },
    engines: hub.engines,
    dependencies: { ...hub.dependencies },
    // npm needs the bundled package listed as a dependency too; the bundled
    // copy is what satisfies it, so the range is never resolved.
    bundleDependencies: [PROTOCOL_NAME],
    // Only starting the hub makes sense on an installed copy; the build
    // scripts reference sources that are not in the tarball.
    scripts: { start: 'node dist/cli.js' },
  };
  writeFileSync(
    join(staging, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // What people see on the npm page. LICENSE has to travel with the package:
  // the manifest field is a label, the file is the grant.
  cpSync(join(repoRoot, 'README.md'), join(staging, 'README.md'));
  cpSync(join(repoRoot, 'LICENSE'), join(staging, 'LICENSE'));

  /* ---------------------------------------------------------------- pack */

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  execFileSync('npm', ['pack', '--pack-destination', outDir], {
    cwd: staging,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });

  const produced = readdirSync(outDir).filter((f) => f.endsWith('.tgz'));
  if (produced.length !== 1) {
    throw new Error(`expected one tarball in ${outDir}, got ${produced.length}`);
  }
  console.log(`packed ${PUBLISHED_NAME}@${manifest.version} -> npm/${produced[0]}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
