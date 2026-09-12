import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  TemplateProposal,
  AckableMsg,
  AgentProfileInfo,
  AgentTemplateInfo,
} from '@termscape/protocol';
import { useStore, type DialogSpec } from '../state/store.js';
import { pickValid } from '../state/selection.js';
import { agentDetail, agentsOn, startableAgent } from '../state/agents.js';
import { sessionsIn } from '../state/tree.js';
import type { RequestResult } from '../net/client.js';
import { writeClipboard } from '../window/clipboard.js';
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
    case 'saveTemplate':
      return `saveTemplate:${spec.id ?? '(new)'}`;
    case 'reviewTemplate':
      return `reviewTemplate:${spec.proposalId}`;
    case 'addMachine':
      return 'addMachine';
    case 'editMachine':
      return `editMachine:${spec.hostId}`;
    case 'share':
      return `share:${spec.sessionId}`;
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
    case 'saveTemplate':
      return <TemplateDialog id={spec.id} />;
    case 'reviewTemplate':
      return <ReviewTemplateDialog proposalId={spec.proposalId} />;
    case 'addMachine':
      return <AddMachineDialog />;
    case 'editMachine':
      return <EditMachineDialog hostId={spec.hostId} />;
    case 'share':
      return <ShareDialog sessionId={spec.sessionId} />;
    case 'confirm':
      return <ConfirmDialog spec={spec} />;
  }
}

/** Everything here sends through the acknowledged path, never fire-and-forget. */
function useRequest(): (msg: AckableMsg) => Promise<RequestResult> {
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

  // Shapes the placeholder to the machine that will actually resolve it: a
  // Windows canvas adding a workspace on a joined mac should not suggest
  // `C:\...`, which is exactly the shape of path this fix exists to refuse.
  const remoteIsWindows = host?.platform?.startsWith('win32') ?? false;
  const examplePath = host ? (remoteIsWindows ? 'C:\\Users\\you\\project' : '/Users/you/project') : 'folder path';

  return (
    <Dialog title={`Add a workspace on ${where}`}>
      <DialogForm
        submitLabel="add workspace"
        canSubmit={path.trim().length > 0 && reachable}
        onSubmit={async () => {
          // Asked before creating anything: the dialog that types the path
          // is the only place a wrong-machine or missing folder can be told
          // apart from any other mistake, rather than surfacing at the first
          // agent start (issue 15).
          await request({ t: 'checkFolder', hostId, path: path.trim() });
          await request({
            t: 'createWorkspace',
            name: name.trim() || path.trim(),
            rootPath: path.trim(),
            hostId,
          });
        }}
      >
        <Field
          label="folder"
          hint={
            host
              ? `A path as ${host.label} sees it — checked on that machine, not this one.`
              : 'An absolute path, or one relative to where the hub was started.'
          }
        >
          <input
            className="input"
            placeholder={examplePath}
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
  const pathChanged = path.trim() !== workspace.rootPath;
  const changed = name.trim() !== workspace.name || pathChanged;

  return (
    <Dialog title={`Edit ${workspace.name}`}>
      <DialogForm
        submitLabel="save"
        canSubmit={changed && name.trim().length > 0 && path.trim().length > 0}
        onSubmit={async () => {
          // Only asked when the folder itself moved: an unchanged path was
          // already checked when it was first accepted (or, for a row from
          // before this fix, is exactly the corrupted value re-entering it
          // is meant to repair — re-checking a value nobody touched would
          // only get in the way of that).
          if (pathChanged) {
            await request({ t: 'checkFolder', hostId: workspace.hostId, path: path.trim() });
          }
          await request({
            t: 'updateWorkspace',
            workspaceId,
            name: name.trim(),
            rootPath: path.trim(),
          });
        }}
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
  const { workspaces, profiles, templates, hostProfiles } = useStore(
    useShallow((s) => ({
      workspaces: s.workspaces,
      profiles: s.profiles,
      templates: s.templates,
      hostProfiles: s.hostProfiles,
    })),
  );
  const client = useStore((s) => s.client);
  const requestFocus = useStore((s) => s.requestFocus);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const hostId = workspace?.hostId ?? null;
  const agents = agentsOn(hostId, profiles, hostProfiles);

  // A template names an agent; whether that agent is installed is the other
  // machine's answer, so the two lists are joined here rather than on the hub.
  const offered = templates.filter((t) => !t.error && startableAgent(t, agents));
  const [picked, setPicked] = useState('claude');
  const active = pickValid(picked, offered, true);
  const template = offered.find((t) => t.id === active);
  const agent = agents.find((a) => a.id === template?.agent);

  // Overrides. Empty means "whatever the template said", which is why these
  // are strings rather than the template's values copied in: copying would
  // make a later edit to the template invisible to a dialog left open.
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [prompt, setPrompt] = useState('');

  const broken = templates.filter((t) => t.error);
  const missing = agents.filter((a) => a.available === false);

  return (
    <Dialog title={`Start an agent in ${workspace?.name ?? 'this workspace'}`}>
      <DialogForm
        submitLabel="start"
        canSubmit={Boolean(active)}
        onSubmit={async () => {
          const result = await request({
            t: 'startSession',
            workspaceId,
            profile: active,
            model: model.trim() || undefined,
            effort: effort.trim() || undefined,
            prompt: prompt.trim() || undefined,
          });
          // The ack names what it created, so the canvas can fly to the new
          // window instead of leaving it wherever the hub placed it.
          if (result.sessionId) requestFocus(result.sessionId);
        }}
      >
        <Field
          label="template"
          hint={templateHint(template, agent)}
        >
          <select className="input" value={active} onChange={(e) => setPicked(e.target.value)}>
            {offered.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}
                {t.id === t.agent ? '' : ` — ${t.agent}`}
              </option>
            ))}
          </select>
        </Field>

        {/* Only offered for an agent that declares how to spell it. A template
            holds a value; the agent says how to write it down, and one that
            says nothing takes neither. */}
        {agent && (agent.takesModel || agent.takesEffort) && (
          <div className="dialog-row">
            {agent.takesModel && (
              <Field
                label="model"
                hint={
                  template?.model
                    ? `${template.id} uses ${template.model}.`
                    : agent.modelSource === 'listed'
                      ? `${agent.models.length} to choose from.`
                      : 'Or a full model name.'
                }
              >
                <input
                  className="input"
                  list={`models-${agent.id}`}
                  placeholder={template?.model ?? "the agent's default"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id={`models-${agent.id}`}>
                  {agent.models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </Field>
            )}
            {agent.takesEffort && (
              <Field
                label="effort"
                hint={template?.effort ? `${template.id} uses ${template.effort}.` : undefined}
              >
                <input
                  className="input"
                  list={`efforts-${agent.id}`}
                  placeholder={template?.effort ?? 'default'}
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                />
                <datalist id={`efforts-${agent.id}`}>
                  {agent.efforts.map((e) => (
                    <option key={e} value={e} />
                  ))}
                </datalist>
              </Field>
            )}
          </div>
        )}

        <Field
          label="first instruction"
          hint="Typed into the terminal once the CLI is up, not passed as an argument. It does not repeat when the session is resumed."
        >
          <textarea
            className="input"
            rows={3}
            placeholder={template?.prompt ?? 'optional'}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        {broken.length > 0 && (
          <p className="dialog-note">
            Not offered, from <code>agents.toml</code>:{' '}
            {broken.map((t) => `${t.id} (${t.error})`).join('; ')}.
          </p>
        )}

        {missing.length > 0 && (
          <p className="dialog-note">
            Not on {hostId ? "that machine's" : "this machine's"} PATH:{' '}
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
          if you have just installed an agent.
        </p>
      </DialogForm>
    </Dialog>
  );
}

/** The line under the template picker: which agent, and is it actually there. */
function templateHint(
  template: AgentTemplateInfo | undefined,
  agent: AgentProfileInfo | undefined,
): string | undefined {
  if (!template) return undefined;
  const parts = [template.id === template.agent ? null : `Runs ${template.agent}.`];
  if (agent) parts.push(agentDetail(agent));
  return parts.filter(Boolean).join(' ') || undefined;
}

/* --------------------------------------------------------------- templates */

/**
 * Make a template, or edit one.
 *
 * The same four fields the picker reads back, and the same rule about which of
 * them exist: an agent that declares no way to spell a model or an effort does
 * not get the field at all. The start-an-agent dialog already hides them that
 * way, and hiding beats reporting — the rule still runs on the hub, but a
 * dialog that cannot express the mistake is better than one that explains it
 * afterwards.
 */
function TemplateDialog({
  id,
  proposal,
}: {
  id: string | null;
  /**
   * Set when an agent asked for this one. The form is the same because the
   * decision is the same, and because the likeliest answer to a proposal is
   * not yes or no but "yes, with a different name".
   */
  proposal?: TemplateProposal;
}) {
  const request = useRequest();
  const { templates, profiles } = useStore(
    useShallow((s) => ({ templates: s.templates, profiles: s.profiles })),
  );

  const editing = id ? (templates.find((t) => t.id === id) ?? null) : null;
  const seed = proposal?.template ?? editing;

  const [name, setName] = useState(seed?.id ?? '');
  const [agentId, setAgentId] = useState(seed?.agent ?? profiles[0]?.id ?? 'claude');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [model, setModel] = useState(seed?.model ?? '');
  const [effort, setEffort] = useState(seed?.effort ?? '');
  const [prompt, setPrompt] = useState(seed?.prompt ?? '');
  /*
   * Seeded from the stored template only, never from a proposal: an agent
   * cannot name environment variables for every future launch of a template,
   * so there is nothing on a proposal to seed from and this box starts empty
   * for one.
   *
   * Edited as text, not as a row of key/value inputs.
   *
   * A `.env`-shaped block is a thing people already have: it is what gets
   * pasted out of a README or a password manager, and a grid of paired fields
   * turns one paste into eight. Parsed on submit, so what is typed is exactly
   * what is round-tripped back into this box on the next edit.
   */
  const [envText, setEnvText] = useState(() => envToText(editing?.env));

  const agent = profiles.find((p) => p.id === agentId);

  /*
   * A template is one thing used on every machine, so the list here is every
   * agent this hub knows about rather than only the ones installed. Whether a
   * given machine has it is that machine's answer, and the picker already
   * joins the two lists at the point it matters.
   */
  const fields = {
    id: name.trim(),
    agent: agentId,
    description: description.trim() || null,
    model: model.trim() || null,
    effort: effort.trim() || null,
    prompt: prompt.trim() || null,
    env: parseEnvText(envText),
  };

  return (
    <Dialog
      title={
        proposal
          ? `${proposal.fromAddr} proposes a template`
          : editing
            ? `Edit ${editing.id}`
            : 'New template'
      }
    >
      <DialogForm
        submitLabel={proposal ? 'add template' : editing ? 'save template' : 'add template'}
        // Not "cancel": closing this is not a refusal, and calling it one left
        // agents blocked on an answer nobody had given.
        cancelLabel={proposal ? 'decide later' : 'cancel'}
        canSubmit={name.trim().length > 0 && !!agent}
        // Declining is an answer somebody is waiting on. Closing the dialog is
        // not one: it leaves the proposal where it was.
        secondary={
          proposal
            ? {
                label: 'decline',
                onClick: () =>
                  request({
                    t: 'resolveTemplateProposal',
                    proposalId: proposal.id,
                    accept: false,
                  }),
              }
            : undefined
        }
        onSubmit={() =>
          proposal
            ? request({
                t: 'resolveTemplateProposal',
                proposalId: proposal.id,
                accept: true,
                ...fields,
              })
            : request({ t: 'saveTemplate', ...fields })
        }
      >
        {proposal && (
          <p className="dialog-note">
            <code>{proposal.fromAddr}</code> asked for this. Nothing has been saved yet,
            and you can change any of it first — it is a suggestion, not a request to
            rubber-stamp. Agents already running are unaffected either way.
            <br />
            <strong>decline</strong> tells the agent no. <strong>decide later</strong>{' '}
            just closes this — the proposal stays in the panel under <em>templates</em>,
            and the agent cannot propose anything else while it waits.
          </p>
        )}
        <Field
          label="name"
          hint={
            proposal
              ? 'Rename it if you would rather it were called something else.'
              : editing
              ? editing.source === 'derived'
                ? `Saving makes a stored template that shadows ${editing.agent}'s own.`
                : 'The name is how it is picked; to rename one, make a new one and remove this.'
              : 'What you will pick from the list when starting an agent.'
          }
        >
          <input
            className="input"
            placeholder="reviewer"
            value={name}
            readOnly={!!editing && !proposal}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field label="agent" hint={agent ? agent.description : undefined}>
          <select
            className="input"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </Field>

        {/* Only for an agent that declares how to spell it — the same rule the
            start-an-agent dialog applies, and the same one the hub enforces. */}
        {agent && (agent.takesModel || agent.takesEffort) && (
          <div className="dialog-row">
            {agent.takesModel && (
              <Field
                label="model"
                hint={
                  agent.modelSource === 'listed'
                    ? `${agent.models.length} to choose from.`
                    : 'Or a full model name.'
                }
              >
                <input
                  className="input"
                  list={`tpl-models-${agent.id}`}
                  placeholder="the agent's default"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                <datalist id={`tpl-models-${agent.id}`}>
                  {agent.models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </Field>
            )}
            {agent.takesEffort && (
              <Field label="effort">
                <input
                  className="input"
                  list={`tpl-efforts-${agent.id}`}
                  placeholder="default"
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                />
                <datalist id={`tpl-efforts-${agent.id}`}>
                  {agent.efforts.map((e) => (
                    <option key={e} value={e} />
                  ))}
                </datalist>
              </Field>
            )}
          </div>
        )}

        <Field label="description" hint="Shown beside the name in the picker.">
          <input
            className="input"
            placeholder={agent?.description ?? 'optional'}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field
          label="first instruction"
          hint="Typed into the terminal once the CLI is up. It does not repeat when a session is resumed."
        >
          <textarea
            className="input"
            rows={3}
            placeholder="optional"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </Field>

        <Field
          label="environment"
          hint="One NAME=value per line, set for this template's agents on top of whatever the CLI already gets. Blank lines and # comments are ignored."
        >
          <textarea
            className="input"
            rows={3}
            spellCheck={false}
            placeholder={'optional\nANTHROPIC_BASE_URL=https://proxy.internal'}
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
          />
        </Field>
      </DialogForm>
    </Dialog>
  );
}

/** A stored env map back into the text the box shows. Sorted, so edits are diffable. */
function envToText(env: Record<string, string> | undefined): string {
  if (!env) return '';
  return Object.keys(env)
    .sort()
    .map((k) => `${k}=${env[k]}`)
    .join('\n');
}

/**
 * `NAME=value` lines into a map.
 *
 * Everything after the first `=` is the value, untrimmed and unquoted: a token
 * with a trailing space is a token with a trailing space, and stripping quotes
 * here would make a value that genuinely starts with one impossible to type. A
 * line with no `=`, or an empty name, is dropped — the hub validates the names
 * it does get and refuses the template if one cannot be a variable.
 */
function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    if (name) out[name] = trimmed.slice(eq + 1);
  }
  return out;
}

/**
 * An agent's proposal, looked up rather than passed in.
 *
 * Looked up because it can be answered from another browser while this one has
 * it open, and the store drops it when that happens - which has to read as
 * "somebody dealt with it", not as a dialog full of stale fields.
 */
function ReviewTemplateDialog({ proposalId }: { proposalId: string }) {
  const proposal = useStore((s) => s.templateProposals.find((p) => p.id === proposalId));
  const closeDialog = useStore((s) => s.closeDialog);

  if (!proposal) {
    return (
      <Dialog title="Already answered">
        <div className="dialog-body">
          <p className="dialog-note">
            That proposal is no longer waiting — it was accepted or declined somewhere
            else.
          </p>
          <footer className="dialog-actions">
            <button className="btn primary" type="button" onClick={closeDialog}>
              close
            </button>
          </footer>
        </div>
      </Dialog>
    );
  }

  return <TemplateDialog id={null} proposal={proposal} />;
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

/* ------------------------------------------------------------------ share */

/**
 * A per-terminal link (issue 14). Mirrors `JoinInstructions` for the
 * copy-link row and the "if that machine cannot resolve this one" fallback,
 * but this is a stronger grant than joining a machine - the holder can type
 * into a running agent - so it says that plainly and offers to revoke, which
 * a join link has no equivalent of.
 *
 * Reactive to the store rather than to a local "just created" flag: sharing
 * from a different browser tab, or the link already existing from before this
 * dialog was opened, both have to land on the same copy-link view.
 */
function ShareDialog({ sessionId }: { sessionId: string }) {
  const request = useRequest();
  const closeDialog = useStore((s) => s.closeDialog);
  const { session, share, lanOrigin, lanAltOrigin } = useStore(
    useShallow((s) => ({
      session: s.sessions.find((x) => x.id === sessionId),
      share: s.shares.find((sh) => sh.sessionId === sessionId),
      lanOrigin: s.lanOrigin,
      lanAltOrigin: s.lanAltOrigin,
    })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!session) return <Gone what="terminal" />;

  const run = (msg: AckableMsg, onOk?: () => void) => {
    setBusy(true);
    setError(null);
    request(msg).then(
      () => {
        setBusy(false);
        onOk?.();
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
      },
    );
  };

  const urlFor = (origin: string) => `${origin}/t/${share!.token}`;

  return (
    <Dialog title={`Share ${session.title || session.address}`}>
      <div className="dialog-body">
        <p className="dialog-note">
          Anyone with this link sees this one terminal live and can type into it -
          a real keyboard on an agent that can run commands, not a read-only view.
          They see nothing else: no canvas, no other agent, no panel.
        </p>
        {share ? (
          lanOrigin ? (
            <>
              <div className="join-url">
                <code>{urlFor(lanOrigin)}</code>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    void writeClipboard(urlFor(lanOrigin)).then((wrote) => {
                      if (!wrote) return;
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
              {lanAltOrigin && (
                <p className="dialog-note">
                  If that machine cannot resolve this one by name, use{' '}
                  <code>{urlFor(lanAltOrigin)}</code> instead.
                </p>
              )}
            </>
          ) : (
            <p className="dialog-note">
              This hub is bound to loopback, so nothing else on the network can
              reach this link - only a browser on this same machine.
            </p>
          )
        ) : (
          <p className="dialog-note">Not shared yet.</p>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-actions">
          <button className="btn" type="button" onClick={closeDialog}>
            close
          </button>
          {share ? (
            <button
              className="btn danger-solid"
              type="button"
              disabled={busy}
              onClick={() => run({ t: 'unshareSession', sessionId }, closeDialog)}
            >
              {busy ? 'working…' : 'stop sharing'}
            </button>
          ) : (
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={() => run({ t: 'shareSession', sessionId })}
            >
              {busy ? 'working…' : 'share it'}
            </button>
          )}
        </footer>
      </div>
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
