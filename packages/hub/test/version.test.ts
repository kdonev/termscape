import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HUB_VERSION } from '../src/hub.js';

/**
 * HUB_VERSION is a second copy of the package version, and it is not cosmetic:
 * PeerRegistry gates machine-to-machine joins on it, so a release that bumps
 * package.json and forgets the constant ships a hub that refuses to talk to
 * hubs of its own version - and the failure only shows up on a second machine,
 * which is exactly where nobody tests.
 *
 * Publishing is what makes this dangerous, so let the drift fail here instead.
 */
describe('hub version', () => {
  it('matches the version in package.json', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      readFileSync(join(here, '..', 'package.json'), 'utf8'),
    ) as { version: string };

    expect(HUB_VERSION).toBe(manifest.version);
  });
});
