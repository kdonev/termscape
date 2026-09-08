import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './state/store.js';

/** Where a bug goes. The repository's own tracker, not a form the hub serves. */
const ISSUES_URL = 'https://github.com/kdonev/termscape/issues/new';

/**
 * A new issue with the boring half already filled in.
 *
 * The three questions every bug report gets asked back — what did you do, what
 * happened, what did you expect — plus the version and browser, which are the
 * facts a reporter is least likely to think of and most likely to get wrong
 * from memory. Nothing is read out of the canvas itself: window titles, agent
 * output and the token in this page's own URL are exactly the things that must
 * not end up in a public tracker, and a report that quietly carried them would
 * be a worse bug than the one being reported.
 */
function bugReportUrl(hubVersion: string): string {
  const body = [
    '## What happened',
    '',
    '',
    '## What I expected',
    '',
    '',
    '## Steps to reproduce',
    '',
    '1. ',
    '',
    '---',
    '',
    `- termscape: ${hubVersion || 'unknown'}`,
    `- browser: ${navigator.userAgent}`,
    '',
  ].join('\n');
  return `${ISSUES_URL}?body=${encodeURIComponent(body)}`;
}

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
        Termscape
        <span className={`conn ${connected ? 'on' : 'off'}`}>
          {connected ? `v${hubVersion}` : 'reconnecting…'}
        </span>
      </div>

      <span className="spacer" />

      <a
        className="btn"
        href={bugReportUrl(hubVersion)}
        target="_blank"
        rel="noreferrer noopener"
        title="Open a pre-filled issue on GitHub. Nothing from this canvas is included."
      >
        report a bug
      </a>

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
