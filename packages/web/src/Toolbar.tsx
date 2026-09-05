import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './state/store.js';
import { pickValid } from './state/selection.js';
import { Hosts } from './Hosts.js';

/** Workspace creation, agent launching, and the message log. */
export function Toolbar() {
  const {
    workspaces,
    hosts,
    sessions,
    profiles,
    messages,
    client,
    connected,
    hubVersion,
  } = useStore(useShallow((s) => ({
    workspaces: s.workspaces,
    hosts: s.hosts,
    sessions: s.sessions,
    profiles: s.profiles,
    messages: s.messages,
    client: s.client,
    connected: s.connected,
    hubVersion: s.hubVersion,
  })));

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  // '' is this machine. A workspace on a host runs its agents over there.
  const [hostId, setHostId] = useState('');
  const [wsId, setWsId] = useState('');
  const [profile, setProfile] = useState('claude');
  const [showLog, setShowLog] = useState(false);

  const connectedHosts = hosts.filter((h) => h.state === 'connected');
  // Resolved against the lists as they stand now rather than trusted: the
  // socket reconnects without a page load, so a hub restart replaces every
  // list while this component keeps the ids it picked before it.
  const activeWs = pickValid(wsId, workspaces, true);
  const activeHost = pickValid(hostId, connectedHosts);
  const activeProfile = pickValid(profile, profiles, true);
  const stoppedInWs = sessions.filter(
    (s) => s.workspaceId === activeWs && s.state !== 'running',
  );

  return (
    <div className="toolbar">
      <div className="brand">
        aiCanvas
        <span className={`conn ${connected ? 'on' : 'off'}`}>
          {connected ? `v${hubVersion}` : 'reconnecting…'}
        </span>
      </div>

      <div className="group">
        <input
          className="input wide"
          placeholder={
            activeHost
              ? `folder path on ${hosts.find((h) => h.id === activeHost)!.label}`
              : 'folder path for a new workspace'
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
        {/* Only connected hosts: a workspace on an unreachable one could not
            start anything, and offering it would only fail later. */}
        {connectedHosts.length > 0 && (
          <select
            className="input"
            title="Which machine this workspace's folder is on"
            value={activeHost}
            onChange={(e) => setHostId(e.target.value)}
          >
            <option value="">this machine</option>
            {connectedHosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn primary"
          disabled={!path.trim()}
          onClick={() => {
            client?.send({
              t: 'createWorkspace',
              name: name.trim() || path.trim(),
              rootPath: path.trim(),
              hostId: activeHost || null,
            });
            setPath('');
            setName('');
            setHostId('');
          }}
        >
          add workspace
        </button>
      </div>

      <div className="group">
        <select
          className="input"
          value={activeWs}
          onChange={(e) => setWsId(e.target.value)}
        >
          {workspaces.length === 0 && <option value="">no workspaces yet</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>

        <select
          className="input"
          value={activeProfile}
          onChange={(e) => setProfile(e.target.value)}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>

        <button
          className="btn primary"
          disabled={!activeWs}
          onClick={() =>
            client?.send({
              t: 'startSession',
              workspaceId: activeWs,
              profile: activeProfile,
            })
          }
        >
          start agent
        </button>

        {stoppedInWs.length > 0 && (
          <button
            className="btn"
            title="Relaunch every stopped agent in this workspace with its prior conversation"
            onClick={() => client?.send({ t: 'resumeWorkspace', workspaceId: activeWs })}
          >
            resume all ({stoppedInWs.length})
          </button>
        )}
      </div>

      <span className="spacer" />

      <Hosts />

      <button className="btn" onClick={() => setShowLog((v) => !v)}>
        messages ({messages.length})
      </button>

      {showLog && <MessageLog />}
    </div>
  );
}

/** Every delivery attempt and its outcome. Nothing is delivered invisibly. */
function MessageLog() {
  const messages = useStore((s) => s.messages);
  return (
    <div className="msg-log">
      {messages.length === 0 && <div className="msg-empty">no messages yet</div>}
      {messages
        .slice()
        .reverse()
        .map((m) => (
          <div key={m.id} className={`msg ${m.deliveryState}`}>
            <div className="msg-head">
              <span className="from">{m.fromAddr}</span>
              <span className="arrow">→</span>
              <span className="to">{m.toAddr}</span>
              <span className="when">
                {new Date(m.sentAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="msg-body">{m.body}</div>
            {m.error && <div className="msg-error">{m.error}</div>}
          </div>
        ))}
    </div>
  );
}
