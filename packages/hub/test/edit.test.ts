import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../src/hub.js';
import { removeTree } from './tmp.js';

/*
 * Renaming a workspace and correcting a host, which had nowhere to live until
 * there was a dialog to put them in. The rules worth pinning down are the ones
 * that say no: the hub is where they hold, and the dialog only repeats them.
 */

let dir: string;
let hub: Hub;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termscape-edit-'));
  process.env.TERMSCAPE_HOME = dir;
  hub = new Hub({ dbPath: join(dir, 'state.db') });
});

afterEach(() => {
  hub.shutdown();
  delete process.env.TERMSCAPE_HOME;
  removeTree(dir);
});

const folder = (name: string): string => {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
};

describe('editing a workspace', () => {
  it('renames it, slugifying the way create does', () => {
    const ws = hub.createWorkspace('one', folder('one'));
    const after = hub.updateWorkspace(ws.id, { name: 'The Other One' });
    expect(after.name).toBe('the-other-one');
    expect(hub.store.getWorkspace(ws.id)?.name).toBe('the-other-one');
  });

  it('repoints the folder, and refuses one that is not there', () => {
    const ws = hub.createWorkspace('one', folder('one'));
    const moved = folder('elsewhere');
    expect(hub.updateWorkspace(ws.id, { rootPath: moved }).rootPath).toBe(moved);
    expect(() => hub.updateWorkspace(ws.id, { rootPath: join(dir, 'nope') })).toThrow(
      /does not exist/,
    );
    // The refusal left the row alone rather than half-applying.
    expect(hub.store.getWorkspace(ws.id)?.rootPath).toBe(moved);
  });

  it('refuses a name another workspace already has', () => {
    hub.createWorkspace('taken', folder('taken'));
    const ws = hub.createWorkspace('mine', folder('mine'));
    expect(() => hub.updateWorkspace(ws.id, { name: 'taken' })).toThrow(/already exists/);
  });

  it('is a no-op when nothing actually changed', () => {
    const ws = hub.createWorkspace('same', folder('same'));
    const after = hub.updateWorkspace(ws.id, { name: ws.name, rootPath: ws.rootPath });
    expect(after).toEqual(ws);
  });

  it('refuses a rename while agents here still hold the old address', async () => {
    // The name is the first segment of every address in the workspace, and
    // those are on the session rows, in each agent's brief, and held by peers.
    // Renaming under them would change what they were told they are called.
    const ws = hub.createWorkspace('crew', folder('crew'));
    await hub.startSession({ workspaceId: ws.id, profile: 'shell' });

    expect(() => hub.updateWorkspace(ws.id, { name: 'renamed' })).toThrow(/cannot rename/);
    expect(hub.store.getWorkspace(ws.id)?.name).toBe('crew');

    // The folder is not part of an address, so it moves either way.
    const moved = folder('crew-moved');
    expect(hub.updateWorkspace(ws.id, { rootPath: moved }).rootPath).toBe(moved);

    for (const s of hub.sessions.list()) hub.sessions.remove(s.id);
    expect(hub.updateWorkspace(ws.id, { name: 'renamed' }).name).toBe('renamed');
  }, 30_000);
});

describe('editing a machine', () => {
  const ssh = () =>
    hub.addHost({ label: 'box', sshHost: 'box.local', sshUser: 'me', sshPort: 22 });

  it('corrects the details it was added with', () => {
    const host = ssh();
    const after = hub.updateHost(host.id, {
      label: 'the box',
      sshHost: '10.0.0.9',
      sshUser: 'root',
      sshPort: 2200,
    });
    expect(after).toMatchObject({
      label: 'the box',
      sshHost: '10.0.0.9',
      sshUser: 'root',
      sshPort: 2200,
    });
    expect(hub.store.getHost(host.id)).toMatchObject({ sshHost: '10.0.0.9', sshPort: 2200 });
  });

  it('keeps the key it was given unless told otherwise', () => {
    const host = hub.addHost({
      label: 'keyed',
      sshHost: 'k',
      sshUser: 'u',
      sshPort: 22,
      privateKeyPath: '/keys/id_ed25519',
    });
    hub.updateHost(host.id, { label: 'renamed' });
    expect(hub.store.hostKeyRef(host.id)).toBe('/keys/id_ed25519');
    // Empty is the only way to say "back to the ssh agent"; the deployer reads
    // it as falsy and stops passing a key file.
    hub.updateHost(host.id, { privateKeyPath: '' });
    expect(hub.store.hostKeyRef(host.id)).toBe('');
  });

  it('will not leave an ssh host without a user or a host', () => {
    const host = ssh();
    expect(() => hub.updateHost(host.id, { sshHost: '   ' })).toThrow(/needs a user and a host/);
    expect(hub.store.getHost(host.id)?.sshHost).toBe('box.local');
  });

  it('refuses ssh details on a machine that joined by itself', () => {
    // An enrolled host is reached over the socket it opened. Storing ssh
    // details for it would be storing something nothing ever reads.
    const enrolled = {
      id: 'enrolled-1',
      label: 'joined',
      kind: 'enrolled' as const,
      sshHost: null,
      sshUser: null,
      sshPort: 22,
      platform: 'linux-x64',
      hubVersion: '0.1.0',
      state: 'connected' as const,
      lastSeenAt: null,
      error: null,
    };
    hub.store.upsertHost(enrolled);
    expect(() => hub.updateHost(enrolled.id, { sshHost: 'nope' })).toThrow(/no ssh details/);
    expect(hub.updateHost(enrolled.id, { label: 'renamed' }).label).toBe('renamed');
  });

  it('refuses an unknown id rather than creating one', () => {
    expect(() => hub.updateHost('nope', { label: 'x' })).toThrow(/unknown host/);
    expect(() => hub.updateWorkspace('nope', { name: 'x' })).toThrow(/unknown workspace/);
  });
});
