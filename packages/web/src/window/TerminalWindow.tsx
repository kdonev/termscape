import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session, WindowRect, Workspace } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import { TerminalView } from './Terminal.js';
import { snapWorldPx } from '../canvas/viewport.js';
import { statusColor, statusLabel } from './status.js';

interface Props {
  session: Session;
  workspace: Workspace | undefined;
  zoom: number;
  dpr: number;
  /** Shared by every window, so all terminals show the same size text. */
  renderScale: number;
  selected: boolean;
  /** True while the canvas is zoomed to this window. */
  maximized: boolean;
  onMaximize: (sessionId: string) => void;
}

const MIN_W = 320;
const MIN_H = 200;

export const TerminalWindow = memo(function TerminalWindow({
  session,
  workspace,
  zoom,
  dpr,
  renderScale,
  selected,
  maximized,
  onMaximize,
}: Props) {
  const { moveWindow, select, client, shared, openDialog } = useStore(useShallow((s) => ({
    moveWindow: s.moveWindow,
    select: s.select,
    client: s.client,
    shared: s.shares.some((sh) => sh.sessionId === session.id),
    openDialog: s.openDialog,
  })));
  const [drag, setDrag] = useState<null | {
    mode: 'move' | 'resize';
    ox: number;
    oy: number;
    start: WindowRect;
  }>(null);
  const rectRef = useRef(session.window);
  rectRef.current = session.window;

  const onPointerDown = useCallback(
    (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      select(session.id);
      setDrag({ mode, ox: e.clientX, oy: e.clientY, start: rectRef.current });
    },
    [select, session.id],
  );

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      // Measured from the grab, never added to the current rect. A step-wise
      // delta counts a move twice whenever an event lands between the store
      // re-render and this effect picking up the new origin, which on a busy
      // canvas sends the window running off ahead of the cursor (#43). It also
      // means a session update carrying an older rect cannot pull the window
      // back mid-drag. Divided by zoom so it tracks the cursor in world space.
      const dx = (e.clientX - drag.ox) / zoom;
      const dy = (e.clientY - drag.oy) / zoom;
      const r = rectRef.current;
      const s = drag.start;
      moveWindow(
        session.id,
        drag.mode === 'move'
          ? { ...r, x: s.x + dx, y: s.y + dy }
          : { ...r, w: Math.max(MIN_W, s.w + dx), h: Math.max(MIN_H, s.h + dy) },
      );
    };
    const onUp = () => setDrag(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, moveWindow, session.id, zoom]);

  const { x, y, w, h } = session.window;
  const stopped = session.state !== 'running';

  // Paint on a whole device pixel. Dragging divides by zoom, so x/y drift
  // fractional, and a terminal canvas that starts mid-pixel gets resampled into
  // blur however well its bitmap is sized. The stored rect keeps its exact
  // value, so this never fights the drag handler or the hub.
  const px = snapWorldPx(x, zoom, dpr);
  const py = snapWorldPx(y, zoom, dpr);

  return (
    <div
      className={`window${selected ? ' selected' : ''}${stopped ? ' stopped' : ''}`}
      style={{
        transform: `translate(${px}px, ${py}px)`,
        width: w,
        height: h,
        zIndex: session.window.z + (selected ? 1000 : 0),
        borderColor: selected ? '#7c9cf5' : workspace?.color ?? '#2a3040',
      }}
      onPointerDown={() => select(session.id)}
    >
      <header className="window-bar" onPointerDown={onPointerDown('move')}>
        <span className="dot" style={{ background: statusColor(session) }} />
        {/* The program's own title when it set one - it says what the agent
            is doing, which the canvas address never can. The address stays a
            hover away, because it is how you message this window. */}
        <span className="addr" title={session.address}>
          {session.title || session.address}
        </span>
        <span className="meta">
          {session.statusText ?? statusLabel(session)}
        </span>
        <span className="spacer" />
        {/*
          Offered for stopped windows too: zooming in to read an agent's last
          output is exactly as useful as zooming in to type at a live one.
        */}
        <button
          className="btn"
          title={
            maximized
              ? 'Back to the previous view (Ctrl+2)'
              : 'Zoom the canvas to this terminal (Ctrl+2)'
          }
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onMaximize(session.id)}
        >
          {maximized ? '⤡' : '⤢'}
        </button>
        {/*
          Opens a dialog rather than acting immediately - this is a real grant
          of a keyboard on an agent that can run commands, and the dialog is
          where that gets said plainly. `on` reflects whether a link already
          exists so a second click finds the same one rather than looking like
          nothing happened.
        */}
        <button
          className={`btn${shared ? ' on' : ''}`}
          title={shared ? 'Manage this terminal’s share link' : 'Share this terminal by link'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => openDialog({ kind: 'share', sessionId: session.id })}
        >
          share
        </button>
        {stopped && (
          // Both paths call resumeSession. For a resumable profile the hub
          // swaps in --resume and the conversation continues; for one without
          // resume support it relaunches clean. Either way the window must
          // offer a way back, or a stopped session is only ever deletable.
          <button
            className="btn"
            title={
              session.resumable
                ? 'Relaunch with its previous conversation'
                : 'Restart this session (this profile cannot resume a conversation)'
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => client?.send({ t: 'resumeSession', sessionId: session.id })}
          >
            {session.resumable ? 'resume' : 'restart'}
          </button>
        )}
        {!stopped && (
          // A restart rather than typing `/clear` at the CLI: the opening
          // instruction was conversation, and a clear throws it away. The hub
          // relaunches the agent on a blank screen and types it in again.
          <button
            className="btn"
            title="Restart with a fresh conversation and send its opening instruction again"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => client?.send({ t: 'clearSession', sessionId: session.id })}
          >
            clear
          </button>
        )}
        {!stopped && (
          <button
            className="btn"
            title="Stop this agent"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => client?.send({ t: 'stopSession', sessionId: session.id })}
          >
            stop
          </button>
        )}
        <button
          className="btn danger"
          title="Remove this window and forget the session"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => client?.send({ t: 'removeSession', sessionId: session.id })}
        >
          ×
        </button>
      </header>

      <div className="window-body">
        {/* Always a real terminal, at every zoom. See the culling note in
            Canvas.tsx for why there is no cheap card underneath this. */}
        <TerminalView
          sessionId={session.id}
          w={w}
          h={h}
          renderScale={renderScale}
          focused={selected}
        />
      </div>

      <div className="resize-handle" onPointerDown={onPointerDown('resize')} />
    </div>
  );
});
