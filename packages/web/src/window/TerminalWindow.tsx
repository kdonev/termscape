import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session, Workspace } from '@aicanvas/protocol';
import { useStore } from '../state/store.js';
import { TerminalView } from './Terminal.js';
import { LIVE_ZOOM_THRESHOLD } from '../canvas/viewport.js';

interface Props {
  session: Session;
  workspace: Workspace | undefined;
  zoom: number;
  live: boolean;
  selected: boolean;
}

const MIN_W = 320;
const MIN_H = 200;

/** Status chip colour follows the agent's activity, not its process state. */
function statusColor(s: Session): string {
  if (s.state === 'running') return s.status === 'busy' ? '#d8b271' : '#88c07a';
  if (s.state === 'failed') return '#e06c75';
  if (s.state === 'exited') return '#4a5262';
  return '#7c8596';
}

function statusLabel(s: Session): string {
  if (s.state !== 'running') return s.state;
  return s.status === 'busy' ? 'working' : s.status === 'idle' ? 'idle' : 'running';
}

export const TerminalWindow = memo(function TerminalWindow({
  session,
  workspace,
  zoom,
  live,
  selected,
}: Props) {
  const { moveWindow, select, client } = useStore(useShallow((s) => ({
    moveWindow: s.moveWindow,
    select: s.select,
    client: s.client,
  })));
  const [drag, setDrag] = useState<null | { mode: 'move' | 'resize'; ox: number; oy: number }>(
    null,
  );
  const rectRef = useRef(session.window);
  rectRef.current = session.window;

  const onPointerDown = useCallback(
    (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      select(session.id);
      setDrag({ mode, ox: e.clientX, oy: e.clientY });
    },
    [select, session.id],
  );

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      // Divide by zoom so a drag tracks the cursor in world space rather than
      // running away from it when zoomed out.
      const dx = (e.clientX - drag.ox) / zoom;
      const dy = (e.clientY - drag.oy) / zoom;
      const r = rectRef.current;
      moveWindow(
        session.id,
        drag.mode === 'move'
          ? { ...r, x: r.x + dx, y: r.y + dy }
          : { ...r, w: Math.max(MIN_W, r.w + dx), h: Math.max(MIN_H, r.h + dy) },
      );
      setDrag({ ...drag, ox: e.clientX, oy: e.clientY });
    };
    const onUp = () => setDrag(null);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, moveWindow, session.id, zoom]);

  const { x, y, w, h } = session.window;
  const stopped = session.state !== 'running';

  return (
    <div
      className={`window${selected ? ' selected' : ''}${stopped ? ' stopped' : ''}`}
      style={{
        transform: `translate(${x}px, ${y}px)`,
        width: w,
        height: h,
        zIndex: session.window.z + (selected ? 1000 : 0),
        borderColor: selected ? '#7c9cf5' : workspace?.color ?? '#2a3040',
      }}
      onPointerDown={() => select(session.id)}
    >
      <header className="window-bar" onPointerDown={onPointerDown('move')}>
        <span className="dot" style={{ background: statusColor(session) }} />
        <span className="addr">{session.address}</span>
        <span className="meta">
          {session.statusText ?? statusLabel(session)}
        </span>
        <span className="spacer" />
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
        {live ? (
          <TerminalView sessionId={session.id} w={w} h={h} focused={selected} />
        ) : (
          <LodPlaceholder session={session} zoom={zoom} />
        )}
      </div>

      <div className="resize-handle" onPointerDown={onPointerDown('resize')} />
    </div>
  );
});

/**
 * What a window shows when it is zoomed out or offscreen. Deliberately cheap:
 * no terminal, no parsing, no stream subscription.
 */
function LodPlaceholder({ session, zoom }: { session: Session; zoom: number }) {
  return (
    <div className="lod">
      <div className="lod-title">{session.address}</div>
      <div className="lod-sub">
        {session.profile} · {statusLabel(session)}
      </div>
      {session.statusText && <div className="lod-status">{session.statusText}</div>}
      {zoom < LIVE_ZOOM_THRESHOLD && (
        <div className="lod-hint">zoom in to interact</div>
      )}
    </div>
  );
}
