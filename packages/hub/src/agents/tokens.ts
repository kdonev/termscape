import { randomBytes } from 'node:crypto';

/**
 * Per-agent bearer tokens.
 *
 * This is the load-bearing piece of the messaging security model: the hub
 * resolves an MCP caller to a session by its token, so `send_message` always
 * knows who is really calling and an agent cannot claim to be someone else.
 *
 * Tokens are in-memory only and minted fresh on every launch. A resumed
 * session gets a new token, so a token leaked from an old run is dead.
 */
export class TokenRegistry {
  private readonly bySession = new Map<string, string>();
  private readonly toSession = new Map<string, string>();

  mint(sessionId: string): string {
    this.revoke(sessionId);
    const token = randomBytes(24).toString('base64url');
    this.bySession.set(sessionId, token);
    this.toSession.set(token, sessionId);
    return token;
  }

  get(sessionId: string): string | null {
    return this.bySession.get(sessionId) ?? null;
  }

  resolve(token: string): string | null {
    return this.toSession.get(token) ?? null;
  }

  revoke(sessionId: string): void {
    const prev = this.bySession.get(sessionId);
    if (prev) this.toSession.delete(prev);
    this.bySession.delete(sessionId);
  }
}

/** The single token the browser UI presents on the WebSocket. */
export function mintClientToken(): string {
  return randomBytes(24).toString('base64url');
}
