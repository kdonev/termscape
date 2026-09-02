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
  const { hosts, client } = useStore(
    useShallow((s) => ({ hosts: s.hosts, client: s.client })),
  );
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    label: '',
    sshHost: '',
    sshUser: '',
    sshPort: '22',
    privateKeyPath: '',
  });

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

          {hosts.map((h) => (
            <div key={h.id} className="host-row">
              <span className="dot" style={{ background: STATE_COLOR[h.state] ?? '#7c8596' }} />
              <div className="host-main">
                <div className="host-label">{h.label}</div>
                <div className="host-sub">
                  {h.sshUser}@{h.sshHost}:{h.sshPort}
                  {h.hubVersion ? ` · hub ${h.hubVersion}` : ''}
                </div>
                {h.error && <div className="host-error">{h.error}</div>}
              </div>
              <button
                className="btn"
                title="Reconnect and redeploy if needed"
                onClick={() => client?.send({ t: 'connectHost', hostId: h.id })}
              >
                {h.state === 'connected' ? 'reconnect' : 'connect'}
              </button>
              <button
                className="btn danger"
                title="Remove this host"
                onClick={() => client?.send({ t: 'removeHost', hostId: h.id })}
              >
                ×
              </button>
            </div>
          ))}

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
              The hub is deployed over SSH and listens only on the remote
              machine's loopback interface, reachable through the tunnel.
              Agents there keep running if the connection drops.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
