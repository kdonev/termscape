import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session, Workspace } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import { pickValid } from '../state/selection.js';
import { buildTree, type TreeMachine, type TreeWorkspace } from '../state/tree.js';
import { statusColor, statusLabel } from '../window/status.js';
import { AddMachine } from '../AddMachine.js';

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
  const { hosts, workspaces, sessions, open, setOpen } = useStore(
    useShallow((s) => ({
      hosts: s.hosts,
      workspaces: s.workspaces,
      sessions: s.sessions,
      open: s.panelOpen,
      setOpen: s.setPanelOpen,
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
        <AddMachine />
      </div>
    </aside>
  );
}

function MachineNode({ machine }: { machine: TreeMachine }) {
  const { client, hostLogs } = useStore(
    useShallow((s) => ({ client: s.client, hostLogs: s.hostLogs })),
  );
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);

  const host = machine.host;
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
            setAdding((v) => !v);
          }}
        >
          + workspace
        </button>
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
              if (
                window.confirm(
                  `Remove ${machine.label} from the canvas?${detail} The hub running there is stopped too.`,
                )
              ) {
                client?.send({ t: 'removeHost', hostId: host.id });
              }
            }}
          >
            ×
          </button>
        )}
      </div>

      {host?.error && <div className="node-error">{host.error}</div>}
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
          {machine.workspaces.length === 0 && !adding && (
            <div className="node-empty">no workspaces here yet</div>
          )}
          {adding && <AddWorkspace machine={machine} onDone={() => setAdding(false)} />}
        </div>
      )}
    </div>
  );
}

function WorkspaceNode({ node }: { node: TreeWorkspace }) {
  const client = useStore((s) => s.client);
  const [collapsed, setCollapsed] = useState(false);
  const [starting, setStarting] = useState(false);
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
            setStarting((v) => !v);
          }}
        >
          + agent
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
            const detail = n > 0 ? ` Its ${n} agent${n === 1 ? '' : 's'} go with it.` : '';
            if (window.confirm(`Remove workspace "${workspace.name}"?${detail}`)) {
              client?.send({ t: 'removeWorkspace', workspaceId: workspace.id });
            }
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
          {sessions.length === 0 && !starting && (
            <div className="node-empty">nothing running here</div>
          )}
          {starting && <StartAgent workspace={workspace} onDone={() => setStarting(false)} />}
        </div>
      )}
    </div>
  );
}

function SessionNode({ session }: { session: Session }) {
  const { client, selectedId, requestFocus } = useStore(
    useShallow((s) => ({
      client: s.client,
      selectedId: s.selectedId,
      requestFocus: s.requestFocus,
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
          if (window.confirm(`Remove ${session.address}?`)) {
            client?.send({ t: 'removeSession', sessionId: session.id });
          }
        }}
      >
        ×
      </button>
    </div>
  );
}

/**
 * Adding a workspace under the machine it belongs to. The host is the node you
 * opened this on, which is one field fewer to fill in than a form that asks —
 * and no way to put a folder on a machine you did not mean.
 */
function AddWorkspace({ machine, onDone }: { machine: TreeMachine; onDone: () => void }) {
  const client = useStore((s) => s.client);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  // A workspace on an unreachable machine could not start anything, and
  // offering it would only fail later.
  const reachable = machine.state === 'connected';

  return (
    <div className="node-form">
      <input
        className="input wide"
        autoFocus
        placeholder={
          machine.host ? `folder path on ${machine.label}` : 'folder path on this machine'
        }
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <input
        className="input"
        placeholder="name (optional)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        className="btn primary"
        disabled={!path.trim() || !reachable}
        title={reachable ? undefined : 'This machine is not connected'}
        onClick={() => {
          client?.send({
            t: 'createWorkspace',
            name: name.trim() || path.trim(),
            rootPath: path.trim(),
            hostId: machine.id || null,
          });
          onDone();
        }}
      >
        add
      </button>
      <button className="btn" onClick={onDone}>
        cancel
      </button>
    </div>
  );
}

function StartAgent({ workspace, onDone }: { workspace: Workspace; onDone: () => void }) {
  const { client, profiles } = useStore(
    useShallow((s) => ({ client: s.client, profiles: s.profiles })),
  );
  const [profile, setProfile] = useState('claude');
  const active = pickValid(profile, profiles, true);

  return (
    <div className="node-form">
      <select className="input" autoFocus value={active} onChange={(e) => setProfile(e.target.value)}>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id}
          </option>
        ))}
      </select>
      <button
        className="btn primary"
        disabled={!active}
        onClick={() => {
          client?.send({ t: 'startSession', workspaceId: workspace.id, profile: active });
          onDone();
        }}
      >
        start
      </button>
      <button className="btn" onClick={onDone}>
        cancel
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
