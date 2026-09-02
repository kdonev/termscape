import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './state/store.js';
import { Hosts } from './Hosts.js';

/** Workspace creation, agent launching, and the message log. */
export function Toolbar() {
  const {
    workspaces,
    sessions,
    profiles,
    messages,
    client,
    connected,
    hubVersion,
  } = useStore(useShallow((s) => ({
    workspaces: s.workspaces,
    sessions: s.sessions,
    profiles: s.profiles,
    messages: s.messages,
    client: s.client,
    connected: s.connected,
    hubVersion: s.hubVersion,
  })));

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [wsId, setWsId] = useState('');
  const [profile, setProfile] = useState('claude');
  const [showLog, setShowLog] = useState(false);

  const activeWs = wsId || workspaces[0]?.id || '';
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
          placeholder="folder path for a new workspace"
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
          disabled={!path.trim()}
          onClick={() => {
            client?.send({
              t: 'createWorkspace',
              name: name.trim() || path.trim(),
              rootPath: path.trim(),
            });
            setPath('');
            setName('');
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
          value={profile}
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
            client?.send({ t: 'startSession', workspaceId: activeWs, profile })
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
