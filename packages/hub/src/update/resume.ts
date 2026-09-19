import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths.js';

/**
 * Which agents were running when a hub went down to be updated, so the hub
 * that replaces it can bring exactly those back.
 *
 * Only an update writes this. Stopping a hub by hand is a decision about the
 * agents too, and those come back stopped, as they always have.
 */

/**
 * An update that never finished - an installer that failed, a machine that
 * went to sleep halfway - must not resume agents at some unrelated start
 * days later.
 */
const MAX_AGE_MS = 30 * 60_000;

interface ResumeList {
  at: number;
  sessionIds: string[];
}

export function resumeFile(): string {
  return join(paths.home(), 'resume.json');
}

export function saveResumeList(sessionIds: string[], now = Date.now()): void {
  const list: ResumeList = { at: now, sessionIds };
  writeFileSync(resumeFile(), JSON.stringify(list));
}

/** Read and remove the list, so it is acted on once. Empty when stale or absent. */
export function takeResumeList(now = Date.now()): string[] {
  const file = resumeFile();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  rmSync(file, { force: true });
  try {
    const list = JSON.parse(raw) as Partial<ResumeList>;
    if (typeof list.at !== 'number' || now - list.at > MAX_AGE_MS) return [];
    return Array.isArray(list.sessionIds)
      ? list.sessionIds.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}
