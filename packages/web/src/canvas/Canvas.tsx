import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../state/store.js';
import { TerminalWindow } from '../window/TerminalWindow.js';
import { MessageEdges } from './MessageEdges.js';
import {
  LIVE_ZOOM_THRESHOLD,
  alignViewport,
  clampZoom,
  fitTo,
  rectsIntersect,
  renderScaleFor,
  visibleWorldRect,
  zoomAt,
} from './viewport.js';

/**
 * How long the viewport must be still before we call a gesture finished.
 * Two things wait on this: dropping `will-change` so the compositor re-rasters
 * the world at its settled scale, and changing the terminals' render scale,
 * which rebuilds their glyph atlases and must not happen per wheel tick.
 */
const SETTLE_MS = 140;

function dpr(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

function sameViewport(a: { panX: number; panY: number; zoom: number }, b: typeof a): boolean {
  return a.panX === b.panX && a.panY === b.panY && a.zoom === b.zoom;
}

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
  // True from the first wheel/drag event until SETTLE_MS after the last one.
  // A superset of `panning`, which only tracks the grab cursor.
  const [interacting, setInteracting] = useState(false);
  const settleRef = useRef<number | null>(null);
  const [devicePixelRatio, setDevicePixelRatio] = useState(dpr);

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

  /* ------------------------------------------------ gesture settling */

  // Read through a ref: the settle timer fires long after the render that armed
  // it, by which point a captured size would be stale.
  const sizeRef = useRef(size);
  sizeRef.current = size;

  /**
   * Align whenever the canvas is at rest. Driving this off the viewport rather
   * than only off the settle timer means a viewport restored from the hub comes
   * up aligned too, instead of staying soft until the first gesture. Safe to
   * run on every change because alignViewport is idempotent.
   */
  useEffect(() => {
    if (interacting) return;
    const aligned = alignViewport(viewport, sizeRef.current.w, sizeRef.current.h, devicePixelRatio);
    if (!sameViewport(aligned, viewport)) setViewport(aligned);
  }, [viewport, interacting, devicePixelRatio, setViewport]);

  const settle = useCallback(() => {
    settleRef.current = null;
    setInteracting(false);
  }, []);

  const markInteracting = useCallback(() => {
    setInteracting(true);
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(settle, SETTLE_MS);
  }, [settle]);

  useEffect(
    () => () => {
      if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    },
    [],
  );

  // Moving the browser window to a monitor with different scaling changes what
  // a device pixel is. Recording the new ratio re-runs the alignment and render
  // scale effects against it; the query has to be rebuilt to watch for the next
  // change, which is why it keys off the ratio it is currently matching.
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    const onChange = () => setDevicePixelRatio(dpr());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [devicePixelRatio]);

  /**
   * One render scale for every terminal on the canvas, so they all show the
   * same size text regardless of their window size. Frozen during a gesture:
   * changing it rebuilds each terminal's glyph atlas.
   */
  const [renderScale, setRenderScale] = useState(() =>
    renderScaleFor(viewport.zoom, dpr()),
  );
  useEffect(() => {
    if (interacting) return;
    const next = renderScaleFor(viewport.zoom, devicePixelRatio);
    setRenderScale((cur) => (cur === next ? cur : next));
  }, [viewport.zoom, devicePixelRatio, interacting]);

  /* ------------------------------------------------------------ wheel */

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Registered natively and non-passive: React's synthetic wheel handler is
    // passive, so preventDefault there would not stop the browser's own zoom.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      markInteracting();
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
  }, [viewport, setViewport, markInteracting]);

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
      markInteracting();
      setViewport({
        ...viewport,
        panX: viewport.panX + (e.clientX - p.x),
        panY: viewport.panY + (e.clientY - p.y),
      });
      panRef.current = { x: e.clientX, y: e.clientY };
    },
    [viewport, setViewport, markInteracting],
  );

  const endPan = useCallback(() => {
    panRef.current = null;
    setPanning(false);
    markInteracting();
  }, [markInteracting]);

  /* ----------------------------------------------------- keyboard nav */

  /**
   * Buttons and shortcuts land on a final viewport in one step, so they cancel
   * any pending settle rather than waiting out one they will never trigger.
   * Alignment itself is left to the effect above.
   */
  const applyViewport = useCallback(
    (next: typeof viewport) => {
      if (settleRef.current !== null) {
        window.clearTimeout(settleRef.current);
        settleRef.current = null;
      }
      setViewport(next);
      setInteracting(false);
    },
    [setViewport],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never steal keys from a focused terminal.
      const inTerminal = (e.target as HTMLElement)?.closest?.('.term-host');
      if (inTerminal) return;

      if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        applyViewport({ panX: 0, panY: 0, zoom: 1 });
      }
      if (e.key === '1' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        applyViewport(
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
  }, [sessions, size, applyViewport, select]);

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
      {/*
        `will-change: transform` is applied only while a gesture is in flight.
        Left on permanently it tells the compositor the transform is animating,
        which suppresses raster-scale recomputation: the layer stays rasterized
        at whatever scale it was promoted at and every zoom after that is a GPU
        resample. Dropping the hint on settle is what re-sharpens the DOM text.
      */}
      <div
        className={`world${interacting ? ' interacting' : ''}`}
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
              dpr={devicePixelRatio}
              renderScale={renderScale}
              live={live}
              selected={selectedId === session.id}
            />
          ) : null,
        )}
      </div>

      <ZoomIndicator
        zoom={viewport.zoom}
        onReset={() => applyViewport({ panX: 0, panY: 0, zoom: 1 })}
        onFit={() =>
          applyViewport(fitTo(sessions.map((s) => s.window), size.w, size.h))
        }
        onZoom={(dir) =>
          applyViewport(
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
