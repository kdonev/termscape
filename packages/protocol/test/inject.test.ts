import { describe, expect, it } from 'vitest';
import {
  encodeInjection,
  formatMessage,
  sanitizeMessageBody,
  PASTE_START,
  PASTE_END,
  uniqueName,
  parseAddress,
  makeAddress,
  slugify,
  encodeBinaryFrame,
  decodeBinaryFrame,
  BinaryFrameKind,
} from '../src/index.js';

describe('injection encoding', () => {
  it('frames a body in bracketed paste and submits it', () => {
    const out = encodeInjection('hello world', 'bracketed');
    expect(out).toBe(`${PASTE_START}hello world${PASTE_END}\r`);
  });

  it('raw mode submits without paste framing', () => {
    expect(encodeInjection('ls -la', 'raw')).toBe('ls -la\r');
  });

  it('keeps a multi-line body inside a single paste', () => {
    const out = encodeInjection('line one\nline two', 'bracketed');
    // Exactly one start and one end: the body must arrive atomically, not as
    // two separate submitted lines.
    expect(out.split(PASTE_START)).toHaveLength(2);
    expect(out.split(PASTE_END)).toHaveLength(2);
    expect(out.indexOf('\r')).toBe(out.length - 1);
  });

  it('strips a paste terminator so a body cannot escape its own framing', () => {
    // Without sanitizing, this would close the paste early and let "rm -rf /"
    // be interpreted as typed keystrokes.
    const evil = `innocent${PASTE_END}rm -rf /`;
    const out = encodeInjection(evil, 'bracketed');

    // Exactly one terminator survives, and it is the framing's own.
    expect(out.split(PASTE_END)).toHaveLength(2);
    expect(out.endsWith(`${PASTE_END}\r`)).toBe(true);

    // The body region carries no escape at all, so the neutered terminator is
    // inert literal text rather than a control sequence.
    const body = out.slice(PASTE_START.length, out.length - PASTE_END.length - 1);
    expect(body).not.toContain('\x1b');
    expect(body).toBe('innocent[201~rm -rf /');
  });

  it('strips embedded CR so a body cannot submit early', () => {
    const out = encodeInjection('first\rsecond', 'bracketed');
    expect(out.indexOf('\r')).toBe(out.length - 1);
  });

  it('removes escape sequences and control characters', () => {
    expect(sanitizeMessageBody('a\x1b[31mred\x00\x07b')).toBe('a[31mredb');
  });

  it('attribution is part of the injected body', () => {
    expect(formatMessage('api/reviewer-1', 'take a look')).toBe(
      '[from api/reviewer-1] take a look',
    );
  });
});

describe('addressing', () => {
  it('round-trips workspace and name', () => {
    const a = makeAddress('api', 'reviewer-1');
    expect(a).toBe('api/reviewer-1');
    expect(parseAddress(a)).toEqual({ workspace: 'api', name: 'reviewer-1' });
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['', 'noslash', '/leading', 'trailing/', 'a/b/c']) {
      expect(parseAddress(bad)).toBeNull();
    }
  });

  it('suffixes on collision, deterministically', () => {
    expect(uniqueName('claude', [])).toBe('claude');
    expect(uniqueName('claude', ['claude'])).toBe('claude-2');
    expect(uniqueName('claude', ['claude', 'claude-2'])).toBe('claude-3');
    // Same inputs must always give the same name, so restore is reproducible.
    expect(uniqueName('claude', ['claude', 'claude-2'])).toBe('claude-3');
  });

  it('slugifies arbitrary names into address-safe segments', () => {
    expect(slugify('Code Reviewer #2!')).toBe('code-reviewer-2');
    expect(slugify('!!!')).toBe('agent');
  });
});

describe('binary framing', () => {
  it('round-trips a pty frame', () => {
    const payload = new TextEncoder().encode('hello [32mgreen[0m');
    const frame = encodeBinaryFrame(BinaryFrameKind.PtyOutput, 'sess-123', payload);
    const out = decodeBinaryFrame(frame);
    expect(out.kind).toBe(BinaryFrameKind.PtyOutput);
    expect(out.sessionId).toBe('sess-123');
    expect(new TextDecoder().decode(out.payload)).toBe(
      'hello [32mgreen[0m',
    );
  });

  it('rejects a truncated frame rather than returning garbage', () => {
    expect(() => decodeBinaryFrame(new Uint8Array([1]))).toThrow();
    expect(() => decodeBinaryFrame(new Uint8Array([1, 40, 65]))).toThrow();
  });
});
