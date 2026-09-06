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

/**
 * The pull path. Nothing to fill in: the other machine fetches the installer
 * itself, which is the point - no credentials are typed here, and an install
 * failure shows up in the terminal of whoever can fix it.
 */
export function JoinInstructions() {
  const { enrollUrl, enrollAltUrl } = useStore(
    useShallow((s) => ({ enrollUrl: s.enrollUrl, enrollAltUrl: s.enrollAltUrl })),
  );
  const closeDialog = useStore((s) => s.closeDialog);
  const [copied, setCopied] = useState(false);

  return (
    <div className="dialog-body">
      {enrollUrl ? (
        <>
          <p className="dialog-note">
            Open this on the machine you want to add. It installs the hub there and
            connects back on its own.
          </p>
          <div className="join-url">
            <code>{enrollUrl}</code>
            <button
              className="btn"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(enrollUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
          {enrollAltUrl && (
            <p className="dialog-note">
              If that machine cannot resolve this one by name, use <code>{enrollAltUrl}</code>{' '}
              instead.
            </p>
          )}
          <p className="dialog-note">
            It needs Node 22 or newer. Its agents keep running if the link drops, and it
            rejoins by itself.
          </p>
        </>
      ) : (
        <p className="dialog-note">
          Handing out a join link is opt-in: <code>/join</code> is the one page served
          without your token, because it has to be typed by hand on a machine that has
          nothing yet. Restart the hub with <code>--listen lan</code> to turn it on.
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
