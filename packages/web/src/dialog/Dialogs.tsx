import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AckableMsg } from '@termscape/protocol';
import { useStore, type DialogSpec } from '../state/store.js';
import { pickValid } from '../state/selection.js';
import { agentDetail, agentsOn, startable } from '../state/agents.js';
import { sessionsIn } from '../state/tree.js';
import { Dialog, DialogForm, Field } from './Dialog.js';
import { JoinInstructions, SshForm } from './MachineForms.js';

/**
 * The one dialog that is up, if any.
 *
 * Mounted once at the top of the app rather than by whichever node opened it:
 * a node that scrolls out of the tree, or a workspace the hub removes while
 * you are editing it, would otherwise unmount the dialog mid-edit.
 */
export function Dialogs() {
  const spec = useStore((s) => s.dialog);
  if (!spec) return null;
  // Keyed so switching from one node's dialog to another's remounts rather
  // than reusing the fields, which would carry the last node's text over.
  return <Body key={keyOf(spec)} spec={spec} />;
}

function keyOf(spec: DialogSpec): string {
  switch (spec.kind) {
    case 'addWorkspace':
      return `addWorkspace:${spec.hostId ?? ''}`;
    case 'editWorkspace':
      return `editWorkspace:${spec.workspaceId}`;
    case 'startAgent':
      return `startAgent:${spec.workspaceId}`;
    case 'addMachine':
      return 'addMachine';
    case 'editMachine':
      return `editMachine:${spec.hostId}`;
    case 'confirm':
      return `confirm:${spec.title}`;
  }
}

function Body({ spec }: { spec: DialogSpec }) {
  switch (spec.kind) {
    case 'addWorkspace':
      return <AddWorkspaceDialog hostId={spec.hostId} />;
    case 'editWorkspace':
      return <EditWorkspaceDialog workspaceId={spec.workspaceId} />;
    case 'startAgent':
      return <StartAgentDialog workspaceId={spec.workspaceId} />;
    case 'addMachine':
      return <AddMachineDialog />;
    case 'editMachine':
      return <EditMachineDialog hostId={spec.hostId} />;
    case 'confirm':
      return <ConfirmDialog spec={spec} />;
  }
}

/** Everything here sends through the acknowledged path, never fire-and-forget. */
function useRequest(): (msg: AckableMsg) => Promise<void> {
  const client = useStore((s) => s.client);
  return (msg) =>
    client ? client.request(msg) : Promise.reject(new Error('not connected to the hub'));
}

/* ------------------------------------------------------------ workspaces */

function AddWorkspaceDialog({ hostId }: { hostId: string | null }) {
  const request = useRequest();
  const hosts = useStore((s) => s.hosts);
  const host = hostId ? (hosts.find((h) => h.id === hostId) ?? null) : null;
  const where = host ? host.label : 'this machine';
  // A workspace on an unreachable machine could not start anything, and
  // offering it would only fail later.
  const reachable = !host || host.state === 'connected';

  const [path, setPath] = useState('');
  const [name, setName] = useState('');

  return (
    <Dialog title={`Add a workspace on ${where}`}>
      <DialogForm
        submitLabel="add workspace"
        canSubmit={path.trim().length > 0 && reachable}
        onSubmit={() =>
          request({
            t: 'createWorkspace',
            name: name.trim() || path.trim(),
            rootPath: path.trim(),
            hostId,
          })
        }
      >
        <Field
          label="folder"
          hint={
            host
              ? `A path as ${host.label} sees it; this machine cannot check it exists.`
              : 'An absolute path, or one relative to where the hub was started.'
          }
        >
          <input
            className="input"
            placeholder={host ? `folder path on ${host.label}` : 'folder path'}
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
        </Field>
        <Field
          label="name"
          hint="Optional, and lowercased and hyphenated because it becomes the first half of every agent address here. Taken from the folder if you leave it."
        >
          <input
            className="input"
            placeholder="from the folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {!reachable && (
          <p className="dialog-note">
            {where} is {host?.state ?? 'not connected'}. Connect it before adding a
            workspace there.
          </p>
        )}
      </DialogForm>
    </Dialog>
  );
}

/**
 * Editing a workspace, which did not exist before there was anywhere to put
 * the form. The rename is the interesting half: the name is the first segment
 * of every agent address in the workspace, so the hub refuses it while agents
 * are still here, and this says so before you type rather than after.
 */
function EditWorkspaceDialog({ workspaceId }: { workspaceId: string }) {
  const request = useRequest();
  const { workspaces, sessions } = useStore(
    useShallow((s) => ({ workspaces: s.workspaces, sessions: s.sessions })),
  );
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const here = workspace ? sessionsIn(workspace, sessions) : [];

  const [name, setName] = useState(workspace?.name ?? '');
  const [path, setPath] = useState(workspace?.rootPath ?? '');

  if (!workspace) return <Gone what="workspace" />;

  const locked = here.length > 0;
  const changed = name.trim() !== workspace.name || path.trim() !== workspace.rootPath;

  return (
    <Dialog title={`Edit ${workspace.name}`}>
      <DialogForm
        submitLabel="save"
        canSubmit={changed && name.trim().length > 0 && path.trim().length > 0}
        onSubmit={() =>
          request({
            t: 'updateWorkspace',
            workspaceId,
            name: name.trim(),
            rootPath: path.trim(),
          })
        }
      >
        <Field
          label="name"
          hint={
            locked
              ? `Locked: ${here.length} agent${here.length === 1 ? '' : 's'} here are addressed as ${workspace.name}/…, so renaming would change what they were told they are called. Remove them first.`
              : 'The first half of every agent address here.'
          }
        >
          <input
            className="input"
            value={name}
            disabled={locked}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="folder"
          hint="Agents already running keep the folder they started in; this is where the next ones begin."
        >
          <input className="input" value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

/**
 * Starting an agent, from the list the machine that will run it actually has.
 *
 * The picker used to be one global list of whatever agents.toml declared,
 * installed or not, on this machine or another. Both halves of that were
 * wrong: a host has its own PATH, and starting an agent it does not have
 * failed at launch inside a terminal window, where the error reads like the
 * hub is broken.
 */
function StartAgentDialog({ workspaceId }: { workspaceId: string }) {
  const request = useRequest();
  const { workspaces, profiles, hostProfiles } = useStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      profiles: s.profiles,
      hostProfiles: s.hostProfiles,
    })),
  );
  const client = useStore((s) => s.client);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const hostId = workspace?.hostId ?? null;
  const agents = agentsOn(hostId, profiles, hostProfiles);

  const [profile, setProfile] = useState('claude');
  const offered = agents.filter(startable);
  const active = pickValid(
    profile,
    offered.map((a) => ({ id: a.id })),
    true,
  );
  const chosen = agents.find((a) => a.id === active);
  const missing = agents.filter((a) => a.available === false);

  return (
    <Dialog title={`Start an agent in ${workspace?.name ?? 'this workspace'}`}>
      <DialogForm
        submitLabel="start"
        canSubmit={Boolean(active)}
        onSubmit={() => request({ t: 'startSession', workspaceId, profile: active })}
      >
        <Field label="agent" hint={chosen ? agentDetail(chosen) : undefined}>
          <select className="input" value={active} onChange={(e) => setProfile(e.target.value)}>
            {offered.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
                {a.version ? ` — ${a.version}` : ''}
              </option>
            ))}
          </select>
        </Field>

        {/* Read-only for now: which models exist is this feature, and
            choosing one per agent is what templates are for. Showing them is
            still the difference between typing a model from memory and
            knowing what the CLI will accept. */}
        {chosen && chosen.models.length > 0 && (
          <Field
            label="models it offers"
            hint={
              chosen.modelSource === 'listed'
                ? `${chosen.models.length} listed by ${chosen.id} itself.`
                : `Declared, not enumerated: ${chosen.id} has no listing command, and it takes full model names too.`
            }
          >
            <div className="model-list">
              {chosen.models.slice(0, 200).map((m) => (
                <code key={m}>{m}</code>
              ))}
            </div>
          </Field>
        )}

        {missing.length > 0 && (
          <p className="dialog-note">
            Not on{' '}
            {hostId ? "that machine's" : "this machine's"} PATH:{' '}
            {missing.map((a) => a.command).join(', ')}.
          </p>
        )}

        <p className="dialog-note">
          {workspace ? `Runs in ${workspace.rootPath}. ` : ''}
          <button
            className="link"
            type="button"
            onClick={() => client?.send({ t: 'refreshAgents' })}
          >
            check again
          </button>{' '}
          if you have just installed one.
        </p>
      </DialogForm>
    </Dialog>
  );
}

/* --------------------------------------------------------------- machines */

function AddMachineDialog() {
  const [tab, setTab] = useState<'join' | 'ssh'>('join');

  return (
    <Dialog title="Add a machine">
      <div className="dialog-tabs">
        <button
          type="button"
          className={`tab ${tab === 'join' ? 'on' : ''}`}
          onClick={() => setTab('join')}
        >
          join from that machine
        </button>
        <button
          type="button"
          className={`tab ${tab === 'ssh' ? 'on' : ''}`}
          onClick={() => setTab('ssh')}
        >
          deploy over ssh
        </button>
      </div>
      {tab === 'join' ? <JoinInstructions /> : <SshForm />}
    </Dialog>
  );
}

/**
 * Fixing a host's details, the other thing there was nowhere to put. An
 * enrolled host dialled us and has no ssh details to correct, so it gets the
 * label and an explanation rather than four disabled inputs.
 */
function EditMachineDialog({ hostId }: { hostId: string }) {
  const request = useRequest();
  const hosts = useStore((s) => s.hosts);
  const host = hosts.find((h) => h.id === hostId);

  const [label, setLabel] = useState(host?.label ?? '');
  const [sshHost, setSshHost] = useState(host?.sshHost ?? '');
  const [sshUser, setSshUser] = useState(host?.sshUser ?? '');
  const [sshPort, setSshPort] = useState(String(host?.sshPort ?? 22));

  if (!host) return <Gone what="machine" />;

  const ssh = host.kind === 'ssh';

  return (
    <Dialog title={`Edit ${host.label}`}>
      <DialogForm
        submitLabel="save"
        canSubmit={
          label.trim().length > 0 &&
          (!ssh || (sshHost.trim().length > 0 && sshUser.trim().length > 0))
        }
        onSubmit={() =>
          request(
            ssh
              ? {
                  t: 'updateHost',
                  hostId,
                  label: label.trim(),
                  sshHost: sshHost.trim(),
                  sshUser: sshUser.trim(),
                  sshPort: Number(sshPort) || 22,
                }
              : { t: 'updateHost', hostId, label: label.trim() },
          )
        }
      >
        <Field label="label" hint="What this machine is called on the canvas.">
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>

        {ssh ? (
          <>
            <div className="dialog-row">
              <Field label="user">
                <input
                  className="input"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                />
              </Field>
              <Field label="host">
                <input
                  className="input"
                  value={sshHost}
                  onChange={(e) => setSshHost(e.target.value)}
                />
              </Field>
              <Field label="port">
                <input
                  className="input tiny"
                  value={sshPort}
                  onChange={(e) => setSshPort(e.target.value)}
                />
              </Field>
            </div>
            <p className="dialog-note">
              Saving does not reconnect. Fix the details here, then use{' '}
              <em>reconnect</em> on the machine — which is usually why you are here.
            </p>
          </>
        ) : (
          <p className="dialog-note">
            {host.label} joined by itself and is reached over the connection it opened,
            so it has no ssh details to correct.
          </p>
        )}
      </DialogForm>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- confirm */

/**
 * Destructive confirmations, which were window.confirm - a native box that
 * looks like nothing else here and has no room to say what it is about to
 * take with it.
 */
function ConfirmDialog({ spec }: { spec: Extract<DialogSpec, { kind: 'confirm' }> }) {
  const request = useRequest();
  return (
    <Dialog title={spec.title}>
      <DialogForm submitLabel={spec.confirmLabel} danger onSubmit={() => request(spec.send)}>
        <p className="dialog-note">{spec.body}</p>
      </DialogForm>
    </Dialog>
  );
}

/**
 * The row this dialog was opened on has since been removed - by the hub, or
 * from another browser tab. Saying so beats an empty form that cannot submit.
 */
function Gone({ what }: { what: string }) {
  const closeDialog = useStore((s) => s.closeDialog);
  return (
    <Dialog title={`That ${what} is gone`}>
      <div className="dialog-body">
        <p className="dialog-note">It was removed while this was open.</p>
        <footer className="dialog-actions">
          <button className="btn primary" type="button" onClick={closeDialog}>
            close
          </button>
        </footer>
      </div>
    </Dialog>
  );
}
