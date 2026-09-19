import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { isNewer } from '@termscape/protocol';
import { useStore } from './state/store.js';

/** Where a release is described, for a hub that cannot install one itself. */
const RELEASES_URL = 'https://github.com/kdonev/termscape/releases';

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
        {connected && <UpdateButton />}
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

/**
 * A newer release, beside the version it would replace.
 *
 * Nothing restarts until it is pressed, and pressing it asks first: the hub
 * takes every agent on this machine down with it. A hub that cannot install
 * the release itself - a checkout, or one started before it had a supervisor
 * - still says there is one, and points at it.
 */
function UpdateButton() {
  const { update, hubVersion, openDialog, running } = useStore(
    useShallow((s) => {
      // Only this machine's agents restart with its hub. A remote session
      // carries its own hub's workspace id, which no local workspace has.
      const local = new Set(s.workspaces.filter((w) => w.hostId === null).map((w) => w.id));
      return {
        update: s.update,
        hubVersion: s.hubVersion,
        openDialog: s.openDialog,
        running: s.sessions.filter((x) => x.state === 'running' && local.has(x.workspaceId))
          .length,
      };
    }),
  );
  if (!update) return null;

  if (update.state === 'downloading' || update.state === 'restarting') {
    return (
      <span className="update-note">
        {update.state === 'downloading' ? `downloading v${update.latest}…` : 'restarting…'}
      </span>
    );
  }
  const failed = update.state === 'failed' && update.error;
  if (!isNewer(update.latest, hubVersion)) {
    return failed ? (
      <span className="update-note bad" title={update.error ?? ''}>
        update failed
      </span>
    ) : null;
  }

  const installable = update.kind === 'npx' || update.kind === 'global';
  if (!installable || !update.canRestart) {
    const why = !installable
      ? 'This hub was not installed from npm, so it cannot update itself.'
      : 'Stop termscape and start it again once, and it will be able to update itself.';
    return (
      <a
        className="btn update"
        href={RELEASES_URL}
        target="_blank"
        rel="noreferrer noopener"
        title={why}
      >
        v{update.latest} available
      </a>
    );
  }

  return (
    <button
      className="btn primary update"
      title={failed ? `The last attempt failed: ${update.error}` : `Install v${update.latest} and restart`}
      onClick={() =>
        openDialog({
          kind: 'confirm',
          title: `Update to v${update.latest}?`,
          body:
            `termscape downloads v${update.latest}, then restarts on the same address.` +
            (running > 0
              ? ` The ${running} agent${running === 1 ? '' : 's'} running on this machine stop with it and are resumed once it is back.`
              : '') +
            ' Other machines on the canvas keep running; each can be updated from the machines panel once this one is back.',
          confirmLabel: 'update and restart',
          send: { t: 'applyUpdate' },
        })
      }
    >
      {failed ? 'retry update' : `update to v${update.latest}`}
    </button>
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
