import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session, Workspace } from '@termscape/protocol';
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

/**
 * `.window`'s border as written in the CSS, in world px. What it is laid out
 * at is measured below: browsers snap borders to whole device pixels, so at
 * dpr 1.5 this is 0.667px, and assuming 1 put the terminal a third of a
 * pixel off and its frame two thirds of one too wide.
 */
const BORDER = 1;
/** Padding between the window body and the terminal, in world px. */
const INSET_X = 6;
const INSET_Y = 4;

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
  const [drag, setDrag] = useState<null | { mode: 'move' | 'resize'; ox: number; oy: number }>(
    null,
  );
  const rectRef = useRef(session.window);
  rectRef.current = session.window;

  // The title bar's height, which the terminal area is the rest of. Measured
  // rather than written down, because it is a line box around buttons - and
  // fractional, which offsetHeight would round away, leaving the terminal a
  // fraction of a pixel off the grid its origin is snapped to. The observer's
  // border box is the exact layout size, untouched by the world transform.
  const headerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState<number | null>(null);
  const windowRef = useRef<HTMLDivElement>(null);
  const [border, setBorder] = useState(BORDER);
  useLayoutEffect(() => {
    const el = windowRef.current;
    if (!el) return;
    const measured = parseFloat(getComputedStyle(el).borderLeftWidth);
    if (Number.isFinite(measured)) setBorder(measured);
  }, [dpr]);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.borderBoxSize?.[0]?.blockSize;
      if (size !== undefined) setHeaderH(size);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // What xterm actually drew, in world px. See the frame note below.
  const [content, setContent] = useState<{ w: number; h: number } | null>(null);
  const onContentSize = useCallback((next: { w: number; h: number }) => {
    setContent((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
  }, []);

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

  // Paint on a whole device pixel. Dragging divides by zoom, so x/y drift
  // fractional, and a terminal canvas that starts mid-pixel gets resampled into
  // blur however well its bitmap is sized. The stored rect keeps its exact
  // value, so this never fights the drag handler or the hub.
  const px = snapWorldPx(x, zoom, dpr);
  const py = snapWorldPx(y, zoom, dpr);

  /*
   * The frame hugs the terminal (issue 32).
   *
   * The grid is fixed by the stored rect so zooming never reflows, and xterm
   * draws it in whole device pixels so the text stays sharp - which together
   * mean the terminal's size in world px moves a little with every zoom step,
   * and no font choice can make it fill an arbitrary area exactly. So the
   * window is painted around what xterm drew rather than the other way round:
   * the stored rect only decides the grid, and gridFor's bound keeps the
   * painted frame from ever outgrowing it.
   *
   * The terminal's origin is snapped for the same reason the window's is: a
   * whole-pixel bitmap that starts mid-pixel is resampled into blur anyway,
   * and border + title bar + inset times the zoom rarely lands on one.
   */
  const areaW = w - 2 * BORDER - 2 * INSET_X;
  const areaH = headerH === null ? 0 : h - 2 * BORDER - headerH - 2 * INSET_Y;
  const bar = headerH ?? 0;
  const hostLeft = snapWorldPx(border + INSET_X, zoom, dpr) - border;
  const hostTop = snapWorldPx(border + bar + INSET_Y, zoom, dpr) - border - bar;
  const frameW = content ? 2 * border + hostLeft + content.w + INSET_X : w;
  const frameH = content && headerH !== null ? 2 * border + bar + hostTop + content.h + INSET_Y : h;

  return (
    <div
      ref={windowRef}
      className={`window${selected ? ' selected' : ''}${stopped ? ' stopped' : ''}`}
      style={{
        transform: `translate(${px}px, ${py}px)`,
        width: frameW,
        height: frameH,
        zIndex: session.window.z + (selected ? 1000 : 0),
        borderColor: selected ? '#7c9cf5' : workspace?.color ?? '#2a3040',
      }}
      onPointerDown={() => select(session.id)}
    >
      <header className="window-bar" ref={headerRef} onPointerDown={onPointerDown('move')}>
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
          w={areaW}
          h={areaH}
          dpr={dpr}
          placement={{ left: hostLeft, top: hostTop, right: INSET_X, bottom: INSET_Y }}
          onContentSize={onContentSize}
          renderScale={renderScale}
          focused={selected}
        />
      </div>

      <div className="resize-handle" onPointerDown={onPointerDown('resize')} />
    </div>
  );
});
