import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Session, Viewport, Workspace } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import { sessionsIn } from '../state/tree.js';
import { TerminalWindow } from '../window/TerminalWindow.js';
import { StickyNote } from './StickyNote.js';
import { MessageEdges } from './MessageEdges.js';
import {
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
  neighbourIn,
  rectContains,
  rectContainsPoint,
  rectsIntersect,
  renderScaleFor,
  screenToWorld,
  stepInTo,
  stepOutTo,
  visibleWorldRect,
  wheelStream,
  wheelZoomFactor,
  workspaceBounds,
  zoomAt,
  zoomLadder,
} from './viewport.js';
import type { Point, Rect, WheelStream } from './viewport.js';
import {
  fmtRect,
  traceAlign,
  traceCanvasSize,
  traceFrame,
  traceGesture,
  traceLadder,
  traceRenderScale,
} from './trace.js';
import { globalChord, modeKey, type Command } from './keymap.js';
import { assignLabels, matchLabel } from './labels.js';
import { Palette } from './Palette.js';
import type { PaletteEntry } from './commands.js';
import { JumpLabels } from './JumpLabels.js';
import { WorkspaceFrame } from './WorkspaceFrame.js';

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

/**
 * How far one pan key moves the view, as a share of the viewport. Less than a
 * whole screen on purpose: an overlap is what tells you which way you went.
 */
const PAN_STEP = 0.4;

/** Cmd rather than Ctrl for the chords, and it never changes while loaded. */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);

function dpr(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

function sameViewport(a: { panX: number; panY: number; zoom: number }, b: typeof a): boolean {
  return a.panX === b.panX && a.panY === b.panY && a.zoom === b.zoom;
}

/** The target - window or note - whose centre is closest to a world point. */
function nearestTarget<T extends { rect: Rect }>(items: T[], p: Point): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const item of items) {
    const dx = item.rect.x + item.rect.w / 2 - p.x;
    const dy = item.rect.y + item.rect.h / 2 - p.y;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) {
      bestDistance = d;
      best = item;
    }
  }
  return best;
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

  const {
    sessions,
    workspaces,
    notes,
    viewport,
    setViewport,
    selectedId,
    selectedNoteId,
    select,
    selectNote,
    createNoteAt,
    setPanelOpen,
    setCanvasMode,
  } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      workspaces: s.workspaces,
      notes: s.notes,
      viewport: s.viewport,
      setViewport: s.setViewport,
      selectedId: s.selectedId,
      selectedNoteId: s.selectedNoteId,
      select: s.select,
      selectNote: s.selectNote,
      createNoteAt: s.createNoteAt,
      setPanelOpen: s.setPanelOpen,
      setCanvasMode: s.setCanvasMode,
    })),
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Traced on change rather than per observation: everything a command
    // computes is measured against these two numbers, so a view that framed
    // the wrong area is read from here first.
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setSize((cur) => {
        if (cur.w === next.w && cur.h === next.h) return cur;
        traceCanvasSize(next.w, next.h, dpr());
        return next;
      });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
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
  // Notes are part of "everything on the canvas", which the outermost rung of
  // the zoom ladder has to frame.
  const notesRef = useRef(notes);
  notesRef.current = notes;
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
    if (!sameViewport(aligned, viewport)) {
      // The one step that moves a view nobody asked to move. Traced with the
      // zoom change as a percentage, which is what says whether it is the
      // suspect in a view that ended up off where it was aimed.
      traceAlign(viewport, aligned);
      setViewport(aligned);
    }
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
    const onChange = () => {
      const next = dpr();
      // A device pixel changing size re-decides both the alignment grain and
      // the render scale, and it happens without the user touching the canvas
      // - browser zoom, or a drag to a monitor with different scaling.
      traceCanvasSize(sizeRef.current.w, sizeRef.current.h, next);
      setDevicePixelRatio(next);
    };
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
    setRenderScale((cur) => {
      if (cur === next) return cur;
      // Clamped at both ends, so this stops following the zoom at the ends of
      // the range - where a terminal is magnified or minified rather than
      // rasterized to match, which looks like the zoom being wrong.
      traceRenderScale(viewport.zoom, devicePixelRatio, next);
      return next;
    });
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

  /* ------------------------------------------------------------- notes */

  /**
   * Double-click empty canvas to drop a note, centred on the cursor.
   *
   * `.canvas` itself is only the hit target when `.world` does not cover it -
   * true at rest whenever the zoomed world is smaller than the viewport - so
   * a double-click landing on `.world` (empty space between windows) has to
   * be accepted too. Anything deeper - a window, a note, the workspace frame
   * label - has its own element in between and is excluded by construction.
   */
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target !== e.currentTarget && !target.classList.contains('world')) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const world = screenToWorld(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        viewportRef.current,
      );
      createNoteAt(world);
      // `selectNote` inside createNoteAt runs synchronously, so the new id is
      // already current by the time this line runs.
      const id = useStore.getState().selectedNoteId;
      freshNoteIdRef.current = id;
      setTimeout(() => {
        if (freshNoteIdRef.current === id) freshNoteIdRef.current = null;
      }, 0);
    },
    [createNoteAt],
  );

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
      const framed = focusRect(target.window, w, h);
      const next = alignViewport(framed, w, h, dprRef.current);
      // Both halves, because they are two different suspects: `framed` is the
      // rect and the fill this command chose, `next` is what alignment left of
      // it. A focus that lands under the panel shows up in neither number but
      // in the panel width traceFrame measures alongside them.
      traceFrame('focus', target.window, viewportRef.current, next, { w, h },
        `session=${sessionId} framedZoom=${framed.zoom}`);
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
        const { w, h } = sizeRef.current;
        const to = fitTo(pair.map((s) => s.window), w, h);
        setMaximized(null);
        traceFrame('focus-pair', boundsOf(pair.map((s) => s.window)), viewportRef.current, to,
          { w, h }, `sessions=${pair.length}`);
        glideTo(to);
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
        traceFrame('unmaximize', null, viewportRef.current, state.restore, sizeRef.current,
          `session=${sessionId}`);
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
      ? wheelFlickIntent({ ratio: b.ratio, durationMs, events: b.events })
      : pinchIntent({ ratio: b.ratio, durationMs, events: b.events });
    const burst = { ratio: b.ratio, durationMs, events: b.events };
    if (!intent) {
      // Worth a line even though nothing happens: a gesture that was meant as
      // a flick and read as zooming leaves the view part-way between two
      // levels, which is reported as the zoom being wrong rather than as a
      // gesture that did not fire.
      traceGesture(b.notch ? 'wheel' : 'pinch', burst, null, 'zoom only');
      return;
    }

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
      if (!under) {
        traceGesture(b.notch ? 'wheel' : 'pinch', burst, intent, 'nothing under the pointer');
        return;
      }
      traceGesture(b.notch ? 'wheel' : 'pinch', burst, intent, `focus ${under.id}`);
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
    if (!next) {
      traceGesture(b.notch ? 'wheel' : 'pinch', burst, intent, 'nothing left to reveal');
      return;
    }
    const to = alignViewport(next, w, h, dprRef.current);
    traceGesture(b.notch ? 'wheel' : 'pinch', burst, intent, 'step out');
    // The view is no longer one window's close-up, so the ⤡ state stops
    // describing it.
    setMaximized(null);
    // No target rect: which container stepOutTo picked is its own business,
    // and the containers it chose from are the next line down anyway.
    traceFrame('pinch-out', null, viewportRef.current, to, { w, h },
      `containers=${containers.length}`);
    glideTo(to);
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
        // A note's textarea scrolls a long note the same way a terminal
        // scrolls its own buffer: plain wheel stays with it, Ctrl-wheel still
        // belongs to the canvas.
        overTerminal: !!(e.target as Element | null)?.closest?.('.term-host, .note-text'),
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
        const current = viewportRef.current;
        setViewport(zoomAt(current, point, current.zoom * factor));
      } else {
        discardBurst();
        const current = viewportRef.current;
        setViewport({
          ...current,
          panX: current.panX - e.deltaX,
          panY: current.panY - e.deltaY,
        });
      }
    };

    // Non-passive so preventDefault actually takes effect; React's synthetic
    // wheel handler is passive, which is why this is registered natively.
    // viewport is deliberately not a dependency: reading it here would remove
    // and re-add this listener on every zoom, and onWheel would compute from
    // whatever viewport the last render closed over — two events dispatched
    // before React commits both zoom from the same base and one is lost.
    // viewportRef.current is current as of the last render, which is ahead of
    // anything the effect could have closed over, instead.
    const opts = { passive: false, capture: true } as const;
    el.addEventListener('wheel', onWheel, opts);
    return () => el.removeEventListener('wheel', onWheel, opts);
  }, [setViewport, markInteracting, noteZoom, discardBurst]);

  /* ----------------------------------------------------- keyboard nav */

  /*
   * A jump in progress: every window wears a badge and the next keys pick one
   * (issue 52).
   *
   * `sessions` is frozen at the moment the jump opened rather than read live,
   * so a session arriving or leaving mid-jump cannot shift the badges out
   * from under the keys already typed - the badge you read is the badge you
   * get.
   */
  const [jump, setJump] = useState<
    | null
    | {
        ids: string[];
        labels: string[];
        typed: string;
        restore: Viewport;
        /** The maximize state to put back, so cancelling leaves no trace. */
        restoreMaximized: { sessionId: string; restore: Viewport; applied: Viewport } | null;
      }
  >(null);

  // Read by the key handlers, which outlive the render that armed them.
  const jumpRef = useRef(jump);
  jumpRef.current = jump;

  /** Whether the command palette is up. Canvas state - see Palette.tsx. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;

  /**
   * Show the badges, after pulling back far enough to see all of them.
   *
   * The zoom out is the jump: a badge on a window that is off screen is a
   * badge nobody can read, so offering one without first framing every window
   * would make the feature useless exactly when it is most wanted - a canvas
   * too big to take in at once. `restore` is where a cancelled jump puts the
   * view back, so looking at everything costs nothing if you change your mind.
   */
  const openJump = useCallback(() => {
    // Reading order, so the badges are in the same places each time and are
    // worth learning. Nearest-to-the-centre first would put the easiest keys
    // on the windows you are looking at, but then they move whenever you pan.
    const ordered = [...sessionsRef.current].sort(
      (a, b) => a.window.y - b.window.y || a.window.x - b.window.x,
    );
    if (ordered.length === 0) return;
    setJump({
      ids: ordered.map((x) => x.id),
      labels: assignLabels(ordered.length),
      typed: '',
      restore: viewportRef.current,
      restoreMaximized: maximizedRef.current,
    });

    // Windows only, not notes: the badges are on windows, and a note parked
    // far out would shrink every one of them to fit something unlabelled.
    const { w, h } = sizeRef.current;
    const windows = ordered.map((x) => x.window);
    const to = alignViewport(fitTo(windows, w, h), w, h, dprRef.current);
    setMaximized(null);
    traceFrame('jump-open', boundsOf(windows), viewportRef.current, to, { w, h },
      `windows=${ordered.length}`);
    glideTo(to);
  }, [glideTo]);

  /**
   * Put the badges away.
   *
   * `landed` says whether a window was picked. If one was, it has just been
   * framed and the view must stay there; if not, the zoom out that opened the
   * jump is undone, so cancelling leaves no trace.
   */
  const closeJump = useCallback(
    (landed: boolean) => {
      const j = jumpRef.current;
      setJump(null);
      if (!j || landed) return;
      const { w, h } = sizeRef.current;
      // Both halves of "where you were": the viewport, and whether it was one
      // window's close-up - otherwise cancelling a jump would quietly turn a
      // maximized window's ⤡ back into ⤢.
      setMaximized(j.restoreMaximized);
      const to = alignViewport(j.restore, w, h, dprRef.current);
      traceFrame('jump-cancel', null, viewportRef.current, to, { w, h });
      glideTo(to);
    },
    [glideTo],
  );

  /**
   * The rungs the zoom ladder walks for one window: the window, the box drawn
   * round its workspace, then everything on the canvas.
   *
   * Notes count towards "everything" for the same reason fitting used to:
   * a note parked out past the last window is part of the canvas, and leaving
   * it out of frame makes the outermost rung a lie.
   */
  const ladderFor = useCallback((sessionId: string): Rect[] | null => {
    const all = sessionsRef.current;
    const target = all.find((s) => s.id === sessionId);
    if (!target) return null;
    const group = workspaceBounds(
      all.filter((s) => s.workspaceId === target.workspaceId).map((s) => s.window),
    );
    const everything = boundsOf([...all.map((s) => s.window), ...notesRef.current]);
    return zoomLadder(target.window, group, everything);
  }, []);

  /**
   * One rung of the ladder, in or out.
   *
   * The anchor is the selection, and failing that the window nearest the
   * middle of the screen - so a press with nothing selected still has an
   * obvious answer rather than being dropped. Which rung we are on is read off
   * the screen by stepInTo/stepOutTo, never stored, so panning by hand between
   * presses cannot desync the ladder from what is visible.
   */
  const zoomLadderStep = useCallback(
    (dir: 'in' | 'out') => {
      const { w, h } = sizeRef.current;

      /*
       * A selected note is its own ladder: the note, then everything. It has
       * no workspace to be the middle rung, and anchoring on the nearest
       * window instead would fly you away from the thing you just navigated
       * to - which is exactly what a zoom key must not do.
       */
      const noteId = useStore.getState().selectedNoteId;
      const note = noteId === null ? undefined : notesRef.current.find((n) => n.id === noteId);
      if (note) {
        const rungs = zoomLadder(note, null, boundsOf([
          ...sessionsRef.current.map((x) => x.window),
          ...notesRef.current,
        ]));
        const to =
          dir === 'in'
            ? stepInTo(rungs, viewportRef.current, w, h)
            : stepOutTo(rungs.slice(1), viewportRef.current, w, h);
        traceLadder(dir, rungs, to);
        if (!to) return;
        const aligned = alignViewport(to, w, h, dprRef.current);
        setMaximized(null);
        traceFrame(`ladder-${dir}`, note, viewportRef.current, aligned, { w, h }, 'on=note');
        glideTo(aligned);
        return;
      }

      const all = sessionsRef.current;
      if (all.length === 0) return;
      const anchor =
        all.find((s) => s.id === useStore.getState().selectedId) ??
        nearestSession(all, screenToWorld({ x: w / 2, y: h / 2 }, viewportRef.current));
      if (!anchor) return;
      const ladder = ladderFor(anchor.id);
      if (!ladder) return;

      const next =
        dir === 'in'
          ? stepInTo(ladder, viewportRef.current, w, h)
          : stepOutTo(ladder.slice(1), viewportRef.current, w, h);
      // The rungs as well as the answer: which rung a press steps to is read
      // off the screen, so a press that went somewhere unexpected is a
      // question about the rungs it chose from.
      traceLadder(dir, ladder, next);
      if (!next) return;

      // Landing on one window is the same thing the maximize button does, so
      // it goes through focusSession and leaves ⤡ able to put the view back.
      // Any wider rung is no longer one window's close-up, and says so.
      if (dir === 'in' && sameViewport(next, focusRect(anchor.window, w, h))) {
        focusSession(anchor.id);
        return;
      }
      const aligned = alignViewport(next, w, h, dprRef.current);
      setMaximized(null);
      traceFrame(`ladder-${dir}`, null, viewportRef.current, aligned, { w, h },
        `anchor=${anchor.id} rungs=${ladder.length}`);
      glideTo(aligned);
    },
    [focusSession, glideTo, ladderFor],
  );

  /**
   * Everything the keyboard can land on, windows and notes alike.
   *
   * Notes are stops because they are things on the canvas you want to read
   * and write: navigation that skipped them would make a note something you
   * can only reach with the mouse, on a canvas whose whole point is that you
   * need not.
   *
   * Flattened to `{ kind, id, rect }` because that is all the geometry cares
   * about, and because a session keeps its rect under `window` while a note
   * is its own rect.
   */
  const targetsRef = useRef<{ kind: 'session' | 'note'; id: string; rect: Rect }[]>([]);
  targetsRef.current = useMemo(
    () => [
      ...sessions.map((x) => ({ kind: 'session' as const, id: x.id, rect: x.window })),
      ...notes.map((n) => ({ kind: 'note' as const, id: n.id, rect: n })),
    ],
    [sessions, notes],
  );

  /** Select a target of either kind, and bring it into frame if it is not. */
  const land = useCallback(
    (target: { kind: 'session' | 'note'; id: string; rect: Rect }) => {
      // The two selections clear each other in the store, so this is also
      // how moving from a note to a window puts the note's ring away.
      if (target.kind === 'session') select(target.id);
      else selectNote(target.id);

      const { w, h } = sizeRef.current;
      const visible = visibleWorldRect(viewportRef.current, w, h, 0);
      if (!rectContains(visible, target.rect)) {
        const to = alignViewport(fitTo([target.rect], w, h), w, h, dprRef.current);
        setMaximized(null);
        // `visible` too: this is the one decision taken from what is on screen
        // rather than from a rect, so whether it fired at all is the question.
        traceFrame('land', target.rect, viewportRef.current, to, { w, h },
          `${target.kind}=${target.id} visible=(${fmtRect(visible)})`);
        glideTo(to);
      }
    },
    [glideTo, select, selectNote],
  );

  /** What the keyboard is on now, of either kind. */
  const currentTarget = useCallback(() => {
    const { selectedId, selectedNoteId } = useStore.getState();
    const id = selectedId ?? selectedNoteId;
    return id === null ? undefined : targetsRef.current.find((t) => t.id === id);
  }, []);

  /**
   * Move the selection to the next thing over, and bring it into frame.
   *
   * Selecting is also focusing (see `select`), so this lands you typing to the
   * agent you moved to - which is the point of navigating by keyboard. The
   * viewport only moves when it has to: a neighbour already on screen is
   * selected where it sits, because gliding on every press would make a canvas
   * that holds everything twitch for no reason.
   */
  const moveSelection = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down') => {
      const all = targetsRef.current;
      if (all.length === 0) return;
      const current = currentTarget();
      // Nothing selected yet: the first press selects rather than moves, and
      // picks what is in the middle of the screen.
      if (!current) {
        const { w, h } = sizeRef.current;
        const at = screenToWorld({ x: w / 2, y: h / 2 }, viewportRef.current);
        const start = nearestTarget(all, at);
        if (start) land(start);
        return;
      }
      const next = neighbourIn(all, current, dir);
      if (next) land(next);
    },
    [currentTarget, land],
  );

  /** The next or previous thing in reading order, wrapping. */
  const cycleSelection = useCallback(
    (step: 1 | -1) => {
      const all = [...targetsRef.current].sort(
        (a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x,
      );
      if (all.length === 0) return;
      const current = currentTarget();
      const at = current ? all.findIndex((t) => t.id === current.id) : -1;
      // Wrapping is right here and wrong for hjkl: Tab says "the next one" and
      // has no direction to run out of, where an arrow key that teleported you
      // back across the canvas would be unreadable.
      land(all[(at + step + all.length) % all.length]!);
    },
    [currentTarget, land],
  );

  /** The nth window of the selected window's workspace, as printed on the key. */
  const selectIndex = useCallback(
    (index: number) => {
      const all = sessionsRef.current;
      const current = all.find((s) => s.id === useStore.getState().selectedId);
      const members = (current ? all.filter((s) => s.workspaceId === current.workspaceId) : all).sort(
        (a, b) => a.window.y - b.window.y || a.window.x - b.window.x,
      );
      const target = members[index - 1];
      if (target) focusSession(target.id);
    },
    [focusSession],
  );

  /** Shift the viewport by a fraction of itself, without changing the zoom. */
  const panBy = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down') => {
      const { w, h } = sizeRef.current;
      const v = viewportRef.current;
      const dx = dir === 'left' ? w * PAN_STEP : dir === 'right' ? -w * PAN_STEP : 0;
      const dy = dir === 'up' ? h * PAN_STEP : dir === 'down' ? -h * PAN_STEP : 0;
      setMaximized(null);
      glideTo({ ...v, panX: v.panX + dx, panY: v.panY + dy });
    },
    [glideTo],
  );

  /**
   * Run one command from the keymap.
   *
   * Split out from the listener so the palette and the help overlay can send
   * the same commands the keys do, rather than reimplementing them.
   */
  const run = useCallback(
    (cmd: Command) => {
      if (typeof cmd === 'object') {
        selectIndex(cmd.index);
        return;
      }
      const st = useStore.getState();
      switch (cmd) {
        case 'mode.toggle':
          // Entering with nothing selected picks a window, because every mode
          // key acts on the selection and a mode that does nothing is a trap.
          if (!st.canvasMode && !st.selectedId) moveSelection('right');
          setCanvasMode(!st.canvasMode);
          return;
        case 'panel':
          setPanelOpen(!st.panelOpen);
          return;
        case 'zoom.in':
          zoomLadderStep('in');
          return;
        case 'zoom.out':
          zoomLadderStep('out');
          return;
        case 'select.left':
        case 'select.right':
        case 'select.up':
        case 'select.down':
          moveSelection(cmd.slice('select.'.length) as 'left' | 'right' | 'up' | 'down');
          return;
        case 'select.next':
          cycleSelection(1);
          return;
        case 'select.prev':
          cycleSelection(-1);
          return;
        case 'pan.left':
        case 'pan.right':
        case 'pan.up':
        case 'pan.down':
          panBy(cmd.slice('pan.'.length) as 'left' | 'right' | 'up' | 'down');
          return;
        case 'focus.enter':
          // Leaving the mode is what hands the keyboard back: the terminal
          // takes focus off `selected && !canvasMode`.
          setCanvasMode(false);
          return;
        case 'new.agent': {
          const current = sessionsRef.current.find((s) => s.id === st.selectedId);
          if (current) st.openDialog({ kind: 'startAgent', workspaceId: current.workspaceId });
          return;
        }
        case 'new.note': {
          const { w, h } = sizeRef.current;
          createNoteAt(screenToWorld({ x: w / 2, y: h / 2 }, viewportRef.current));
          return;
        }
        case 'new.workspace':
          st.openDialog({ kind: 'addWorkspace', hostId: null });
          return;
        case 'session.restart': {
          if (!st.selectedId) return;
          st.client?.send({ t: 'resumeSession', sessionId: st.selectedId });
          return;
        }
        case 'session.close': {
          const target = sessionsRef.current.find((s) => s.id === st.selectedId);
          if (!target) return;
          // Through the same confirmation the window's own × uses: the key is
          // one press away from a window that cannot be got back.
          st.openDialog({
            kind: 'confirm',
            title: 'Remove this window?',
            body: 'The window leaves the canvas and the session is forgotten.',
            confirmLabel: 'remove',
            send: { t: 'removeSession', sessionId: target.id },
          });
          return;
        }
        case 'escape':
          // One thing at a time, outermost first, so Escape is always
          // "undo the last layer" rather than "reset everything".
          if (paletteOpenRef.current) setPaletteOpen(false);
          else if (jumpRef.current) closeJump(false);
          else if (st.panelOpen) setPanelOpen(false);
          else if (st.selectedId || st.selectedNoteId) select(null);
          else setCanvasMode(false);
          return;
        case 'help':
          st.openDialog({ kind: 'shortcuts' });
          return;
        case 'labelJump':
          // Pressing it again while the badges are up means "never mind",
          // which is the same thing Escape does and saves reaching for it.
          if (jumpRef.current) closeJump(false);
          else openJump();
          return;
        case 'palette':
          // Badges and the palette both want the whole keyboard, so opening
          // one puts the other away rather than stacking them.
          if (jumpRef.current) closeJump(false);
          setPaletteOpen((open) => !open);
          return;
      }
    },
    [
      closeJump,
      createNoteAt,
      cycleSelection,
      moveSelection,
      openJump,
      panBy,
      select,
      selectIndex,
      setCanvasMode,
      setPanelOpen,
      zoomLadderStep,
    ],
  );

  /*
   * While the badges are up the jump owns the keyboard, and it has to take it
   * off whoever had it - usually a focused terminal, since the chord that
   * opens a jump works from inside one.
   *
   * Capture on window, which is what puts this ahead of xterm's own listener
   * on its textarea: the bubble-phase listener below would see the letter
   * only after the agent had already been typed into. stopPropagation is
   * therefore as load-bearing as preventDefault here.
   *
   * Registered only while a jump is open, so outside one there is nothing in
   * front of the terminal at all.
   */
  useEffect(() => {
    if (!jump) return;
    const onKey = (e: KeyboardEvent) => {
      // Chords still work: Ctrl+Shift+F closes the jump, and nothing else is
      // worth trapping the user for.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        closeJump(false);
        return;
      }
      if (e.key === 'Backspace') {
        setJump((j) => (j ? { ...j, typed: j.typed.slice(0, -1) } : j));
        return;
      }
      // One printable character; e.key rather than e.code because a badge is
      // the letter the user sees on screen, not a position on the keyboard.
      if (e.key.length !== 1) return;

      const typed = jump.typed + e.key.toLowerCase();
      const { index, remaining } = matchLabel(jump.labels, typed);
      if (index !== null) {
        const id = jump.ids[index];
        closeJump(true);
        // Arrival: the window is framed and the keyboard goes to its agent,
        // which is the whole point of having jumped to it. `restore` is the
        // view from before the jump zoomed out, so ⤡ puts you back where you
        // were rather than at the overview the badges needed.
        if (id) {
          focusSession(id, jump.restore);
          setCanvasMode(false);
        }
        return;
      }
      // A key that cannot become any badge ends the jump rather than being
      // swallowed: silently ignoring it would leave the badges up with no
      // sign that the key went nowhere.
      if (remaining === 0) closeJump(false);
      else setJump({ ...jump, typed });
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [jump, closeJump, focusSession, setCanvasMode]);

  /**
   * Something picked out of the palette.
   *
   * A window is arrival, exactly as a jump's badge is: it gets framed and its
   * agent gets the keyboard. A command is simply the command, so the palette
   * and the key that runs it can never drift apart.
   */
  const onPalettePick = useCallback(
    (entry: PaletteEntry) => {
      const st = useStore.getState();
      switch (entry.kind) {
        case 'session':
          focusSession(entry.id);
          setCanvasMode(false);
          return;
        case 'command':
          run(entry.action);
          return;
        case 'start':
          /*
           * Straight to the hub, with no dialog in between: the palette row
           * already said which template and which workspace, which is
           * everything the dialog's two pickers ask for. Model, effort and a
           * first task are still the dialog's job - this is the quick path,
           * not a replacement for it.
           *
           * Acknowledged rather than fire-and-forget, like every other start:
           * the ack names the session, which is how the canvas knows where to
           * fly. A refusal surfaces as an error in the corner.
           */
          void st.client
            ?.request({ t: 'startSession', workspaceId: entry.workspaceId, profile: entry.profile })
            .then((result) => {
              if (result.sessionId) useStore.getState().requestFocus(result.sessionId);
            })
            .catch((e: Error) => useStore.getState().showError(e.message));
          setCanvasMode(false);
          return;
      }
    },
    [focusSession, run, setCanvasMode],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modal dialog owns the keyboard while it is up, Escape included -
      // the native element closes itself on it, and the canvas must not also
      // unwind a level behind it.
      if (useStore.getState().dialog) return;

      /*
       * The chords come first, before the checks below hand the keyboard
       * back, because they are the half of the keymap that has to work *while
       * an agent has it* - Ctrl+Shift+Space especially, which is how you get
       * the keyboard back at all. Terminal.tsx keeps the same chords away from
       * the pty, so nothing here is also typed at the agent.
       */
      const chord = globalChord(e, IS_MAC);
      if (chord) {
        e.preventDefault();
        run(chord);
        return;
      }

      // Never steal plain keys from a focused terminal, or from a note's
      // textarea - without this, Escape got stolen out from under whoever was
      // mid-sentence in a note. Canvas mode is the deliberate exception, and
      // it blurs the terminal on the way in so there is nothing to steal.
      const inTerminal = (e.target as HTMLElement)?.closest?.('.term-host');
      const inField = (e.target as HTMLElement)?.closest?.('textarea, input');
      if (inField) return;

      if (useStore.getState().canvasMode) {
        const cmd = modeKey(e);
        if (cmd) {
          e.preventDefault();
          run(cmd);
        }
        return;
      }

      if (inTerminal) return;

      // Outside the mode, Escape still unwinds - it is the one key that has
      // to work without having entered anything first.
      if (e.key === 'Escape') run('escape');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  /**
   * The window whose button should offer to go back, rather than the one we
   * last zoomed to. They differ once the user pans or zooms by hand: at that
   * point the toggle maximizes again, so the icon has to say so.
   */
  const maximizedId =
    maximized && sameViewport(viewport, maximized.applied) ? maximized.sessionId : null;

  /* ---------------------------------------------------- culling */

  const visible = useMemo(
    () => visibleWorldRect(viewport, size.w, size.h),
    [viewport, size],
  );

  /*
   * Every window on screen carries a real terminal, at every zoom.
   *
   * There used to be a zoom threshold below which a window swapped to a
   * static card, on the argument that nobody can read 6px text so nobody
   * should pay to render it. That got the trade backwards: what you are
   * looking for on a zoomed-out canvas is the *shape* of each agent's output
   * — a wall of diff, a prompt waiting, a stack trace — and a card showing
   * its address instead is precisely the information you did not need. So the
   * text is always the text, and the render scale (see viewport.ts) minifies
   * it rather than replacing it.
   *
   * Culling is what keeps that affordable, and it is the honest control: a
   * window off screen costs nothing whatever the zoom, and the number on
   * screen is bounded by the viewport rather than by the canvas.
   */
  const onScreen = useMemo(
    () => sessions.filter((s) => rectsIntersect(visible, s.window)),
    [sessions, visible],
  );

  /** Same culling as windows get, and the same reason: a note off screen costs
   *  nothing, whatever the zoom. */
  const notesOnScreen = useMemo(
    () => notes.filter((n) => rectsIntersect(visible, n)),
    [notes, visible],
  );

  /**
   * Which note to open with the keyboard already in its textarea, rather than
   * making the double-click do that itself.
   *
   * Cleared shortly after the note has had its one chance to grab focus on
   * mount (StickyNote's autoFocus effect runs once, on creation) - a note
   * that scrolls off screen and back later must not re-steal the keyboard
   * just because this ref still names it.
   */
  const freshNoteIdRef = useRef<string | null>(null);

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
    const groups: { ws: Workspace; box: Rect; sessionIds: string[] }[] = [];
    const wsBySession = new Map<string, Workspace>();
    for (const ws of workspaces) {
      const members = sessionsIn(ws, sessions);
      for (const s of members) wsBySession.set(s.id, ws);
      const box = workspaceBounds(members.map((s) => s.window));
      if (box) groups.push({ ws, box, sessionIds: members.map((s) => s.id) });
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
      onDoubleClick={onDoubleClick}
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
          <WorkspaceFrame
            key={g.ws.id}
            ws={g.ws}
            box={g.box}
            sessionIds={g.sessionIds}
            zoom={viewport.zoom}
          />
        ))}

        <MessageEdges sessions={sessions} />

        {onScreen.map((session) => (
          <TerminalWindow
            key={session.id}
            session={session}
            workspace={wsBySession.get(session.id)}
            zoom={viewport.zoom}
            dpr={devicePixelRatio}
            renderScale={renderScale}
            selected={selectedId === session.id}
            maximized={maximizedId === session.id}
            onMaximize={toggleMaximize}
          />
        ))}

        {notesOnScreen.map((note) => (
          <StickyNote
            key={note.id}
            note={note}
            zoom={viewport.zoom}
            selected={selectedNoteId === note.id}
            autoFocus={freshNoteIdRef.current === note.id}
          />
        ))}
      </div>

      {paletteOpen && (
        <Palette
          isMac={IS_MAC}
          onPick={onPalettePick}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {/* Outside .world on purpose - see JumpLabels for why the badges do not
          scale with the canvas. Every window gets one, including those culled
          from the world layer, so a badge never points at nothing. */}
      {jump && (
        <JumpLabels
          items={jump.ids.flatMap((id, i) => {
            const session = sessions.find((x) => x.id === id);
            const label = jump.labels[i];
            // A session that left mid-jump, or a canvas larger than the
            // alphabet covers: no badge rather than a wrong one.
            return session && label ? [{ session, label }] : [];
          })}
          typed={jump.typed}
          viewport={viewport}
        />
      )}
    </div>
  );
}

