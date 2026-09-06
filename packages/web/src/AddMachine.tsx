import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './state/store.js';

/**
 * Attaching a machine, both directions.
 *
 * The tree panel lists the machines already attached; this is the last node
 * under it, and the only place either of these forms appears. The join flow
 * needs nothing from the user, so it leads.
 */
export function AddMachine() {
  const { enrollUrl, enrollAltUrl } = useStore(
    useShallow((s) => ({ enrollUrl: s.enrollUrl, enrollAltUrl: s.enrollAltUrl })),
  );
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'join' | 'ssh'>('join');

  if (!open) {
    return (
      <button className="btn add-machine" onClick={() => setOpen(true)}>
        + machine
      </button>
    );
  }

  return (
    <div className="add-machine-panel">
      <div className="host-tabs">
        <button
          className={`tab ${tab === 'join' ? 'on' : ''}`}
          onClick={() => setTab('join')}
        >
          join from that machine
        </button>
        <button
          className={`tab ${tab === 'ssh' ? 'on' : ''}`}
          onClick={() => setTab('ssh')}
        >
          deploy over ssh
        </button>
        <span className="spacer" />
        <button className="btn" onClick={() => setOpen(false)}>
          close
        </button>
      </div>

      {tab === 'join' ? (
        <JoinTab enrollUrl={enrollUrl} enrollAltUrl={enrollAltUrl} />
      ) : (
        <SshForm />
      )}
    </div>
  );
}

/**
 * The pull path. Nothing to fill in here: the other machine fetches the
 * installer itself, which is the point — no credentials are typed, and an
 * install failure shows up in the terminal of whoever can fix it.
 */
function JoinTab({
  enrollUrl,
  enrollAltUrl,
}: {
  enrollUrl: string | null;
  enrollAltUrl: string | null;
}) {
  const [copied, setCopied] = useState(false);

  if (!enrollUrl) {
    return (
      <div className="host-form">
        <p className="host-note">
          Handing out a join link is opt-in: <code>/join</code> is the one page
          served without your token, because it has to be typed by hand on a
          machine that has nothing yet. Restart the hub with{' '}
          <code>--listen lan</code> to turn it on.
        </p>
      </div>
    );
  }

  return (
    <div className="host-form">
      <p className="host-note">
        Open this on the machine you want to add. It installs the hub there and
        connects back on its own.
      </p>
      <div className="join-url">
        <code>{enrollUrl}</code>
        <button
          className="btn"
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
        <p className="host-note">
          If that machine cannot resolve this one by name, use{' '}
          <code>{enrollAltUrl}</code> instead.
        </p>
      )}
      <p className="host-note">
        That machine needs Node 22 or newer. It keeps running its own agents if
        the link drops, and rejoins by itself.
      </p>
    </div>
  );
}

/** The push path, for a machine you can reach but cannot stand in front of. */
function SshForm() {
  const client = useStore((s) => s.client);
  const [form, setForm] = useState({
    label: '',
    sshHost: '',
    sshUser: '',
    sshPort: '22',
    privateKeyPath: '',
  });

  return (
    <div className="host-form">
      <input
        className="input"
        placeholder="label"
        value={form.label}
        onChange={(e) => setForm({ ...form, label: e.target.value })}
      />
      <input
        className="input"
        placeholder="user"
        value={form.sshUser}
        onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
      />
      <input
        className="input"
        placeholder="host"
        value={form.sshHost}
        onChange={(e) => setForm({ ...form, sshHost: e.target.value })}
      />
      <input
        className="input tiny"
        placeholder="port"
        value={form.sshPort}
        onChange={(e) => setForm({ ...form, sshPort: e.target.value })}
      />
      <input
        className="input wide"
        placeholder="private key path (blank to use your ssh agent)"
        value={form.privateKeyPath}
        onChange={(e) => setForm({ ...form, privateKeyPath: e.target.value })}
      />
      <button
        className="btn primary"
        disabled={!form.sshHost.trim() || !form.sshUser.trim()}
        onClick={() => {
          client?.send({
            t: 'addHost',
            label: form.label.trim(),
            sshHost: form.sshHost.trim(),
            sshUser: form.sshUser.trim(),
            sshPort: Number(form.sshPort) || 22,
            privateKeyPath: form.privateKeyPath.trim() || undefined,
          });
          setForm({ label: '', sshHost: '', sshUser: '', sshPort: '22', privateKeyPath: '' });
        }}
      >
        add host
      </button>
      <p className="host-note">
        The hub is deployed over SSH and listens only on the remote machine's
        loopback interface, reachable through the tunnel. Agents there keep
        running if the connection drops.
      </p>
    </div>
  );
}
