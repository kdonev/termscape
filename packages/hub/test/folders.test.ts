import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { checkFolder, folderName, resolveFolder } from '../src/folders.js';
import { removeTree } from './tmp.js';

/*
 * A workspace root belongs to whichever machine it lives on, and these are
 * meant to run on that machine — never resolved in some other process's own
 * platform flavour, which is the bug issue 15 reports. The refusal cases are
 * written platform-aware: this suite runs on whatever OS the CI or the
 * developer machine actually is, and only one side of "the other platform"
 * is reachable at a time.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-folders-'));
});

afterEach(() => {
  removeTree(dir);
});

describe('resolveFolder', () => {
  it('expands a leading ~ via the home directory', () => {
    expect(resolveFolder('~')).toBe(homedir());
    expect(resolveFolder('~/dev/x')).toBe(join(homedir(), 'dev', 'x'));
  });

  it('resolves a relative path against an explicit base', () => {
    expect(resolveFolder('sub/dir', { base: dir })).toBe(join(dir, 'sub', 'dir'));
  });

  it('leaves an absolute path alone regardless of base', () => {
    expect(resolveFolder(dir, { base: join(dir, 'elsewhere') })).toBe(dir);
  });

  if (process.platform === 'win32') {
    it('refuses a path that is only absolute on a POSIX machine, naming it', () => {
      expect(() => resolveFolder('/Users/test/dev/office')).toThrow(/Linux or macOS/);
      expect(() => resolveFolder('\\Users\\test\\dev\\office')).toThrow(/Linux or macOS/);
    });

    it('still allows a genuine UNC path through', () => {
      // \\server\share is a real absolute Windows path, not a POSIX one -
      // the single-leading-slash refusal must not catch it too. `resolve`
      // itself adds the trailing separator; that normalization is not this
      // module's concern.
      expect(resolveFolder('\\\\server\\share')).toBe('\\\\server\\share\\');
    });
  } else {
    it('refuses a path that is only absolute on Windows, naming it', () => {
      expect(() => resolveFolder('C:\\Users\\test\\office')).toThrow(/Windows/);
      expect(() => resolveFolder('C:/Users/test/office')).toThrow(/Windows/);
      expect(() => resolveFolder('\\\\server\\share')).toThrow(/Windows/);
    });
  }
});

describe('checkFolder', () => {
  it('accepts a folder that exists', () => {
    expect(checkFolder(dir).path).toBe(dir);
  });

  it('refuses one that does not', () => {
    expect(() => checkFolder(join(dir, 'nope'))).toThrow(/does not exist/);
  });

  it('refuses a file, which existsSync alone would have accepted', () => {
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    expect(() => checkFolder(file)).toThrow(/not a folder/);
  });
});

describe('folderName', () => {
  it('takes the last segment after either separator', () => {
    expect(folderName('/Users/test/dev/office')).toBe('office');
    expect(folderName('C:\\Users\\test\\office')).toBe('office');
    // path.posix.basename cannot split this apart at all; this can.
    expect(folderName('C:\\Users\\test\\office\\')).toBe('office');
  });
});
