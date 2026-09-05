import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './state/store.js';

/**
 * What is left along the top once machines, workspaces and agents have a tree
 * of their own: who you are connected to, the way into that tree, and the
 * message log.
 */
export function Toolbar() {
  const { messages, connected, hubVersion, panelOpen, setPanelOpen, sessions } = useStore(
    useShallow((s) => ({
      messages: s.messages,
      connected: s.connected,
      hubVersion: s.hubVersion,
      panelOpen: s.panelOpen,
      setPanelOpen: s.setPanelOpen,
      sessions: s.sessions,
    })),
  );

  const [showLog, setShowLog] = useState(false);
  const running = sessions.filter((s) => s.state === 'running').length;

  return (
    <div className="toolbar">
      <div className="brand">
        aiCanvas
        <span className={`conn ${connected ? 'on' : 'off'}`}>
          {connected ? `v${hubVersion}` : 'reconnecting…'}
        </span>
      </div>

      <span className="spacer" />

      <button className="btn" onClick={() => setShowLog((v) => !v)}>
        messages ({messages.length})
      </button>

      <button
        className={`btn ${panelOpen ? 'primary' : ''}`}
        title="Machines, workspaces and agents"
        onClick={() => setPanelOpen(!panelOpen)}
      >
        machines · {running} running
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
