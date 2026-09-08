import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session, Viewport, Workspace } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import { sessionsIn } from '../state/tree.js';
import { TerminalWindow } from '../window/TerminalWindow.js';
import { MessageEdges } from './MessageEdges.js';
import {
  LIVE_ZOOM_THRESHOLD,
  PINCH_GAP_MS,
  alignViewport,
  boundsOf,
  fitTo,
  focusRect,
  isWheelNotch,
  wheelFlickIntent,
  WHEEL_FLICK_GAP_MS,
  lerpViewport,
  pinchIntent,
  rectContainsPoint,
  rectsIntersect,
  renderScaleFor,
  screenToWorld,
  stepOutTo,
  visibleWorldRect,
  wheelStream,
  wheelZoomFactor,
  workspaceBounds,
  zoomAt,
} from './viewport.js';
import type { Point, Rect, WheelStream } from './viewport.js';

/**
 * How long the viewport must be still before we call a gesture finished.
 * Two things wait on this: dropping `will-change` so the compositor re-rasters
 * the world at its settled scale, and changing the terminals' render scale,
 * which rebuilds their glyph atlases and must not happen per wheel tick.
 */
const SETTLE_MS = 140;

/**
 * How long a commanded viewport move takes. Long enough to read as movement —
 * a hard cut straight out of a fluid pinch reads as a glitch — and short
 * enough that it still feels like a shortcut rather than a transition.
 */
const GLIDE_MS = 180;

const easeOut = (t: number) => 1 - (1 - t) ** 3;

function dpr(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

function sameViewport(a: { panX: number; panY: number; zoom: number }, b: typeof a): boolean {
  return a.panX === b.panX && a.panY === b.panY && a.zoom === b.zoom;
}

/** The window whose centre is closest to a world point. */
function nearestSession(sessions: Session[], p: Point): Session | undefined {
  let best: Session | undefined;
  let bestDistance = Infinity;
  for (const s of sessions) {
    const dx = s.window.x + s.window.w / 2 - p.x;
    const dy = s.window.y + s.window.h / 2 - p.y;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) {
      bestDistance = d;
      best = s;
    }
  }
  return best;
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
  /**
   * The wheel gesture in flight and who it belongs to. Held for the length of
   * the gesture rather than re-decided per event, so a pan that started on the
   * canvas is not handed to a window that has since slid under the pointer.
   */
  const streamRef = useRef<WheelStream | null>(null);
  // True from the first wheel/drag event until SETTLE_MS after the last one.
  // A superset of `panning`, which only tracks the grab cursor.
  const [interacting, setInteracting] = useState(false);
  const settleRef = useRef<number | null>(null);
  const [devicePixelRatio, setDevicePixelRatio] = useState(dpr);

  const { sessions, workspaces, viewport, setViewport, selectedId, select, setPanelOpen } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      workspaces: s.workspaces,
      viewport: s.viewport,
      setViewport: s.setViewport,
      selectedId: s.selectedId,
      select: s.select,
      setPanelOpen: s.setPanelOpen,
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

  /* --------------------------------------------------------------- refs */

  // Everything a gesture or a timer needs to read long after the render that
  // armed it, by which point a captured value would be stale. Mirroring them is
  // also what lets the callbacks below keep one identity for the life of the
  // canvas: `onMaximize` is handed to every memoised TerminalWindow, and a new
  // function per viewport change would re-render all of them on every tick.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // The tracked ratio rather than a fresh dpr() read: the alignment effect
  // aligns against this one, and a disagreement would leave `applied` stale.
  const dprRef = useRef(devicePixelRatio);
  dprRef.current = devicePixelRatio;

  /* ------------------------------------------------ gesture settling */

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

  /** An animation in flight, abandoned wherever it is if a gesture arrives. */
  const glideRef = useRef<{ raf: number; startedAt: number } | null>(null);

  const cancelGlide = useCallback(() => {
    const g = glideRef.current;
    if (!g) return;
    glideRef.current = null;
    cancelAnimationFrame(g.raf);
  }, []);

  const markInteracting = useCallback(() => {
    // The hand on the trackpad always wins: an animation still running gives
    // way rather than fighting the gesture for the viewport.
    cancelGlide();
    setInteracting(true);
    if (settleRef.current !== null) window.clearTimeout(settleRef.current);
    settleRef.current = window.setTimeout(settle, SETTLE_MS);
  }, [cancelGlide, settle]);

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

  /* -------------------------------------------------------------- pan */

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Above the pan guard on purpose. Pointer events from a terminal window
      // bubble up to this element, so landing on a window and landing on empty
      // canvas both mean the same thing here: done with the list, back on the
      // canvas. Only the pan below cares which one it was.
      setPanelOpen(false);
      // Empty canvas, middle button, or space-drag starts a pan.
      if (e.target !== e.currentTarget && e.button !== 1) return;
      if (e.button === 0) select(null);
      panRef.current = { x: e.clientX, y: e.clientY };
      setPanning(true);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    [select, setPanelOpen],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      // A pointer that has actually moved is aiming somewhere new, so the next
      // wheel event starts a fresh gesture instead of inheriting the last one's
      // owner. Trackpad scrolling moves no cursor, so this only ever fires for
      // a deliberate reaim with a mouse.
      if (e.movementX || e.movementY) streamRef.current = null;

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

  /* -------------------------------------------------- viewport commands */

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

  /**
   * Animate to a settled viewport.
   *
   * `interacting` stays true for the duration, which freezes the terminals'
   * render scale and keeps the alignment effect from nudging the viewport out
   * from under the animation — the same cover a wheel gesture already gets.
   * Frames go through the ordinary setViewport, so they reach the hub the way
   * wheel ticks do: a dozen per glide, against the dozens a pinch already sends.
   */
  const glideTo = useCallback(
    (to: Viewport) => {
      cancelGlide();
      if (settleRef.current !== null) {
        window.clearTimeout(settleRef.current);
        settleRef.current = null;
      }
      const from = viewportRef.current;
      setInteracting(true);

      const step = (now: number) => {
        const g = glideRef.current;
        if (!g) return;
        const t = (now - g.startedAt) / GLIDE_MS;
        if (t >= 1) {
          glideRef.current = null;
          // Ends on the exact target, so a caller that pre-aligned it can still
          // compare the live viewport against what it asked for.
          applyViewport(to);
          return;
        }
        const { w, h } = sizeRef.current;
        setViewport(lerpViewport(from, to, easeOut(t), w, h));
        g.raf = requestAnimationFrame(step);
      };

      glideRef.current = { raf: requestAnimationFrame(step), startedAt: performance.now() };
    },
    [applyViewport, cancelGlide, setViewport],
  );

  /* -------------------------------------------------------- maximize */

  /**
   * Which window the canvas is zoomed to, the viewport to put back when it is
   * dismissed, and the viewport we left behind.
   *
   * `applied` is how a still-maximized canvas is told apart from one the user
   * has since panned away from: after a manual gesture `restore` is stale, and
   * the button should maximize again rather than jump somewhere unexpected.
   */
  const [maximized, setMaximized] = useState<
    null | { sessionId: string; restore: Viewport; applied: Viewport }
  >(null);

  const maximizedRef = useRef(maximized);
  maximizedRef.current = maximized;

  /**
   * Zoom to one window. Always focuses, never dismisses — a quick pinch in on
   * the window you are already on must not fly you back out, which is what
   * makes this separate from the toggle below.
   *
   * `restore` overrides where a dismissal returns to. The pinch passes the
   * viewport from before its own gesture, so ⤡ goes back to where you were
   * when you started pinching rather than to the half-zoomed frame it ended on.
   */
  const focusSession = useCallback(
    (sessionId: string, restore?: Viewport) => {
      const target = sessionsRef.current.find((s) => s.id === sessionId);
      if (!target) return;
      // A window worth zooming to is a window worth typing into.
      select(sessionId);

      const { w, h } = sizeRef.current;
      const current = viewportRef.current;
      const state = maximizedRef.current;
      // Going straight from one maximized window to another keeps the original
      // view, so dismissing still returns to the overview rather than to the
      // previous window's close-up.
      const carried =
        state !== null && sameViewport(current, state.applied) ? state.restore : current;

      // Aligned up front so the settle effect finds nothing to nudge, which is
      // what keeps `applied` equal to the live viewport once the glide lands.
      const next = alignViewport(focusRect(target.window, w, h), w, h, dprRef.current);
      setMaximized({ sessionId, restore: restore ?? carried, applied: next });
      glideTo(next);
    },
    [glideTo, select],
  );

  /**
   * The tree panel asking for a window. Same path as the maximize button, so
   * arriving from the list leaves the canvas in exactly the state arriving
   * from the window's own control would.
   */
  const focusRequest = useStore((s) => s.focusRequest);
  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.alsoId) {
      // A child the focused terminal just spawned: frame both, keep the
      // selection where it is so the parent keeps the keyboard.
      const pair = sessionsRef.current.filter((s) =>
        s.id === focusRequest.sessionId || s.id === focusRequest.alsoId,
      );
      if (pair.length > 0) {
        setMaximized(null);
        glideTo(fitTo(pair.map((s) => s.window), sizeRef.current.w, sizeRef.current.h));
      }
      return;
    }
    focusSession(focusRequest.sessionId);
    // Deliberately keyed on the request alone: focusSession changes identity
    // with the viewport, and re-running on that would fly the canvas back to
    // the last-clicked window every time the user panned away from it.
  }, [focusRequest]);

  const toggleMaximize = useCallback(
    (sessionId: string) => {
      const state = maximizedRef.current;
      if (
        state !== null &&
        state.sessionId === sessionId &&
        sameViewport(viewportRef.current, state.applied)
      ) {
        setMaximized(null);
        select(sessionId);
        glideTo(state.restore);
        return;
      }
      focusSession(sessionId);
    },
    [focusSession, glideTo, select],
  );

  /* ----------------------------------------------------- wheel + pinch */

  /*
   * A precision trackpad reports a pinch as a stream of ctrl+wheel events, and
   * ctrl held over a mouse wheel arrives on the same stream a detent at a
   * time. Either way that stream is the canvas's continuous zoom, and the
   * burst below watches it for a flick — a gesture both fast and large — and
   * takes that as a command to navigate: in to the window under the pointer,
   * out one level of the workspace ladder. Anything slower or smaller is left
   * alone, so precise zooming is never hijacked.
   *
   * What counts as fast and large differs by device, and only there: a pinch
   * is judged on speed, a spin on how many detents it managed before the gap
   * between them opened up.
   */
  const burstRef = useRef<null | {
    startedAt: number;
    lastAt: number;
    events: number;
    /** Product of the wheel factors so far: the zoom the gesture asked for. */
    ratio: number;
    /**
     * Whether this burst is made of wheel detents. The two devices are judged
     * by different standards — see finishBurst — and a burst is never a mix,
     * because nobody changes hands mid-gesture.
     */
    notch: boolean;
    /** Canvas-relative point the gesture started at. */
    anchor: Point;
    /** Resolves that anchor to world space, and is where a dismissal returns. */
    startViewport: Viewport;
    timer: number | null;
  }>(null);

  const discardBurst = useCallback(() => {
    const b = burstRef.current;
    if (!b) return;
    burstRef.current = null;
    if (b.timer !== null) window.clearTimeout(b.timer);
  }, []);

  /**
   * A pinch has stopped. If it was a flick, navigate; otherwise the continuous
   * zoom it already performed is the whole of its effect.
   */
  const finishBurst = useCallback(() => {
    const b = burstRef.current;
    if (!b) return;
    burstRef.current = null;
    if (b.timer !== null) window.clearTimeout(b.timer);

    const durationMs = b.lastAt - b.startedAt;
    const intent = b.notch
      ? wheelFlickIntent({ ratio: b.ratio, durationMs })
      : pinchIntent({ ratio: b.ratio, durationMs, events: b.events });
    if (!intent) return;

    const world = screenToWorld(b.anchor, b.startViewport);
    const all = sessionsRef.current;
    // Topmost, so a pinch over overlapping windows picks the one you can see.
    const under = all
      .filter((s) => rectContainsPoint(s.window, world))
      .sort((a, c) => a.window.z - c.window.z)
      .at(-1);

    if (intent === 'in') {
      // Nothing under the fingers means nothing was aimed at, and the pinch's
      // own zoom is all that happens.
      if (!under) return;
      focusSession(under.id, b.startViewport);
      return;
    }

    // Zooming out has an obvious answer even when the pinch was over empty
    // canvas, so fall back to the nearest window rather than giving up.
    const anchorSession = under ?? nearestSession(all, world);
    const containers = [
      anchorSession
        ? workspaceBounds(
            all.filter((s) => s.workspaceId === anchorSession.workspaceId).map((s) => s.window),
          )
        : null,
      boundsOf(all.map((s) => s.window)),
    ].filter((r): r is Rect => r !== null);

    const { w, h } = sizeRef.current;
    const next = stepOutTo(containers, viewportRef.current, w, h);
    if (!next) return;
    // The view is no longer one window's close-up, so the ⤡ state stops
    // describing it.
    setMaximized(null);
    glideTo(alignViewport(next, w, h, dprRef.current));
  }, [focusSession, glideTo]);

  const noteZoom = useCallback(
    (anchor: Point, factor: number, notch: boolean) => {
      const now = performance.now();
      const gap = notch ? WHEEL_FLICK_GAP_MS : PINCH_GAP_MS;
      const b = burstRef.current;
      // Same device, still within its gap: this is more of the same gesture.
      if (b && b.notch === notch && now - b.lastAt <= gap) {
        if (b.timer !== null) window.clearTimeout(b.timer);
        b.lastAt = now;
        b.events += 1;
        b.ratio *= factor;
        b.timer = window.setTimeout(finishBurst, gap);
        return;
      }
      discardBurst();
      burstRef.current = {
        startedAt: now,
        lastAt: now,
        events: 1,
        ratio: factor,
        notch,
        anchor,
        startViewport: viewportRef.current,
        timer: window.setTimeout(finishBurst, gap),
      };
    },
    [discardBurst, finishBurst],
  );

  useEffect(
    () => () => {
      cancelGlide();
      discardBurst();
    },
    [cancelGlide, discardBurst],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // A live xterm ends its own wheel handling in cancel(ev, force), which
      // calls stopPropagation: a pinch that starts over a terminal would never
      // reach a listener on the canvas. Hence the capture phase — but that
      // makes the canvas first in line for every wheel event on the page, so
      // the one case that is genuinely the terminal's gets handed straight
      // back. Scrolling belongs to the terminal the gesture *started* over;
      // zooming belongs to the canvas, wherever the pointer happens to be.
      const zooming = e.ctrlKey || e.metaKey;
      const stream = wheelStream(streamRef.current, {
        now: performance.now(),
        zooming,
        overTerminal: !!(e.target as Element | null)?.closest?.('.term-host'),
      });
      streamRef.current = stream;
      if (!zooming && stream.owner === 'terminal') return;

      // preventDefault stops the browser's own page zoom, and stopPropagation
      // keeps the terminal below from also acting on an event we have taken.
      e.preventDefault();
      e.stopPropagation();
      markInteracting();
      const rect = el.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      if (zooming) {
        const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
        // Recorded before the zoom is applied, so the burst keeps the
        // viewport the gesture started from.
        noteZoom(point, factor, isWheelNotch(e.deltaY, e.deltaMode));
        setViewport(zoomAt(viewport, point, viewport.zoom * factor));
      } else {
        discardBurst();
        setViewport({
          ...viewport,
          panX: viewport.panX - e.deltaX,
          panY: viewport.panY - e.deltaY,
        });
      }
    };

    // Non-passive so preventDefault actually takes effect; React's synthetic
    // wheel handler is passive, which is why this is registered natively.
    const opts = { passive: false, capture: true } as const;
    el.addEventListener('wheel', onWheel, opts);
    return () => el.removeEventListener('wheel', onWheel, opts);
  }, [viewport, setViewport, markInteracting, noteZoom, discardBurst]);

  /* ----------------------------------------------------- keyboard nav */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modal dialog owns the keyboard while it is up, Escape included -
      // the native element closes itself on it, and the canvas must not also
      // unwind a level behind it.
      if (useStore.getState().dialog) return;
      // Never steal keys from a focused terminal.
      const inTerminal = (e.target as HTMLElement)?.closest?.('.term-host');
      if (inTerminal) return;

      if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        glideTo({ panX: 0, panY: 0, zoom: 1 });
      }
      if (e.key === '1' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        glideTo(
          fitTo(
            sessions.map((s) => s.window),
            size.w,
            size.h,
          ),
        );
      }
      if (e.key === '2' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (selectedId) toggleMaximize(selectedId);
      }
      // Escape unwinds one thing at a time: the panel first if it is open,
      // and only then the selection. Read at keydown rather than subscribed to,
      // so opening the panel does not re-render the canvas and every terminal
      // on it.
      if (e.key === 'Escape') {
        if (useStore.getState().panelOpen) setPanelOpen(false);
        else select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sessions, size, glideTo, select, selectedId, toggleMaximize, setPanelOpen]);

  /**
   * The window whose button should offer to go back, rather than the one we
   * last zoomed to. They differ once the user pans or zooms by hand: at that
   * point the toggle maximizes again, so the icon has to say so.
   */
  const maximizedId =
    maximized && sameViewport(viewport, maximized.applied) ? maximized.sessionId : null;

  /* ------------------------------------------------ LOD + culling */

  const visible = useMemo(
    () => visibleWorldRect(viewport, size.w, size.h),
    [viewport, size],
  );

  /*
   * Which windows had live terminals on the last pass.
   *
   * Zooming out used to blank every terminal the moment it crossed the LOD
   * threshold, mid-gesture — the content you were zooming out to get a view of
   * disappeared while you were still moving, and came back only once you
   * stopped. A terminal that is already mounted therefore stays mounted for
   * the length of a gesture, and the swap to the cheap placeholder happens
   * once the canvas settles. Nothing is promoted this way, only held: a window
   * that was not live when the gesture started does not become live because
   * the gesture passed over it, so a zoomed-out canvas never lights up dozens
   * of terminals at once.
   */
  const wasLive = useRef<ReadonlySet<string>>(new Set());

  const decorated = useMemo(
    () =>
      sessions.map((s) => {
        const onScreen = rectsIntersect(visible, s.window);
        const readable = viewport.zoom >= LIVE_ZOOM_THRESHOLD;
        return {
          session: s,
          // A terminal is live when it is on screen and either readable or
          // held over from before this gesture started.
          live: onScreen && (readable || (interacting && wasLive.current.has(s.id))),
          onScreen,
        };
      }),
    [sessions, visible, viewport.zoom, interacting],
  );

  useEffect(() => {
    wasLive.current = new Set(decorated.filter((d) => d.live).map((d) => d.session.id));
  }, [decorated]);

  /* --------------------------------------------- workspace grouping */

  /**
   * The frame drawn around each workspace's windows, and which workspace each
   * window belongs to — one pass, because they are the same question.
   *
   * `sessionsIn` rather than a join on `workspaceId`: an agent running on a
   * host is stamped with *that* hub's workspace id, which is not a row in this
   * database, so the join matched nothing. A workspace on another machine got
   * no frame at all, and its windows no workspace colour.
   */
  const { groups, wsBySession } = useMemo(() => {
    const groups: { ws: Workspace; box: Rect }[] = [];
    const wsBySession = new Map<string, Workspace>();
    for (const ws of workspaces) {
      const members = sessionsIn(ws, sessions);
      for (const s of members) wsBySession.set(s.id, ws);
      const box = workspaceBounds(members.map((s) => s.window));
      if (box) groups.push({ ws, box });
    }
    return { groups, wsBySession };
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
              transform: `translate(${g.box.x}px, ${g.box.y}px)`,
              width: g.box.w,
              height: g.box.h,
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
              workspace={wsBySession.get(session.id)}
              zoom={viewport.zoom}
              dpr={devicePixelRatio}
              renderScale={renderScale}
              live={live}
              selected={selectedId === session.id}
              maximized={maximizedId === session.id}
              onMaximize={toggleMaximize}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

