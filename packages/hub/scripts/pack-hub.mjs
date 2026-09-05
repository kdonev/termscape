#!/usr/bin/env node
/**
 * Packs the hub into dist/hub.tgz so the running hub can hand it to a machine
 * that wants to join.
 *
 * This is what stops attaching a host from depending on the operator knowing
 * to run `npm pack` and export AICANVAS_HUB_TARBALL first. Both the join
 * installer and the SSH deployer read the result.
 *
 * Two things need care:
 *
 * - `@aicanvas/protocol` is a private workspace package. A remote `npm install`
 *   would go looking for it in the registry and fail, so it is packed too and
 *   vendored in as a `file:` dependency.
 * - The tarball must not contain a previous copy of itself. Everything is
 *   assembled in a staging directory rather than packed from the source tree,
 *   which also means the repo's package.json is never rewritten in place.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgRoot, '..', '..');
const dist = join(pkgRoot, 'dist');
const target = join(dist, 'hub.tgz');

const VENDORED_PROTOCOL = 'vendor/aicanvas-protocol.tgz';

function pack(cwdOrTarget, destination, workspace) {
  const args = ['pack', '--pack-destination', destination];
  if (workspace) args.push('-w', workspace);
  else args.push(cwdOrTarget);
  execFileSync('npm', args, {
    cwd: workspace ? repoRoot : pkgRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  const produced = readdirSync(destination).filter((f) => f.endsWith('.tgz'));
  if (produced.length !== 1) {
    throw new Error(`expected one tarball in ${destination}, got ${produced.length}`);
  }
  return join(destination, produced[0]);
}

if (!existsSync(join(dist, 'cli.js'))) {
  console.error('pack-hub: dist/cli.js missing — run the TypeScript build first');
  process.exit(1);
}
if (!existsSync(join(repoRoot, 'packages', 'protocol', 'dist', 'index.js'))) {
  console.error('pack-hub: protocol dist missing — build @aicanvas/protocol first');
  process.exit(1);
}

// A leftover from an earlier run would otherwise be packed into this one.
rmSync(target, { force: true });

const staging = mkdtempSync(join(tmpdir(), 'aicanvas-stage-'));
const scratch = mkdtempSync(join(tmpdir(), 'aicanvas-pack-'));
try {
  cpSync(dist, join(staging, 'dist'), { recursive: true });
  rmSync(join(staging, 'dist', 'hub.tgz'), { force: true });

  const vendorDir = join(staging, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  renameSync(pack(null, vendorDir, '@aicanvas/protocol'), join(staging, VENDORED_PROTOCOL));

  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  manifest.dependencies['@aicanvas/protocol'] = `file:${VENDORED_PROTOCOL}`;
  // The remote installs with --omit=dev, but leaving these in would still make
  // it resolve types packages it has no use for.
  delete manifest.devDependencies;
  // The build scripts reference files that are not in the tarball; only
  // starting the hub makes sense on the machine that receives it.
  manifest.scripts = { start: manifest.scripts.start };
  // Staging holds only what belongs in the tarball, so let npm take all of it.
  delete manifest.files;
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(dist, { recursive: true });
  renameSync(pack(staging, scratch), target);
  console.log(`packed hub + protocol -> dist/hub.tgz`);
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
