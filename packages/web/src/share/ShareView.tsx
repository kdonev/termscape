import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store.js';
import { TerminalView } from '../window/Terminal.js';
import { statusColor, statusLabel } from '../window/status.js';

/**
 * What a share link opens: one terminal, full page, nothing else.
 *
 * No canvas, no panel, no toolbar, no other agent's name anywhere - the
 * filtered `ready` a scoped socket receives already holds at most this one
 * session, so there is nothing else here to draw even if this component
 * tried to. The terminal itself is rendered with `grid="follow"`: this view
 * must never drive the PTY's size, only fit itself to whatever grid the
 * owner's window already has - see the note on that prop in Terminal.tsx for
 * why two browsers fighting over one PTY's grid corrupts the *owner's*
 * screen, not this one.
 */
export function ShareView() {
  const { connected, sessions, client } = useStore(
    useShallow((s) => ({ connected: s.connected, sessions: s.sessions, client: s.client })),
  );
  const session = sessions[0];

  // "Still connecting" and "was connected, then the session went away" read
  // very differently to whoever holds this link, and `connected` alone
  // cannot tell them apart - both are simply false. This is the one bit of
  // memory needed to tell them apart.
  const everConnectedRef = useRef(false);
  if (connected) everConnectedRef.current = true;

  const bodyRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // The hub says so once, right before closing the socket - see the note in
  // net/client.ts on why this is latched rather than read off `connected`
  // alone, which a plain dropped connection also makes false.
  if (client?.rejected) {
    return <Message>This link no longer works. It may have been revoked.</Message>;
  }

  if (!connected) {
    return <Message>{everConnectedRef.current ? 'Reconnecting…' : 'Connecting…'}</Message>;
  }

  if (!session) {
    return <Message>This terminal no longer exists.</Message>;
  }

  return (
    <div className="share-app">
      <header className="share-header">
        <span className="dot" style={{ background: statusColor(session) }} />
        <span className="addr">{session.title || session.address}</span>
        <span className="meta">{session.statusText ?? statusLabel(session)}</span>
      </header>
      <div className="share-body" ref={bodyRef}>
        {size.w > 0 && size.h > 0 && (
          <TerminalView
            sessionId={session.id}
            w={size.w}
            h={size.h}
            renderScale={1}
            focused
            grid="follow"
            cols={session.cols}
            rows={session.rows}
          />
        )}
      </div>
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="share-app">
      <div className="share-message">{children}</div>
    </div>
  );
}
