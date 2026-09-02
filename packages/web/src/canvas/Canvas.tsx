import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store.js';
import { TerminalWindow } from '../window/TerminalWindow.js';
import { MessageEdges } from './MessageEdges.js';
import {
  LIVE_ZOOM_THRESHOLD,
  clampZoom,
  fitTo,
  rectsIntersect,
  visibleWorldRect,
  zoomAt,
} from './viewport.js';

/**
 * The infinite canvas.
 *
 * One world layer carries a single CSS transform; every window is positioned
 * in world coordinates inside it. Panning therefore changes one transform
 * rather than N layout positions, which is what keeps it smooth with many
 * windows on screen.
 */
export function Canvas() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ x: number; y: number } | null>(null);

  const { sessions, workspaces, viewport, setViewport, selectedId, select } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      workspaces: s.workspaces,
      viewport: s.viewport,
      setViewport: s.setViewport,
      selectedId: s.selectedId,
      select: s.select,
    })),
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /* ------------------------------------------------------------ wheel */

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Registered natively and non-passive: React's synthetic wheel handler is
    // passive, so preventDefault there would not stop the browser's own zoom.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      if (e.ctrlKey || e.metaKey) {
        setViewport(zoomAt(viewport, point, viewport.zoom * (1 - e.deltaY * 0.01)));
      } else {
        setViewport({
          ...viewport,
          panX: viewport.panX - e.deltaX,
          panY: viewport.panY - e.deltaY,
        });
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport, setViewport]);

  /* -------------------------------------------------------------- pan */

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Empty canvas, middle button, or space-drag starts a pan.
      if (e.target !== e.currentTarget && e.button !== 1) return;
      if (e.button === 0) select(null);
      panRef.current = { x: e.clientX, y: e.clientY };
      setPanning(true);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [select],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const p = panRef.current;
      if (!p) return;
      setViewport({
        ...viewport,
        panX: viewport.panX + (e.clientX - p.x),
        panY: viewport.panY + (e.clientY - p.y),
      });
      panRef.current = { x: e.clientX, y: e.clientY };
    },
    [viewport, setViewport],
  );

  const endPan = useCallback(() => {
    panRef.current = null;
    setPanning(false);
  }, []);

  /* ----------------------------------------------------- keyboard nav */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from a focused terminal.
      const inTerminal = (e.target as HTMLElement)?.closest?.('.term-host');
      if (inTerminal) return;

      if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setViewport({ panX: 0, panY: 0, zoom: 1 });
      }
      if (e.key === '1' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setViewport(
          fitTo(
            sessions.map((s) => s.window),
            size.w,
            size.h,
          ),
        );
      }
      if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, size, setViewport, select]);

  /* ------------------------------------------------ LOD + culling */

  const visible = useMemo(
    () => visibleWorldRect(viewport, size.w, size.h),
    [viewport, size],
  );

  const wsById = useMemo(
    () => new Map(workspaces.map((w) => [w.id, w])),
    [workspaces],
  );

  const decorated = useMemo(
    () =>
      sessions.map((s) => {
        const onScreen = rectsIntersect(visible, s.window);
        return {
          session: s,
          // A terminal is live only when it is both readable and on screen.
          live: onScreen && viewport.zoom >= LIVE_ZOOM_THRESHOLD,
          onScreen,
        };
      }),
    [sessions, visible, viewport.zoom],
  );

  /* --------------------------------------------- workspace grouping */

  const groups = useMemo(() => {
    const out: { ws: (typeof workspaces)[number]; x: number; y: number; w: number; h: number }[] =
      [];
    for (const ws of workspaces) {
      const members = sessions.filter((s) => s.workspaceId === ws.id);
      if (members.length === 0) continue;
      const pad = 28;
      const minX = Math.min(...members.map((m) => m.window.x)) - pad;
      const minY = Math.min(...members.map((m) => m.window.y)) - pad - 24;
      const maxX = Math.max(...members.map((m) => m.window.x + m.window.w)) + pad;
      const maxY = Math.max(...members.map((m) => m.window.y + m.window.h)) + pad;
      out.push({ ws, x: minX, y: minY, w: maxX - minX, h: maxY - minY });
    }
    return out;
  }, [workspaces, sessions]);

  return (
    <div
      ref={ref}
      className={`canvas${panning ? ' panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <div
        className="world"
        style={{
          transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
        }}
      >
        {groups.map((g) => (
          <div
            key={g.ws.id}
            className="ws-group"
            style={{
              transform: `translate(${g.x}px, ${g.y}px)`,
              width: g.w,
              height: g.h,
              borderColor: g.ws.color,
            }}
          >
            <span className="ws-label" style={{ color: g.ws.color }}>
              {g.ws.name}
              <span className="ws-path">{g.ws.rootPath}</span>
            </span>
          </div>
        ))}

        <MessageEdges sessions={sessions} />

        {decorated.map(({ session, live, onScreen }) =>
          onScreen ? (
            <TerminalWindow
              key={session.id}
              session={session}
              workspace={wsById.get(session.workspaceId)}
              zoom={viewport.zoom}
              live={live}
              selected={selectedId === session.id}
            />
          ) : null,
        )}
      </div>

      <ZoomIndicator
        zoom={viewport.zoom}
        onReset={() => setViewport({ panX: 0, panY: 0, zoom: 1 })}
        onFit={() =>
          setViewport(fitTo(sessions.map((s) => s.window), size.w, size.h))
        }
        onZoom={(dir) =>
          setViewport(
            zoomAt(
              viewport,
              { x: size.w / 2, y: size.h / 2 },
              clampZoom(viewport.zoom * (dir > 0 ? 1.2 : 1 / 1.2)),
            ),
          )
        }
      />
    </div>
  );
}

function ZoomIndicator({
  zoom,
  onReset,
  onFit,
  onZoom,
}: {
  zoom: number;
  onReset: () => void;
  onFit: () => void;
  onZoom: (dir: number) => void;
}) {
  return (
    <div className="zoom-bar">
      <button className="btn" onClick={() => onZoom(-1)} title="Zoom out">
        −
      </button>
      <button className="btn wide" onClick={onReset} title="Reset to 100%">
        {Math.round(zoom * 100)}%
      </button>
      <button className="btn" onClick={() => onZoom(1)} title="Zoom in">
        +
      </button>
      <button className="btn" onClick={onFit} title="Fit all windows (Ctrl+1)">
        fit
      </button>
      {zoom < LIVE_ZOOM_THRESHOLD && <span className="lod-badge">preview</span>}
    </div>
  );
}
