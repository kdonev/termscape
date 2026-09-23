import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store.js';
import { DialogForm, Field } from './Dialog.js';

/**
 * Attaching a machine, both directions.
 *
 * These were the largest of the forms crammed into the 420px tree column: two
 * tabs, four fields and a paragraph of explanation, wrapping onto six lines.
 * Nothing about them changed in the move except that they now have room.
 */

/** A command to paste on the other machine, with a button that copies it. */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="join-url">
      <code>{text}</code>
      <button
        className="btn"
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

/**
 * The pull path. Nothing to fill in: the other machine fetches the installer
 * itself, which is the point - no credentials are typed here, and an install
 * failure shows up in the terminal of whoever can fix it.
 *
 * The commands are the same two the join page shows, so there is no need to
 * open that page on the other machine first. Each run of one downloads an
 * installer with a fresh single-use key, so a copied command stays good.
 */
export function JoinInstructions() {
  const { enrollUrl, enrollAltUrl } = useStore(
    useShallow((s) => ({ enrollUrl: s.enrollUrl, enrollAltUrl: s.enrollAltUrl })),
  );
  const closeDialog = useStore((s) => s.closeDialog);
  const origin = enrollUrl ? new URL(enrollUrl).origin : null;
  const altOrigin = enrollAltUrl ? new URL(enrollAltUrl).origin : null;

  return (
    <div className="dialog-body">
      {origin ? (
        <>
          <p className="dialog-note">
            Run one of these on the machine you want to add. It installs the hub there
            under <code>~/.termscape</code> and connects back on its own.
          </p>
          <div className="join-os">macOS · Linux</div>
          <CopyLine text={`curl -fsSL ${origin}/join.sh | sh`} />
          <div className="join-os">Windows (PowerShell)</div>
          <CopyLine text={`irm ${origin}/join.ps1 | iex`} />
          {altOrigin && (
            <p className="dialog-note">
              If that machine cannot resolve this one by name, use <code>{altOrigin}</code>{' '}
              in place of <code>{origin}</code>.
            </p>
          )}
          <p className="dialog-note">
            It needs Node 22 or newer, and fetches its own copy if it has none. Its agents
            keep running if the link drops, and it rejoins by itself. The same commands
            are on <code>{enrollUrl}</code>.
          </p>
        </>
      ) : (
        <p className="dialog-note">
          This hub has no join page. Either it was started with{' '}
          <code>--listen loopback</code>, or this machine has no network address another
          machine could reach it on — the hub's own startup banner says which. Use the{' '}
          <strong>ssh</strong> tab meanwhile: it needs no join page, only a machine you
          can reach.
        </p>
      )}
      <footer className="dialog-actions">
        <button className="btn" type="button" onClick={closeDialog}>
          close
        </button>
      </footer>
    </div>
  );
}

/** The push path, for a machine you can reach but cannot stand in front of. */
export function SshForm() {
  const client = useStore((s) => s.client);
  const [label, setLabel] = useState('');
  const [sshUser, setSshUser] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [keyPath, setKeyPath] = useState('');

  return (
    <DialogForm
      submitLabel="add machine"
      canSubmit={sshHost.trim().length > 0 && sshUser.trim().length > 0}
      onSubmit={() =>
        client
          ? client.request({
              t: 'addHost',
              label: label.trim(),
              sshHost: sshHost.trim(),
              sshUser: sshUser.trim(),
              sshPort: Number(sshPort) || 22,
              privateKeyPath: keyPath.trim() || undefined,
            })
          : Promise.reject(new Error('not connected to the hub'))
      }
    >
      <div className="dialog-row">
        <Field label="user">
          <input
            className="input"
            value={sshUser}
            onChange={(e) => setSshUser(e.target.value)}
          />
        </Field>
        <Field label="host">
          <input
            className="input"
            value={sshHost}
            onChange={(e) => setSshHost(e.target.value)}
          />
        </Field>
        <Field label="port">
          <input
            className="input tiny"
            value={sshPort}
            onChange={(e) => setSshPort(e.target.value)}
          />
        </Field>
      </div>
      <Field label="label" hint="Optional. Defaults to user@host.">
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="private key" hint="Leave blank to use your ssh agent.">
        <input
          className="input"
          placeholder="path to a private key"
          value={keyPath}
          onChange={(e) => setKeyPath(e.target.value)}
        />
      </Field>
      <p className="dialog-note">
        The hub is deployed over ssh and listens only on that machine's loopback
        interface, reached through the tunnel. Its agents keep running if the connection
        drops. The connection is made as soon as you add it.
      </p>
    </DialogForm>
  );
}
