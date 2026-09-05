import type { Session } from '@aicanvas/protocol';

/**
 * How a session reads at a glance. Shared by the window header and the tree
 * panel so one agent never looks like two different things in two places.
 */

/** Follows the agent's activity while it runs, its process state otherwise. */
export function statusColor(s: Session): string {
  if (s.state === 'running') return s.status === 'busy' ? '#d8b271' : '#88c07a';
  if (s.state === 'failed') return '#e06c75';
  if (s.state === 'exited') return '#4a5262';
  return '#7c8596';
}

export function statusLabel(s: Session): string {
  if (s.state !== 'running') return s.state;
  return s.status === 'busy' ? 'working' : s.status === 'idle' ? 'idle' : 'running';
}
