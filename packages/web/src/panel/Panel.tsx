import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import { buildTree, type TreeMachine, type TreeWorkspace } from '../state/tree.js';
import { statusColor, statusLabel } from '../window/status.js';
import { agentDetail, agentsOn } from '../state/agents.js';

/**
 * The index to the canvas: every machine, the workspaces on it, and the agents
 * in each workspace — with adding and removing done on the node it belongs to
 * rather than in one strip of unrelated controls along the top.
 *
 * It overlays the canvas rather than sitting beside it, so opening it never
 * relayouts what you were looking at.
 */

const HOST_STATE_COLOR: Record<string, string> = {
  connected: '#88c07a',
  connecting: '#d8b271',
  disconnected: '#7c8596',
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
        <span className="panel-title">machines</span>
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
      </div>
    </aside>
  );
}

function MachineNode({ machine }: { machine: TreeMachine }) {
  const { client, hostLogs, openDialog, profiles, hostProfiles } = useStore(
    useShallow((s) => ({
      client: s.client,
      hostLogs: s.hostLogs,
      openDialog: s.openDialog,
      profiles: s.profiles,
      hostProfiles: s.hostProfiles,
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
      <span className="node-label" title={session.address}>
        {session.title || session.name}
      </span>
      <span className="node-sub">{session.statusText ?? statusLabel(session)}</span>
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

function Twisty({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button className="twisty" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={onClick}>
      {collapsed ? '▸' : '▾'}
    </button>
  );
}
