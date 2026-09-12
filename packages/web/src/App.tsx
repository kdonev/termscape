import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Canvas } from './canvas/Canvas.js';
import { Toolbar } from './Toolbar.js';
import { Panel } from './panel/Panel.js';
import { Dialogs } from './dialog/Dialogs.js';
import { useStore } from './state/store.js';
import { HubClient } from './net/client.js';
import { shareTokenFromPath } from './share/route.js';
import { ShareView } from './share/ShareView.js';

/** Set once at load and never re-read: the route a page opened with is the
 * route it stays on, the same way the canvas token in resolveToken is only
 * ever read once. */
const shareToken = shareTokenFromPath(window.location.pathname);

/** Token comes from the URL the hub printed, then is kept in session storage. */
function resolveToken(): string {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    sessionStorage.setItem('termscape-token', fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.toString());
    return fromUrl;
  }
  return sessionStorage.getItem('termscape-token') ?? '';
}

export function App() {
  const {
    init,
    apply,
    setConnected,
    errors,
    dismissError,
    sessions,
    connected,
    setPanelOpen,
  } = useStore(
    useShallow((s) => ({
      init: s.init,
      apply: s.apply,
      setConnected: s.setConnected,
      errors: s.errors,
      dismissError: s.dismissError,
      sessions: s.sessions,
      connected: s.connected,
      setPanelOpen: s.setPanelOpen,
    })),
  );

  useEffect(() => {
    // A share link carries its own token in the path and skips resolveToken
    // entirely - that helper's job is stripping a `?token=` into
    // sessionStorage, which is exactly the durability a bookmarked share link
    // must not have (see route.ts).
    const token = shareToken ?? resolveToken();
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const client = new HubClient(
      `${proto}://${window.location.host}/ws`,
      token,
      apply,
      setConnected,
    );
    init(client);
    client.connect();
    return () => client.close();
  }, [init, apply, setConnected]);

  // A share link renders nothing else - no canvas, no panel, no toolbar - by
  // construction: it is the same `HubClient`, the same store, the same
  // `apply`, but `ready` for a scoped socket already holds exactly one
  // session, so there would be nothing else on the canvas to show anyway.
  if (shareToken) return <ShareView />;

  return (
    <div className="app">
      <Toolbar />
      <Canvas />
      <Panel />
      <Dialogs />

      {sessions.length === 0 && connected && (
        <div className="empty-state">
          <h1>Nothing running yet</h1>
          <p>
            Open the machines panel, point a workspace at a folder, and start
            an agent in it. Agents in the same workspace can find each other,
            message each other, and spawn helpers.
          </p>
          <p className="hint">
            Scroll to pan · Ctrl/⌘ + scroll to zoom · Ctrl/⌘ + 1 to fit
          </p>
          <button className="btn primary" onClick={() => setPanelOpen(true)}>
            open the machines panel
          </button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="errors">
          {errors.map((e, i) => (
            <div key={i} className="error">
              {/* The message is not a dismiss button: selecting an error to
                  copy it is the usual reason for wanting it to stay. */}
              <span className="error-body">{e}</span>
              <button
                className="error-close"
                title="Dismiss"
                aria-label="Dismiss this error"
                onClick={() => dismissError(i)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
