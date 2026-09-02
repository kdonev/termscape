import { randomUUID } from 'node:crypto';
import {
  encodeInjection,
  formatMessage,
  MESSAGE_RATE_LIMIT,
  type Message,
} from '@aicanvas/protocol';
import type { Store } from '../db/store.js';
import type { SessionManager } from '../session/manager.js';
import type { ProfileRegistry } from './profiles.js';

export interface DeliveryResult {
  delivered: boolean;
  deliveredAt: number | null;
  error?: string;
}

/** Simple fixed-window counter, per sender address. */
class RateLimiter {
  private hits = new Map<string, number[]>();

  check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - MESSAGE_RATE_LIMIT.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= MESSAGE_RATE_LIMIT.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

/**
 * Delivers agent-to-agent messages.
 *
 * Delivery is immediate and unconditional by design: the text is written to
 * the target PTY the moment it arrives, whether or not that agent is mid-turn.
 * A message that lands during a turn may be swallowed by the running CLI —
 * that is a property of PTYs, not something this router hides. What it does
 * guarantee is that every attempt is recorded with its outcome, so a lost
 * message is visible in the UI rather than silent.
 */
export class MessageRouter {
  private readonly limiter = new RateLimiter();

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly profiles: ProfileRegistry,
    private readonly onMessage: (m: Message) => void,
  ) {}

  send(fromAddr: string, toAddr: string, body: string): DeliveryResult {
    const id = randomUUID();
    const sentAt = Date.now();

    const record = (state: 'delivered' | 'failed', error?: string): DeliveryResult => {
      const m: Message = {
        id,
        fromAddr,
        toAddr,
        body,
        sentAt,
        deliveredAt: state === 'delivered' ? Date.now() : null,
        deliveryState: state,
        error: error ?? null,
      };
      this.store.insertMessage(m);
      this.onMessage(m);
      return { delivered: state === 'delivered', deliveredAt: m.deliveredAt, error };
    };

    if (!this.limiter.check(fromAddr)) {
      return record(
        'failed',
        `rate limit exceeded (${MESSAGE_RATE_LIMIT.max} messages per ${
          MESSAGE_RATE_LIMIT.windowMs / 1000
        }s)`,
      );
    }

    const target = this.sessions.getByAddress(toAddr);
    if (!target) return record('failed', `no agent at address "${toAddr}"`);

    const pty = this.sessions.pty(target.id);
    if (!pty?.running) {
      return record('failed', `agent "${toAddr}" is not running (state: ${target.state})`);
    }

    const profile = this.profiles.get(target.profile);
    const mode = profile?.inject ?? 'bracketed';

    try {
      // Attribution comes from the hub's own record of who is calling, never
      // from the sender's arguments, so it cannot be spoofed.
      this.sessions.write(target.id, encodeInjection(formatMessage(fromAddr, body), mode));
      pty.markBusy();
      return record('delivered');
    } catch (err) {
      return record('failed', (err as Error).message);
    }
  }
}
