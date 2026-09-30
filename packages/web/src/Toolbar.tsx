import { useShallow } from 'zustand/react/shallow';
import { isNewer } from '@termscape/protocol';
import { useStore } from './state/store.js';

/** Where a release is described, for a hub that cannot install one itself. */
const RELEASES_URL = 'https://github.com/kdonev/termscape/releases';

/**
 * What is left along the top once machines, workspaces and agents have a tree
 * of their own: who you are connected to and the way into that tree.
 */
export function Toolbar() {
  const { connected, hubVersion, panelOpen, setPanelOpen, openDialog, sessions } = useStore(
    useShallow((s) => ({
      connected: s.connected,
      hubVersion: s.hubVersion,
      panelOpen: s.panelOpen,
      setPanelOpen: s.setPanelOpen,
      openDialog: s.openDialog,
      sessions: s.sessions,
    })),
  );

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

      <button
        className="btn"
        title="Open a pre-filled issue on GitHub, with the option to export logs to a file first. Nothing from this canvas is included in the issue."
        onClick={() => openDialog({ kind: 'reportBug' })}
      >
        report a bug
      </button>

      <button
        className={`btn ${panelOpen ? 'primary' : ''}`}
        title="Machines, workspaces and agents"
        onClick={() => setPanelOpen(!panelOpen)}
      >
        machines · {running} running
      </button>
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
