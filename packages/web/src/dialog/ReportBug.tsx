import { useState } from 'react';
import { useStore } from '../state/store.js';
import { writeClipboard } from '../window/clipboard.js';
import { Dialog } from './Dialog.js';

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
 *
 * Exported logs are no exception. The issue only says that they exist, so
 * whoever picks it up knows to ask for them privately.
 */
export function bugReportUrl(hubVersion: string, logsExported = false): string {
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
    ...(logsExported ? ['- logs: exported locally, not attached (ask me for them)'] : []),
    '',
  ].join('\n');
  return `${ISSUES_URL}?body=${encodeURIComponent(body)}`;
}

/**
 * Report a bug, with the choice of exporting logs first.
 *
 * The logs are written by the hub to a file on its own machine, never
 * uploaded: the tracker is public, and the file names agents and who
 * messaged whom. The hub writes it rather than the browser downloading it
 * because the canvas's own window has nowhere to put a download.
 */
export function ReportBugDialog() {
  const closeDialog = useStore((s) => s.closeDialog);
  const client = useStore((s) => s.client);
  const hubVersion = useStore((s) => s.hubVersion);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const exportLogs = () => {
    setBusy(true);
    setError(null);
    (client ? client.request({ t: 'exportLogs' }) : Promise.reject(new Error('not connected to the hub')))
      .then(
        (r) => {
          setBusy(false);
          if (r.path) setPath(r.path);
          else setError('the hub did not say where it wrote the logs');
        },
        (err: Error) => {
          setBusy(false);
          setError(err.message);
        },
      );
  };

  return (
    <Dialog title="Report a bug">
      <div className="dialog-body">
        <p className="dialog-note">
          Bugs go to the public issue tracker on GitHub, so logs are never attached
          to the issue. You can export them to a file on this computer first, and
          send it privately if you are asked for it.
        </p>
        <p className="dialog-note">
          The file holds versions, the agents on each machine, when messages were
          sent and whether they were delivered, and each hub's recent log. It does
          not hold message text, terminal contents or tokens.
        </p>
        {path && (
          <>
            <p className="dialog-note">Logs written to:</p>
            <div className="join-url">
              <code>{path}</code>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  void writeClipboard(path).then((wrote) => {
                    if (!wrote) return;
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                {copied ? 'copied' : 'copy'}
              </button>
            </div>
          </>
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
          <button className="btn" type="button" disabled={busy} onClick={exportLogs}>
            {busy ? 'exporting…' : path ? 'export again' : 'export logs'}
          </button>
          <a
            className="btn primary"
            href={bugReportUrl(hubVersion, path !== null)}
            target="_blank"
            rel="noreferrer noopener"
            title="Open a pre-filled issue on GitHub. No logs and nothing from this canvas are included."
          >
            open issue on GitHub
          </a>
        </footer>
      </div>
    </Dialog>
  );
}
