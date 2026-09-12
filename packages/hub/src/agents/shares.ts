import { randomBytes } from 'node:crypto';
import type { ShareInfo } from '@termscape/protocol';
import type { Store } from '../db/store.js';

/**
 * Per-session share tokens: the mechanism behind issue 14's "share this
 * terminal by link".
 *
 * Unlike `TokenRegistry`, this is backed by the store rather than kept in
 * memory - the whole point of the feature is that a link mailed to a
 * reviewer still works after the hub restarts, until someone revokes it. The
 * validity checks that make an FK to `session` impossible (see migration 9)
 * live on `Hub`, not here: this class only knows how to mint, look up and
 * forget a token, exactly as thin a wrapper over the store as `tokens.ts` is
 * over its own map.
 */
export class Shares {
  constructor(private readonly store: Store) {}

  list(): ShareInfo[] {
    return this.store.listShares();
  }

  /** The session a token grants, or null for an unknown or revoked one. */
  resolve(token: string): string | null {
    return this.store.resolveShare(token);
  }

  /**
   * Mint a token for a session, or hand back the one it already has.
   *
   * Idempotent on purpose: clicking "share" again on a session that is
   * already shared must not invalidate a link someone already holds - the
   * unique index on `session_id` is what makes "already shared" a lookup
   * rather than a race.
   */
  share(sessionId: string): string {
    const existing = this.store.getShare(sessionId);
    if (existing) return existing.token;
    const token = randomBytes(24).toString('base64url');
    this.store.insertShare({ sessionId, token });
    return token;
  }

  unshare(sessionId: string): void {
    this.store.removeShare(sessionId);
  }
}
