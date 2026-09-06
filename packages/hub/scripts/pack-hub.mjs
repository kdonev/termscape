#!/usr/bin/env node
/**
 * Packs the hub into dist/hub.tgz so the running hub can hand it to a machine
 * that wants to join.
 *
 * This is what stops attaching a host from depending on the operator knowing
 * to run `npm pack` and export TERMSCAPE_HUB_TARBALL first. Both the join
 * installer and the SSH deployer read the result.
 *
 * Two things need care:
 *
 * - `@termscape/protocol` is a private workspace package. A remote `npm install`
 *   would go looking for it in the registry and fail, so it is packed too and
 *   vendored in as a `file:` dependency.
 * - The tarball must not contain a previous copy of itself. Everything is
 *   assembled in a staging directory rather than packed from the source tree,
 *   which also means the repo's package.json is never rewritten in place.
 *
 * It also writes `deps.fingerprint`: what an installer compares to decide
 * whether the dependency tree it already has is still the right one. See
 * `depsFingerprint` below for what goes into it and why.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(pkgRoot, '..', '..');
const dist = join(pkgRoot, 'dist');
const target = join(dist, 'hub.tgz');

const LF = String.fromCharCode(10);
const VENDORED_PROTOCOL = 'vendor/termscape-protocol.tgz';

/**
 * What an installed dependency tree has to match to still be worth keeping.
 *
 * Two things go in. The dependency block, so a version change reinstalls. And
 * the *contents* of the vendored protocol package, because it is a `file:`
 * dependency whose version sits still across builds while its code changes
 * underneath - comparing versions alone would happily reuse a tree holding
 * last week's protocol.
 *
 * Contents rather than the packed tarball's bytes: npm records mtimes, so a
 * hash of the tarball would differ on every rebuild and match nothing, ever.
 *
 * The other half of the answer - the Node ABI those modules were built
 * against, and the platform - cannot be known here. The installer adds it.
 */
function depsFingerprint(dependencies, protocolDir) {
  const h = createHash('sha256');
  h.update(JSON.stringify(dependencies));
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${prefix}${entry}/`);
      } else {
        const bytes = readFileSync(full);
        h.update(`${prefix}${entry} ${bytes.length} `).update(bytes);
      }
    }
  };
  walk(join(protocolDir, 'dist'), '');
  h.update(readFileSync(join(protocolDir, 'package.json')));
  return h.digest('hex').slice(0, 32);
}

/**
 * Move a file that may be crossing a device boundary.
 *
 * The staging directories live in the OS temp dir, which is not always on the
 * same volume as the repo - on a Windows CI runner temp is C: and the checkout
 * is D:, and renameSync fails there with EXDEV rather than falling back.
 */
function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

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
  console.error('pack-hub: protocol dist missing — build @termscape/protocol first');
  process.exit(1);
}

// A leftover from an earlier run would otherwise be packed into this one.
rmSync(target, { force: true });

const staging = mkdtempSync(join(tmpdir(), 'termscape-stage-'));
const scratch = mkdtempSync(join(tmpdir(), 'termscape-pack-'));
try {
  cpSync(dist, join(staging, 'dist'), { recursive: true });
  rmSync(join(staging, 'dist', 'hub.tgz'), { force: true });

  const vendorDir = join(staging, 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  moveFile(pack(null, vendorDir, '@termscape/protocol'), join(staging, VENDORED_PROTOCOL));

  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  manifest.dependencies['@termscape/protocol'] = `file:${VENDORED_PROTOCOL}`;
  // The remote installs with --omit=dev, but leaving these in would still make
  // it resolve types packages it has no use for.
  delete manifest.devDependencies;
  // The build scripts reference files that are not in the tarball; only
  // starting the hub makes sense on the machine that receives it.
  manifest.scripts = { start: manifest.scripts.start };
  // Staging holds only what belongs in the tarball, so let npm take all of it.
  delete manifest.files;
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Read on the far side by an installer deciding whether it can keep the
  // node_modules it already has rather than spend a minute rebuilding one.
  writeFileSync(
    join(staging, 'deps.fingerprint'),
    depsFingerprint(manifest.dependencies, join(repoRoot, 'packages', 'protocol')) + LF,
  );

  mkdirSync(dist, { recursive: true });
  moveFile(pack(staging, scratch), target);
  console.log(`packed hub + protocol -> dist/hub.tgz`);
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
