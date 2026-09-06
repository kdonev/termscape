import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The packed hub, so a machine being attached has something to install.
 *
 * Built by scripts/pack-hub.mjs into dist/, which is why neither attach path
 * needs the operator to run `npm pack` by hand any more. The env var stays as
 * an override for anyone testing an unreleased build.
 */
export function hubTarballPath(): string | null {
  const override = process.env.TERMSCAPE_HUB_TARBALL;
  if (override && existsSync(override)) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'hub.tgz'), // dist/hub.tgz, beside the compiled cli
    join(here, '..', '..', 'dist', 'hub.tgz'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}
