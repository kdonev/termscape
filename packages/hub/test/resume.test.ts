import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.js';
import { resumeFile, saveResumeList, takeResumeList } from '../src/update/resume.js';
import { removeTree } from './tmp.js';

/*
 * An update restarts the hub, and the agents running on it go down with it.
 * The hub that replaces it brings back exactly those - not the ones that were
 * already stopped, and not after a restart nobody asked to resume from.
 */

let dir: string;
let hub: Hub;

const open = (): Hub => {
  const h = new Hub({ dbPath: join(dir, 'state.db') });
  h.on('error', () => {});
  return h;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-resume-'));
  process.env.TERMSCAPE_HOME = dir;
  writeFileSync(join(dir, 'agents.toml'), '');
  hub = open();
});

afterEach(async () => {
  hub.shutdown();
  delete process.env.TERMSCAPE_HOME;
  await removeTree(dir);
});

describe('the resume list', () => {
  it('is read once', () => {
    saveResumeList(['a', 'b']);
    expect(takeResumeList()).toEqual(['a', 'b']);
    expect(existsSync(resumeFile())).toBe(false);
    expect(takeResumeList()).toEqual([]);
  });

  it('is ignored when an update never finished', () => {
    saveResumeList(['a'], Date.now() - 60 * 60_000);
    expect(takeResumeList()).toEqual([]);
  });
});

describe('restarting for an update', () => {
  it(
    'resumes the agents that were running, and only those',
    async () => {
      const root = join(dir, 'crew');
      mkdirSync(root);
      const ws = hub.createWorkspace('crew', root);
      const running = await hub.startSession({ workspaceId: ws.id, profile: 'shell', name: 'a' });
      const stopped = await hub.startSession({ workspaceId: ws.id, profile: 'shell', name: 'b' });
      hub.sessions.stop(stopped.id);

      hub.rememberRunning();
      hub.shutdown();
      hub = open();
      expect(hub.sessions.get(running.id)?.state).not.toBe('running');

      const resumed = await hub.resumeRemembered();
      expect(resumed).toEqual(['crew/a']);
      expect(hub.sessions.get(running.id)?.state).toMatch(/starting|running/);
      expect(hub.sessions.get(stopped.id)?.state).not.toMatch(/starting|running/);
    },
    60_000,
  );

  it(
    'leaves everything stopped after an ordinary restart',
    async () => {
      const root = join(dir, 'plain');
      mkdirSync(root);
      const ws = hub.createWorkspace('plain', root);
      const s = await hub.startSession({ workspaceId: ws.id, profile: 'shell', name: 'a' });

      hub.shutdown();
      hub = open();
      expect(await hub.resumeRemembered()).toEqual([]);
      expect(hub.sessions.get(s.id)?.state).not.toMatch(/starting|running/);
    },
    60_000,
  );
});
