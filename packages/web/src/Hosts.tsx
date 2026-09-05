import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './state/store.js';

const STATE_COLOR: Record<string, string> = {
  connected: '#88c07a',
  connecting: '#d8b271',
  disconnected: '#7c8596',
  error: '#e06c75',
};

/** Add and monitor remote machines running their own hub. */
export function Hosts() {
  const { hosts, hostLogs, enrollUrl, enrollAltUrl, client } = useStore(
    useShallow((s) => ({
      hosts: s.hosts,
      hostLogs: s.hostLogs,
      enrollUrl: s.enrollUrl,
      enrollAltUrl: s.enrollAltUrl,
      client: s.client,
    })),
  );
  const [open, setOpen] = useState(false);
  // The join flow needs nothing from the user, so it leads.
  const [tab, setTab] = useState<'join' | 'ssh'>('join');

  const connected = hosts.filter((h) => h.state === 'connected').length;

  return (
    <div className="hosts-wrap">
      <button className="btn" onClick={() => setOpen((v) => !v)}>
        hosts ({connected}/{hosts.length})
      </button>

      {open && (
        <div className="hosts-panel">
          {hosts.length === 0 && (
            <div className="msg-empty">
              No remote hosts. Add one to run agents on another machine.
            </div>
          )}

          {hosts.map((h) => {
            const log = hostLogs[h.id] ?? [];
            return (
              <div key={h.id} className="host-row">
                <span
                  className="dot"
                  style={{ background: STATE_COLOR[h.state] ?? '#7c8596' }}
                />
                <div className="host-main">
                  <div className="host-label">{h.label}</div>
                  <div className="host-sub">
                    {h.kind === 'enrolled'
                      ? h.platform ?? 'joined'
                      : `${h.sshUser}@${h.sshHost}:${h.sshPort}`}
                    {h.hubVersion ? ` · hub ${h.hubVersion}` : ''}
                  </div>
                  {h.error && <div className="host-error">{h.error}</div>}
                  {h.state === 'connecting' && log.length > 0 && (
                    <div className="host-log">
                      {log.map((line, i) => (
                        <div key={i}>{line}</div>
                      ))}
                    </div>
                  )}
                </div>
                {/* An enrolled host reaches us, so there is nothing here to
                    dial; only a deployed one can be reconnected from here. */}
                {h.kind === 'ssh' && (
                  <button
                    className="btn"
                    title="Reconnect and redeploy if needed"
                    onClick={() => client?.send({ t: 'connectHost', hostId: h.id })}
                  >
                    {h.state === 'connected' ? 'reconnect' : 'connect'}
                  </button>
                )}
                <button
                  className="btn danger"
                  title="Remove this host"
                  onClick={() => client?.send({ t: 'removeHost', hostId: h.id })}
                >
                  ×
                </button>
              </div>
            );
          })}

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
          </div>

          {tab === 'join' ? (
            <JoinTab enrollUrl={enrollUrl} enrollAltUrl={enrollAltUrl} />
          ) : (
            <SshForm />
          )}
        </div>
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
          This hub is bound to loopback, so no other machine can reach it.
          Restart it with <code>--listen lan</code> to hand out a join link.
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
