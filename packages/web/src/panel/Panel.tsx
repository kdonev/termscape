import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { AgentTemplateInfo, Session } from '@termscape/protocol';
import { UPGRADE_GRACE_MS, useStore } from '../state/store.js';
import {
  buildTree,
  hostNeedsUpdate,
  type TreeMachine,
  type TreeWorkspace,
} from '../state/tree.js';
import { statusColor, statusLabel } from '../window/status.js';
import { agentDetail, agentsOn } from '../state/agents.js';

/**
 * The index to the canvas: every machine, the workspaces on it, and the agents
 * in each workspace — with adding and removing done on the node it belongs to
 * rather than in one strip of unrelated controls along the top.
 *
 * Two roots, not one. Machines are places; a template is config, used on every
 * machine and belonging to none of them, so it sits beside the machines rather
 * than under one. That is also why the panel is no longer called "machines".
 *
 * It overlays the canvas rather than sitting beside it, so opening it never
 * relayouts what you were looking at.
 */

const HOST_STATE_COLOR: Record<string, string> = {
  connected: '#88c07a',
  connecting: '#d8b271',
  disconnected: '#7c8596',
  // On the line, but a schema behind: nothing runs there until it updates.
  outdated: '#d8b271',
  error: '#e06c75',
};

export function Panel() {
  const { hosts, workspaces, sessions, open, setOpen, openDialog } = useStore(
    useShallow((s) => ({
      hosts: s.hosts,
      workspaces: s.workspaces,
      sessions: s.sessions,
      open: s.panelOpen,
      setOpen: s.setPanelOpen,
      openDialog: s.openDialog,
    })),
  );

  const tree = buildTree(hosts, workspaces, sessions);

  return (
    <aside className={`panel ${open ? 'open' : ''}`} aria-hidden={!open}>
      <header className="panel-head">
        <span className="panel-title">canvas</span>
        <span className="spacer" />
        <button className="btn" title="Close" onClick={() => setOpen(false)}>
          ›
        </button>
      </header>

      <div className="panel-body">
        {tree.map((machine) => (
          <MachineNode key={machine.id || 'local'} machine={machine} />
        ))}
        <button
          className="btn add-machine"
          onClick={() => openDialog({ kind: 'addMachine' })}
        >
          + machine
        </button>
        <TemplatesNode />
      </div>
    </aside>
  );
}

function MachineNode({ machine }: { machine: TreeMachine }) {
  const { client, hostLogs, openDialog, profiles, hostProfiles, hubVersion } = useStore(
    useShallow((s) => ({
      client: s.client,
      hostLogs: s.hostLogs,
      openDialog: s.openDialog,
      profiles: s.profiles,
      hostProfiles: s.hostProfiles,
      hubVersion: s.hubVersion,
    })),
  );
  const [collapsed, setCollapsed] = useState(false);

  const host = machine.host;
  const installed = agentsOn(machine.id || null, profiles, hostProfiles);
  const log = host ? (hostLogs[host.id] ?? []) : [];
  const agents = machine.workspaces.reduce((n, w) => n + w.sessions.length, 0);

  return (
    <div className="node-group">
      <div className="node machine">
        <Twisty collapsed={collapsed} onClick={() => setCollapsed((v) => !v)} />
        <span
          className="dot"
          style={{ background: HOST_STATE_COLOR[machine.state] ?? '#7c8596' }}
        />
        <span className="node-label">{machine.label}</span>
        {machine.sub && <span className="node-sub">{machine.sub}</span>}
        <span className="spacer" />
        <button
          className="btn"
          title={`Add a workspace on ${machine.label}`}
          onClick={() => {
            setCollapsed(false);
            openDialog({ kind: 'addWorkspace', hostId: machine.id || null });
          }}
        >
          + workspace
        </button>
        {host && <HostUpdateButton machine={machine} hubVersion={hubVersion} agents={agents} />}
        {host && (
          <button
            className="btn"
            title={`Rename ${machine.label} or fix how it is reached`}
            onClick={() => openDialog({ kind: 'editMachine', hostId: host.id })}
          >
            edit
          </button>
        )}
        {/* An enrolled host reaches us, so there is nothing here to dial;
            only a deployed one can be reconnected from this side. */}
        {host?.kind === 'ssh' && (
          <button
            className="btn"
            title="Reconnect and redeploy if needed"
            onClick={() => client?.send({ t: 'connectHost', hostId: host.id })}
          >
            {machine.state === 'connected' ? 'reconnect' : 'connect'}
          </button>
        )}
        {host && (
          <button
            className="btn danger"
            title="Remove this machine"
            onClick={() => {
              const carries = [
                machine.workspaces.length > 0 &&
                  `${machine.workspaces.length} workspace${machine.workspaces.length === 1 ? '' : 's'}`,
                agents > 0 && `${agents} agent${agents === 1 ? '' : 's'}`,
              ].filter(Boolean);
              const detail =
                carries.length > 0 ? ` Its ${carries.join(' and ')} go with it.` : '';
              openDialog({
                kind: 'confirm',
                title: `Remove ${machine.label}?`,
                body: `It leaves the canvas and the hub running there is stopped too.${detail}`,
                confirmLabel: 'remove machine',
                send: { t: 'removeHost', hostId: host.id },
              });
            }}
          >
            ×
          </button>
        )}
      </div>

      {host?.error && <div className="node-error">{host.error}</div>}
      {host?.state === 'outdated' && (
        <div className="node-error">
          Its hub ({host.hubVersion ?? 'unknown'}) is too old to run anything for this canvas
          ({hubVersion}) until it is updated.
        </div>
      )}
      {/* Per machine, because a host has its own PATH and this hub's answer
          says nothing about it. A declared agent that is missing stays here
          and says so rather than vanishing, which would look like the config
          was ignored. */}
      {!collapsed && installed.length > 0 && (
        <div className="node-agents">
          {installed.map((a) => (
            <span
              key={a.id}
              className={`agent-chip ${a.available === false ? 'off' : ''} ${a.available === null ? 'unknown' : ''}`}
              title={agentDetail(a)}
            >
              {a.id}
              {a.version && <em>{a.version}</em>}
            </span>
          ))}
        </div>
      )}
      {machine.state === 'connecting' && log.length > 0 && (
        <div className="node-log">
          {log.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {!collapsed && (
        <div className="node-children">
          {machine.workspaces.map((w) => (
            <WorkspaceNode key={w.workspace.id} node={w} />
          ))}
          {machine.workspaces.length === 0 && (
            <div className="node-empty">no workspaces here yet</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Bring a host to this canvas's version, when it runs a different one.
 *
 * Offered, never done on its own: updating restarts the hub over there and
 * every agent running on it, so when is the user's call, one machine at a
 * time. Between the click and the machine coming back at the new version the
 * row says so, and if it never comes back, it says where to look.
 */
function HostUpdateButton({
  machine,
  hubVersion,
  agents,
}: {
  machine: TreeMachine;
  hubVersion: string;
  agents: number;
}) {
  const { openDialog, upgrading, markUpgrading } = useStore(
    useShallow((s) => ({
      openDialog: s.openDialog,
      upgrading: s.upgrading,
      markUpgrading: s.markUpgrading,
    })),
  );
  const host = machine.host;
  if (!host || !hostNeedsUpdate(host, hubVersion)) return null;

  const since = upgrading[host.id];
  if (since !== undefined && Date.now() - since < UPGRADE_GRACE_MS) {
    return <span className="node-sub">updating…</span>;
  }
  const overdue = since !== undefined;
  const reachable = host.state === 'connected' || host.state === 'outdated';
  const where = host.kind === 'ssh' ? '~/.termscape/hub.log' : '~/.termscape/update.log';

  let title = `Update ${machine.label} from ${host.hubVersion ?? 'unknown'} to ${hubVersion}`;
  if (overdue) title = `It has not come back at ${hubVersion}. See ${where} on that machine.`;
  else if (!reachable) title = `${machine.label} is not connected; it can be updated once it is`;
  else if (!host.canUpdate) {
    title = 'The hub there is too old to update itself. Re-run the join command on that machine once.';
  }

  return (
    <button
      className={`btn ${overdue ? 'danger' : 'primary'}`}
      title={title}
      disabled={!reachable || !host.canUpdate}
      onClick={() =>
        openDialog({
          kind: 'confirm',
          title: `Update ${machine.label} to ${hubVersion}?`,
          body:
            `The hub there restarts at ${hubVersion}.` +
            (agents > 0
              ? ` Its running agents stop with it and are resumed once it is back.`
              : '') +
            ' The machine drops off the canvas for a minute or two and comes back on its own.',
          confirmLabel: 'update and restart',
          send: { t: 'upgradeHost', hostId: host.id },
          onConfirmed: () => markUpgrading(host.id),
        })
      }
    >
      {overdue ? 'update stalled' : 'update'}
    </button>
  );
}

/**
 * Templates: the second root, below the machines and collapsed.
 *
 * Machines are what you work in every day and templates are what you set up
 * once and then forget, so opening the panel to reach a terminal should not
 * mean scrolling past a list of templates.
 *
 * No availability here on purpose. A template names an agent; whether that
 * agent is installed is each machine's own answer, and a row that went red
 * because one of four machines lacked a CLI would be noise. The picker already
 * knows, because it joins the two lists at the point it matters.
 */
function TemplatesNode() {
  const { templates, proposals, openDialog, client } = useStore(
    useShallow((s) => ({
      templates: s.templates,
      proposals: s.templateProposals,
      openDialog: s.openDialog,
      client: s.client,
    })),
  );
  // Opened when an agent is waiting on an answer: a proposal that arrived
  // while another dialog was up is otherwise only visible in here.
  const [collapsed, setCollapsed] = useState(true);
  const open = !collapsed || proposals.length > 0;

  // Made ones first: a list that opens with the whole built-in set before the
  // three you wrote is a list you have to read past.
  const ordered = [...templates].sort((a, b) => {
    const rank = (t: AgentTemplateInfo) =>
      t.source === 'derived' ? 1 : 0;
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
  const made = templates.filter((t) => t.source !== 'derived').length;

  return (
    <div className="node-group">
      <div className="node root">
        <Twisty collapsed={collapsed} onClick={() => setCollapsed((v) => !v)} />
        <span className="node-label">templates</span>
        <span className="node-sub">
          {proposals.length > 0
            ? `${proposals.length} waiting on you`
            : made > 0
              ? `${made} of your own`
              : 'one per agent'}
        </span>
        <span className="spacer" />
        <button
          className="btn"
          title="Make a template: an agent plus a model, an effort and a first task"
          onClick={() => {
            setCollapsed(false);
            openDialog({ kind: 'saveTemplate', id: null });
          }}
        >
          + template
        </button>
      </div>

      {open && (
        <div className="node-children">
          {proposals.map((p) => (
            <div className="node-group" key={p.id}>
              <div className="node template">
                <span className="node-label">{p.template.id}</span>
                <span className="node-sub">proposed by {p.fromAddr}</span>
                <span className="spacer" />
                <button
                  className="btn"
                  title={`Review the template ${p.fromAddr} asked for`}
                  onClick={() => openDialog({ kind: 'reviewTemplate', proposalId: p.id })}
                >
                  review
                </button>
                {/* Here as well as in the dialog, because the way a proposal
                    gets stuck is somebody closing the dialog without deciding:
                    the agent is then blocked on an answer and the only place
                    that says so is this row. */}
                <button
                  className="btn danger"
                  title={`Tell ${p.fromAddr} no`}
                  onClick={() =>
                    client?.send({
                      t: 'resolveTemplateProposal',
                      proposalId: p.id,
                      accept: false,
                    })
                  }
                >
                  ×
                </button>
              </div>
            </div>
          ))}
          {ordered.map((t) => (
            <TemplateNode key={t.id} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateNode({ template }: { template: AgentTemplateInfo }) {
  const openDialog = useStore((s) => s.openDialog);
  const chose = [template.model, template.effort].filter(Boolean).join(', ');
  const fromFile = template.source === 'file';

  return (
    <div className="node-group">
      <div className="node template">
        <span className="node-label">{template.id}</span>
        <span className="node-sub">
          {template.agent}
          {chose && ` · ${chose}`}
          {template.source === 'derived' && ' · built in'}
          {fromFile && ' · agents.toml'}
        </span>
        <span className="spacer" />
        {/* A template in agents.toml is the user's file and the hub does not
            write it, so there is nothing honest to offer here. Editing a
            built-in one is offered, and means making a stored template that
            shadows it. */}
        {!fromFile && (
          <button
            className="btn"
            title={
              template.source === 'derived'
                ? `Make a template based on ${template.agent}`
                : `Edit ${template.id}`
            }
            onClick={() => openDialog({ kind: 'saveTemplate', id: template.id })}
          >
            edit
          </button>
        )}
        {template.source === 'stored' && (
          <button
            className="btn danger"
            title={`Remove ${template.id}`}
            onClick={() =>
              openDialog({
                kind: 'confirm',
                title: `Remove ${template.id}?`,
                // Both halves of this are already true, and neither needs a
                // confirmation that pretends otherwise: a session records what
                // its template resolved to precisely so resume cannot drift.
                body:
                  'Agents already started from it keep their model, their effort and ' +
                  'their ability to resume. Only the next agent is affected.',
                confirmLabel: 'remove template',
                send: { t: 'removeTemplate', id: template.id },
              })
            }
          >
            ×
          </button>
        )}
      </div>
      {template.error && <div className="node-error">{template.error}</div>}
    </div>
  );
}

function WorkspaceNode({ node }: { node: TreeWorkspace }) {
  const { client, openDialog } = useStore(
    useShallow((s) => ({ client: s.client, openDialog: s.openDialog })),
  );
  const [collapsed, setCollapsed] = useState(false);
  const { workspace, sessions } = node;
  const stopped = sessions.filter((s) => s.state !== 'running');

  return (
    <div className="node-group">
      <div className="node workspace">
        <Twisty collapsed={collapsed} onClick={() => setCollapsed((v) => !v)} />
        <span className="node-label">{workspace.name}</span>
        <span className="node-sub" title={workspace.rootPath}>
          {workspace.rootPath}
        </span>
        <span className="spacer" />
        <button
          className="btn"
          title="Start an agent in this workspace"
          onClick={() => {
            setCollapsed(false);
            openDialog({ kind: 'startAgent', workspaceId: workspace.id });
          }}
        >
          + agent
        </button>
        <button
          className="btn"
          title="Rename this workspace or point it at another folder"
          onClick={() => openDialog({ kind: 'editWorkspace', workspaceId: workspace.id })}
        >
          edit
        </button>
        {stopped.length > 0 && (
          <button
            className="btn"
            title="Relaunch every stopped agent here with its prior conversation"
            onClick={() => client?.send({ t: 'resumeWorkspace', workspaceId: workspace.id })}
          >
            resume all ({stopped.length})
          </button>
        )}
        <button
          className="btn danger"
          title="Remove this workspace"
          onClick={() => {
            const n = sessions.length;
            const detail =
              n > 0
                ? ` Its ${n} agent${n === 1 ? '' : 's'} go with it.`
                : ' It has nothing running in it.';
            openDialog({
              kind: 'confirm',
              title: `Remove ${workspace.name}?`,
              body: `The folder itself is untouched; only the workspace leaves the canvas.${detail}`,
              confirmLabel: 'remove workspace',
              send: { t: 'removeWorkspace', workspaceId: workspace.id },
            });
          }}
        >
          ×
        </button>
      </div>

      {!collapsed && (
        <div className="node-children">
          {sessions.map((s) => (
            <SessionNode key={s.id} session={s} />
          ))}
          {sessions.length === 0 && <div className="node-empty">nothing running here</div>}
        </div>
      )}
    </div>
  );
}

function SessionNode({ session }: { session: Session }) {
  const { client, selectedId, requestFocus, openDialog } = useStore(
    useShallow((s) => ({
      client: s.client,
      selectedId: s.selectedId,
      requestFocus: s.requestFocus,
      openDialog: s.openDialog,
    })),
  );
  const stopped = session.state !== 'running';

  return (
    <div
      className={`node session ${selectedId === session.id ? 'on' : ''}`}
      // The row is the way back to a window you have panned away from.
      onClick={() => requestFocus(session.id)}
    >
      <span className="dot" style={{ background: statusColor(session) }} />
      <span className="node-label" title={describeSession(session)}>
        {session.title || session.name}
      </span>
      <span className="node-sub">{session.statusText ?? statusLabel(session)}</span>
      {/* What the template resolved to, when it resolved to anything. This is
          also what the session came back on after a restart, which is the
          reason it is stored rather than looked up. */}
      {session.model && <span className="node-tag">{session.model}</span>}
      {session.effort && <span className="node-tag">{session.effort}</span>}
      <span className="spacer" />
      <button
        className="btn"
        title={
          stopped
            ? session.resumable
              ? 'Relaunch with its previous conversation'
              : 'Restart this session'
            : 'Stop this agent'
        }
        onClick={(e) => {
          e.stopPropagation();
          client?.send(
            stopped
              ? { t: 'resumeSession', sessionId: session.id }
              : { t: 'stopSession', sessionId: session.id },
          );
        }}
      >
        {stopped ? (session.resumable ? 'resume' : 'restart') : 'stop'}
      </button>
      <button
        className="btn danger"
        title="Remove this window and forget the session"
        onClick={(e) => {
          e.stopPropagation();
          openDialog({
            kind: 'confirm',
            title: `Remove ${session.address}?`,
            body: stopped
              ? 'Its window and its record go; the conversation it was resuming from is not deleted.'
              : 'It is stopped and its window goes with it. The conversation itself is not deleted.',
            confirmLabel: 'remove agent',
            send: { t: 'removeSession', sessionId: session.id },
          });
        }}
      >
        ×
      </button>
    </div>
  );
}

/** The tooltip on an agent row: its address, and what it was started as. */
function describeSession(s: Session): string {
  const from = [s.template, s.model, s.effort].filter(Boolean).join(' · ');
  return from ? `${s.address}\n${from}` : s.address;
}

function Twisty({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button className="twisty" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={onClick}>
      {collapsed ? '▸' : '▾'}
    </button>
  );
}
