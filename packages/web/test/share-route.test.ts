import { describe, expect, it } from 'vitest';
import { shareTokenFromPath } from '../src/share/route.js';

describe('shareTokenFromPath', () => {
  it('reads the token out of a /t/<token> path', () => {
    expect(shareTokenFromPath('/t/abc123')).toBe('abc123');
  });

  it('tolerates a trailing slash', () => {
    expect(shareTokenFromPath('/t/abc123/')).toBe('abc123');
  });

  it('decodes a URL-encoded token', () => {
    expect(shareTokenFromPath('/t/abc%2F123')).toBe('abc/123');
  });

  it('is null for the ordinary canvas route', () => {
    expect(shareTokenFromPath('/')).toBeNull();
  });

  it('is null for a path that merely starts with /t', () => {
    expect(shareTokenFromPath('/team')).toBeNull();
    expect(shareTokenFromPath('/t')).toBeNull();
    expect(shareTokenFromPath('/t/')).toBeNull();
  });

  it('is null for anything nested past the token', () => {
    expect(shareTokenFromPath('/t/abc123/extra')).toBeNull();
  });
});
