import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_PASTE_IMAGE_BYTES } from '@termscape/protocol';
import { pasteDir, savePastedImage } from '../src/session/paste-image.js';
import { removeTree } from './tmp.js';

/*
 * An image pasted into a terminal becomes a file on the machine running the
 * agent, and its path is what gets typed (issue 33). These cover the file
 * half: where it lands, what it refuses, and that old ones do not pile up.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-paste-'));
  process.env.TERMSCAPE_HOME = dir;
});

afterEach(async () => {
  delete process.env.TERMSCAPE_HOME;
  await removeTree(dir);
});

const unquote = (p: string) => p.replace(/^"(.*)"$/, '$1');

describe('savePastedImage', () => {
  it('writes the bytes under the session directory with the right extension', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const path = unquote(savePastedImage('s1', 'image/png', bytes.toString('base64')));
    expect(path.startsWith(pasteDir('s1'))).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect([...readFileSync(path)]).toEqual([...bytes]);

    expect(unquote(savePastedImage('s1', 'image/jpeg', 'AQID')).endsWith('.jpg')).toBe(true);
  });

  it('gives each paste its own file', () => {
    const a = savePastedImage('s1', 'image/png', 'AQID');
    const b = savePastedImage('s1', 'image/png', 'AQID');
    expect(a).not.toBe(b);
  });

  it('refuses a type outside the allowlist, even if the message got past zod', () => {
    expect(() => savePastedImage('s1', 'image/svg+xml' as 'image/png', 'AQID')).toThrow(/type/);
  });

  it('refuses an empty image and one over the limit', () => {
    expect(() => savePastedImage('s1', 'image/png', '')).toThrow(/empty/);
    const big = Buffer.alloc(MAX_PASTE_IMAGE_BYTES + 1).toString('base64');
    expect(() => savePastedImage('s1', 'image/png', big)).toThrow(/limit/);
  });

  it('prunes pastes older than a day, and keeps recent ones', () => {
    const pastes = pasteDir('s1');
    mkdirSync(pastes, { recursive: true });
    const old = join(pastes, 'old.png');
    const recent = join(pastes, 'recent.png');
    writeFileSync(old, 'x');
    writeFileSync(recent, 'x');
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, twoDaysAgo, twoDaysAgo);

    savePastedImage('s1', 'image/png', 'AQID');
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('quotes a path with a space so the CLI reads it as one', () => {
    process.env.TERMSCAPE_HOME = join(dir, 'with space');
    const path = savePastedImage('s1', 'image/png', 'AQID');
    expect(path.startsWith('"') && path.endsWith('"')).toBe(true);
    expect(existsSync(unquote(path))).toBe(true);
  });
});
