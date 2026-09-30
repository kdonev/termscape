import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message, Session } from '@termscape/protocol';
import { recentLog } from './debug.js';
import { HUB_VERSION } from './hub.js';
import type { Hub } from './hub.js';
import { paths } from './paths.js';

/**
 * The logs behind a bug report, written to a file on this machine.
 *
 * Never attached to the issue itself: the tracker is public, and these say
 * which agents run where and who messaged whom. The person reporting decides
 * who gets the file.
 *
 * What is in it is chosen so that sending it is not a leak either. Message
 * text, terminal contents, tokens and workspace paths stay out; what is left
 * is who, when, what happened and how long it took - which is what a lost
 * message is diagnosed from. The trace lines themselves only ever carry
 * lengths and ids (see debug.ts), and the canvas token is redacted from the
 * console lines kept with them.
 */

/** How long an attached machine gets to answer, well inside a dialog's patience. */
export const PEER_EXPORT_TIMEOUT_MS = 5000;

/** One hub's half of the report, as it crosses the peer link. */
export interface HubLogs {
  hubVersion: string;
  platform: string;
  arch: string;
  node: string;
  uptimeSec: number;
  at: string;
  sessions: string[];
  messages: string[];
  log: string[];
}

/** A section of the report: a hub's logs, or why there are none. */
export interface ReportPart {
  label: string;
  logs?: HubLogs;
  error?: string;
}

const iso = (t: number | null): string => (t === null ? '-' : new Date(t).toISOString());

function describeSession(s: Session): string {
  return (
    `${s.address} profile=${s.profile} state=${s.state} status=${s.status}` +
    (s.statusText ? ` "${s.statusText}"` : '') +
    ` pid=${s.pid ?? '-'} created=${iso(s.createdAt)} lastActive=${iso(s.lastActiveAt)}` +
    (s.exitedAt ? ` exited=${iso(s.exitedAt)} code=${s.exitCode ?? '-'}` : '')
  );
}

/** A message without its text: the length is all a diagnosis needs of it. */
export function describeMessage(m: Message): string {
  return (
    `${iso(m.sentAt)} ${m.id} ${m.fromAddr} -> ${m.toAddr} (${m.body.length} chars) ` +
    m.deliveryState +
    (m.deliveredAt !== null ? ` after ${m.deliveredAt - m.sentAt}ms` : '') +
    (m.error ? ` - ${m.error}` : '')
  );
}

/** This hub's own half: what it runs, what it delivered, and what it logged. */
export function collectLocal(hub: Hub): HubLogs {
  return {
    hubVersion: HUB_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    at: new Date().toISOString(),
    sessions: hub.sessions.list().map(describeSession),
    messages: [...hub.messages()].sort((a, b) => a.sentAt - b.sentAt).map(describeMessage),
    log: recentLog(),
  };
}

function isHubLogs(v: unknown): v is HubLogs {
  const o = v as Partial<HubLogs> | null;
  return (
    !!o &&
    typeof o.hubVersion === 'string' &&
    Array.isArray(o.sessions) &&
    Array.isArray(o.messages) &&
    Array.isArray(o.log)
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer in ${ms / 1000}s`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Every machine's half, this one first.
 *
 * Attached machines are asked in parallel, each on its own clock, so one that
 * is down or too old to know the request costs the report its section and
 * nothing else.
 */
export async function collectReport(
  hub: Hub,
  timeoutMs = PEER_EXPORT_TIMEOUT_MS,
): Promise<ReportPart[]> {
  const here: ReportPart = { label: 'this machine (canvas)', logs: collectLocal(hub) };
  const hosts = hub.store.listHosts();
  const there = await Promise.all(
    hosts.map(async (host): Promise<ReportPart> => {
      const label = `${host.label} (attached, ${host.platform ?? 'unknown platform'})`;
      const peer = hub.peers.peer(host.id);
      if (!peer || !peer.connected) {
        return { label, error: `not connected (${host.state}${host.error ? `: ${host.error}` : ''})` };
      }
      try {
        const result = await withTimeout(
          peer.request({ t: 'exportLogs', id: randomUUID() }),
          timeoutMs,
          'the host',
        );
        if (!isHubLogs(result)) return { label, error: 'answered with something that is not a log' };
        return { label, logs: result };
      } catch (err) {
        return {
          label,
          error: `no answer - ${(err as Error).message} (a hub older than this export does not know the request)`,
        };
      }
    }),
  );
  return [here, ...there];
}

/** One plain-text file, readable in anything, one section per machine. */
export function formatReport(parts: ReportPart[]): string {
  const out: string[] = [
    `termscape bug report logs, written ${new Date().toISOString()}`,
    'Not for the public issue tracker. Contains agent addresses and message',
    'metadata, never message text, terminal contents or tokens.',
    '',
  ];
  for (const part of parts) {
    out.push(`${'='.repeat(78)}`, `== ${part.label}`, `${'='.repeat(78)}`);
    if (!part.logs) {
      out.push(part.error ?? 'no logs', '');
      continue;
    }
    const l = part.logs;
    out.push(
      `termscape ${l.hubVersion}, ${l.platform}/${l.arch}, node ${l.node}, ` +
        `up ${l.uptimeSec}s, as of ${l.at}`,
      '',
      `-- agents (${l.sessions.length})`,
      ...l.sessions,
      '',
      `-- messages (${l.messages.length}, text omitted)`,
      ...l.messages,
      '',
      `-- log (${l.log.length} lines)`,
      ...l.log,
      '',
    );
  }
  return out.join('\n');
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Collect, format and write the report; returns where it went. */
export async function exportLogs(hub: Hub): Promise<string> {
  const text = formatReport(await collectReport(hub));
  const dir = paths.bugReports();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `termscape-logs-${stamp(new Date())}.log`);
  writeFileSync(file, text);
  return file;
}
