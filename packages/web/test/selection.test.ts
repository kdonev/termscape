import { describe, expect, it } from 'vitest';
import { pickValid } from '../src/state/selection.js';

const LIST = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('pickValid', () => {
  it('keeps an id the list still has', () => {
    expect(pickValid('b', LIST)).toBe('b');
    expect(pickValid('b', LIST, true)).toBe('b');
  });

  it('drops an id the list no longer has', () => {
    expect(pickValid('gone', LIST)).toBe('');
  });

  // The case behind "unknown workspace": the hub restarted, the workspace
  // list came back without the id the picker was holding, and the next
  // startSession must not carry that id to a hub that never had it.
  it('falls back to the first entry when the control must name one', () => {
    expect(pickValid('gone', LIST, true)).toBe('a');
  });

  it('has nothing to fall back to when the list is empty', () => {
    expect(pickValid('a', [], true)).toBe('');
    expect(pickValid('a', [])).toBe('');
  });

  it('treats an unset id like a stale one', () => {
    expect(pickValid('', LIST, true)).toBe('a');
    expect(pickValid('', LIST)).toBe('');
  });
});
