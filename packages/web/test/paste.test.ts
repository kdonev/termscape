import { afterEach, describe, expect, it, vi } from 'vitest';
import { pasteChord, pastedImage, toBase64, type KeyLike } from '../src/window/paste.js';
import { readClipboardContent } from '../src/window/clipboard.js';

/*
 * Every key and click that means paste has to carry an image too (issue 33).
 * These pin which keys are taken over from xterm, and how a paste's image is
 * found - without a DOM, which the web tests do not have.
 */

const key = (over: Partial<KeyLike>): KeyLike => ({
  type: 'keydown',
  key: 'v',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe('pasteChord', () => {
  it('lets Ctrl+V through to the browser, keeping ^V for an empty clipboard', () => {
    expect(pasteChord(key({ ctrlKey: true }), false)).toEqual({ route: 'native', fallback: '\x16' });
    expect(pasteChord(key({ ctrlKey: true, key: 'V' }), false)?.route).toBe('native');
  });

  it('lets Shift+Insert through to the browser', () => {
    expect(pasteChord(key({ key: 'Insert', shiftKey: true }), false)).toEqual({ route: 'native' });
    expect(pasteChord(key({ key: 'Insert', shiftKey: true }), true)).toEqual({ route: 'native' });
  });

  it('reads the clipboard itself for Ctrl+Shift+V, whose native paste strips images', () => {
    expect(pasteChord(key({ ctrlKey: true, shiftKey: true, key: 'V' }), false)).toEqual({
      route: 'async',
    });
  });

  it('leaves everything else to xterm', () => {
    expect(pasteChord(key({}), false)).toBeNull();
    expect(pasteChord(key({ ctrlKey: true, type: 'keyup' }), false)).toBeNull();
    expect(pasteChord(key({ ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(pasteChord(key({ ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(pasteChord(key({ key: 'Insert' }), false)).toBeNull();
    expect(pasteChord(key({ key: 'Insert', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    // On a Mac Cmd+V already pastes natively, and Ctrl+V is ^V.
    expect(pasteChord(key({ ctrlKey: true }), true)).toBeNull();
    expect(pasteChord(key({ metaKey: true }), true)).toBeNull();
  });
});

const item = (kind: string, type: string) => ({
  kind,
  type,
  getAsFile: () => (kind === 'file' ? ({ type } as unknown as File) : null),
});

describe('pastedImage', () => {
  it('finds an image among the items', () => {
    const got = pastedImage({ items: [item('string', 'text/plain'), item('file', 'image/png')] });
    expect(got?.type).toBe('image/png');
  });

  it('is null for text, an unsupported type, or no clipboard data', () => {
    expect(pastedImage({ items: [item('string', 'text/plain')] })).toBeNull();
    expect(pastedImage({ items: [item('file', 'image/svg+xml')] })).toBeNull();
    expect(pastedImage({ items: [item('file', 'application/pdf')] })).toBeNull();
    expect(pastedImage(null)).toBeNull();
  });
});

describe('toBase64', () => {
  it('matches Buffer for every byte value and across chunk boundaries', () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('readClipboardContent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const clip = (types: Record<string, Blob>) => ({
    types: Object.keys(types),
    getType: async (t: string) => types[t]!,
  });

  it('prefers an image over text', async () => {
    const png = new Blob(['x'], { type: 'image/png' });
    vi.stubGlobal('navigator', {
      clipboard: { read: async () => [clip({ 'text/plain': new Blob(['hi']), 'image/png': png })] },
    });
    expect(await readClipboardContent()).toEqual({ image: png });
  });

  it('returns text when there is no image', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { read: async () => [clip({ 'text/plain': new Blob(['hi']) })] },
    });
    expect(await readClipboardContent()).toEqual({ text: 'hi' });
  });

  it('falls back to readText when read is missing or refused', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: async () => 'plain' } });
    expect(await readClipboardContent()).toEqual({ text: 'plain' });

    vi.stubGlobal('navigator', {
      clipboard: {
        read: async () => {
          throw new Error('denied');
        },
        readText: async () => 'plain',
      },
    });
    expect(await readClipboardContent()).toEqual({ text: 'plain' });
  });

  it('is null when the clipboard cannot be read at all', async () => {
    vi.stubGlobal('navigator', {});
    expect(await readClipboardContent()).toBeNull();
  });
});
