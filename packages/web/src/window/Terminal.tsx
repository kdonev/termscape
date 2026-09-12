import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { describeSnapshotModes } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import { debug, debugOn } from '../debug.js';
import { terminalFontSize } from '../canvas/viewport.js';
import { wheelAction, wheelKey } from './wheel.js';
import { rightClickAction } from './rightClick.js';
import { readClipboard, writeClipboard } from './clipboard.js';
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_LINE_HEIGHT,
  gridFor,
  measureBaseCell,
  renderScaleToFit,
} from './grid.js';

interface Props {
  sessionId: string;
  /** Redraws when the window is resized so cols/rows follow the geometry. */
  w: number;
  h: number;
  /**
   * The canvas zoom, quantised to a whole device pixel of text height and
   * shared by every terminal. See the host scaling note below. Ignored in
   * `grid: 'follow'`, which computes its own to fit the given grid instead.
   */
  renderScale: number;
  focused: boolean;
  /**
   * `'drive'` (default, every existing call site): size the PTY from this
   * window's own geometry and send `resize` when it changes - today's
   * behaviour, unchanged.
   *
   * `'follow'`: never touch the PTY's size. Two browsers attached to one PTY
   * both wanting to set it would fight, and the owner's window would lose -
   * left rendering on a grid the PTY no longer has, which reads as garbled
   * output on the *owner's* screen with nothing on the sharer's side to
   * explain it. So a share view takes `cols`/`rows` from the session (driven
   * by the owner) and only picks a `renderScale` to fit that grid into its
   * own viewport, using the same counter-scale machinery below.
   */
  grid?: 'drive' | 'follow';
  /** Required when `grid: 'follow'`: the grid to display, not to request. */
  cols?: number;
  rows?: number;
}

const THEME = {
  background: '#0e1117',
  foreground: '#d5dae2',
  cursor: '#7c9cf5',
  selectionBackground: '#2c3b57',
  black: '#1c2027', red: '#e06c75', green: '#88c07a', yellow: '#d8b271',
  blue: '#7c9cf5', magenta: '#c07ac8', cyan: '#5ab4c4', white: '#c3c9d3',
  brightBlack: '#4a5262', brightRed: '#ef8b93', brightGreen: '#a3d497',
  brightYellow: '#e9cb92', brightBlue: '#9db4f8', brightMagenta: '#d69ddc',
  brightCyan: '#7fcdda', brightWhite: '#e8ecf2',
};

/**
 * What this terminal currently believes about the mouse, for a trace.
 *
 * Two facts decide whether a wheel is the program's business or xterm's, and
 * only one of them is public API. `modes.mouseTrackingMode` says whether the
 * program asked for reports at all; the encoding says which shape they take,
 * and that lives on the core service - reached defensively, because a trace
 * that throws is worse than one that says "unknown".
 *
 * `buffer.active.type` is here because it explains the other half of the
 * symptom. On the alternate screen there is no scrollback to fall back to, so
 * a program that has not asked for reports cannot be scrolled by any means
 * and a wheel over it does nothing at all - which is a different bug from a
 * report that was encoded and lost.
 */
function mouseState(term: XTerm): Record<string, unknown> {
  let encoding: string = 'unknown';
  let protocol: string = 'unknown';
  try {
    const svc = (term as unknown as {
      _core?: { coreMouseService?: { activeEncoding?: string; activeProtocol?: string } };
    })._core?.coreMouseService;
    if (svc?.activeEncoding) encoding = svc.activeEncoding;
    if (svc?.activeProtocol) protocol = svc.activeProtocol;
  } catch {
    // A future xterm may move this. The public half below still answers.
  }
  return {
    tracking: term.modes.mouseTrackingMode,
    protocol,
    encoding,
    screen: term.buffer.active.type,
    grid: `${term.cols}x${term.rows}`,
    viewportY: term.buffer.active.viewportY,
    baseY: term.buffer.active.baseY,
  };
}

/**
 * A live xterm bound to one session.
 *
 * Mounted for as long as the window is in view, at any zoom; culling offscreen
 * windows is what keeps the canvas cheap. It replays the hub's serialized
 * screen before the live stream, so a re-attached window shows its real
 * content immediately instead of flashing empty - see the snapshot note in the
 * mount effect for why that takes two routes rather than one.
 *
 * ## Why the host is scaled
 *
 * xterm rasterizes glyphs into a canvas sized in CSS pixels times
 * devicePixelRatio. It has no idea the canvas sits inside `scale(zoom)`, so the
 * world transform resamples an already-finished bitmap — blurry above zoom 1,
 * smeared below it. Nothing inside xterm can fix that, because a canvas bitmap
 * cannot be re-rasterized by the compositor the way DOM text can.
 *
 * So the terminal is rendered into a host `k` times larger with a `k` times
 * larger font, then counter-scaled by `1/k`. For a frame `W` CSS px wide the
 * backing store is `W·k·dpr` device px and it paints at `W·k·(1/k)·zoom` CSS px,
 * a ratio of `k : zoom` — exactly 1:1 when `k` is the zoom.
 *
 * The grid does not come from that scaled box — see grid.ts for why it cannot.
 * cols/rows are computed from the window's own size, so zooming never reflows
 * the agent's output.
 */
export function TerminalView({
  sessionId,
  w,
  h,
  renderScale,
  focused,
  grid = 'drive',
  cols: followCols,
  rows: followRows,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const client = useStore((s) => s.client);
  const follow = grid === 'follow';

  // Read through a ref inside the mount effect: the initial grid must match
  // the current one (a share view mounted mid-session has to start at the
  // owner's actual size) without followCols/followRows becoming a remount
  // trigger - the same reasoning effectiveScaleRef documents below for the
  // font size.
  const followGridRef = useRef({ cols: followCols, rows: followRows });
  followGridRef.current = { cols: followCols, rows: followRows };

  /**
   * Size the PTY from the window geometry. The frame's clientWidth/Height are
   * layout sizes, unaffected by the world transform or by the host's own
   * counter-scale, so this is world pixels at any zoom.
   *
   * Never called in 'follow' mode - see the prop's own comment for why a
   * share view must not do this.
   */
  const applyGrid = useCallback(() => {
    if (follow) return;
    const term = termRef.current;
    const frame = frameRef.current;
    if (!term || !frame || !client) return;
    const { cols, rows } = gridFor(
      frame.clientWidth,
      frame.clientHeight,
      measureBaseCell(),
      TERMINAL_LINE_HEIGHT,
    );
    if (cols === term.cols && rows === term.rows) return;
    // Logged next to the input, because a mouse report is a pair of
    // coordinates and xterm refuses to encode one outside this grid. A window
    // and a pty that disagree on size therefore lose wheels near the edges
    // and nowhere else, which reads as intermittent rather than as a size
    // problem.
    debug('attach', sessionId, `grid ${term.cols}x${term.rows} -> ${cols}x${rows}`);
    term.resize(cols, rows);
    client.send({ t: 'resize', sessionId, cols, rows });
  }, [client, sessionId, follow]);

  // The render scale that fits the owner's grid into this view's own
  // viewport, recomputed whenever that grid or the viewport changes. Seeded
  // synchronously from props rather than starting at 1 and correcting a
  // frame later: the grid is already known the moment a share view has a
  // session to show at all.
  const [followScale, setFollowScale] = useState(() =>
    follow && followCols && followRows
      ? renderScaleToFit(followCols, followRows, w, h, window.devicePixelRatio || 1, measureBaseCell())
      : renderScale,
  );
  const effectiveScale = follow ? followScale : renderScale;
  // Read through a ref for the same reason followGridRef is: the mount
  // effect below reads this once, at creation, for the initial font size -
  // not a value it should chase afterward, and not a remount trigger either.
  const effectiveScaleRef = useRef(effectiveScale);
  effectiveScaleRef.current = effectiveScale;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !client) return;

    // In 'follow' mode the terminal is created at the owner's grid directly,
    // rather than at xterm's 80x24 default and resized a moment later -
    // otherwise the very first thing written into it (the snapshot below)
    // would wrap against the wrong width for one frame.
    const initialGrid = follow ? followGridRef.current : null;
    const term = new XTerm({
      theme: THEME,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: terminalFontSize(effectiveScaleRef.current),
      lineHeight: TERMINAL_LINE_HEIGHT,
      cursorBlink: focused,
      scrollback: 5000,
      allowProposedApi: true,
      convertEol: false,
      ...(initialGrid?.cols && initialGrid?.rows
        ? { cols: initialGrid.cols, rows: initialGrid.rows }
        : {}),
    });
    term.open(host);

    /*
     * WebGL where it is available, and a way back when it is not.
     *
     * A browser keeps only so many live WebGL contexts - around sixteen - and
     * hands out the next one by dropping the oldest. That was academic while
     * terminals unmounted below a zoom threshold; now that every window on
     * screen carries one, a canvas of twenty is over the limit by design. A
     * lost context leaves the addon rendering nothing at all, so it is dropped
     * on loss and xterm falls back to the DOM renderer - slower, and correct.
     */
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No WebGL context available; the DOM renderer is correct, just slower.
    }

    termRef.current = term;

    /*
     * The serialized screen, which arrives by one of two routes.
     *
     * A remote session's screen lives on another machine, so it comes back
     * in-band on the output stream and the listener below writes it like any
     * other chunk. A local one is answered with a `snapshot` message instead -
     * and that message is sent in reply to the attach *this mount is about to
     * send*, so at this point there is nothing to take yet. Taking it here and
     * stopping was a silent bug: the snapshot landed in the store a moment
     * later with nobody left to read it, and a freshly mounted local window
     * stayed blank until the program happened to redraw. An idle agent never
     * does, so the window simply stayed empty.
     *
     * Hence both: take one if a previous mount left it behind, and otherwise
     * watch for the one this attach is about to produce. `wrote` is what keeps
     * the two honest - a snapshot is the whole screen, so replaying it after
     * live output has already been applied would undo that output rather than
     * complete it.
     */
    let wrote = false;
    const write = (chunk: string) => {
      if (chunk.length === 0) return;
      wrote = true;
      term.write(chunk);
    };

    const pending = useStore.getState().takeSnapshot(sessionId);
    if (pending) write(pending);
    debug(
      'attach',
      sessionId,
      'mounted;',
      pending
        ? `snapshot ${pending.length}B restores: ${describeSnapshotModes(pending)}`
        : 'no snapshot yet; watching for the one this attach asks for',
    );

    const detach = client.attach(sessionId, write);

    const unwatchSnapshot = useStore.subscribe((s) => {
      if (wrote || !s.pendingSnapshots.has(sessionId)) return;
      const late = useStore.getState().takeSnapshot(sessionId);
      if (!late) return;
      debug(
        'attach',
        sessionId,
        `snapshot arrived after mount, ${late.length}B restores:`,
        describeSnapshotModes(late),
      );
      write(late);
    });

    /*
     * Whether a wheel became a mouse report, and nothing else can answer it.
     *
     * Every hop downstream can see reports that were sent; none of them can
     * see one xterm decided not to encode - and that decision is where a
     * scroll that "does nothing" usually dies. xterm drops an event before
     * encoding it if no program asked for tracking, or if the coordinates
     * fall outside the grid it thinks it has.
     *
     * So the wheel is bracketed. The capture listener on the frame runs
     * before xterm's own listener inside it, the bubble listener after, and
     * the count of reports between them says which of the two happened. The
     * viewport position is taken at both ends for the same reason: a wheel
     * that scrolled xterm's own scrollback instead of reaching the program is
     * the other outcome worth naming, and it looks like success from here.
     */
    let reports = 0;
    let before = { reports: 0, viewportY: 0 };
    const onWheelCapture = (e: WheelEvent) => {
      if (!debugOn('input')) return;
      before = { reports, viewportY: term.buffer.active.viewportY };
      const wheel = { deltaY: e.deltaY, deltaMode: e.deltaMode };
      debug('input', sessionId, 'wheel', wheel, mouseState(term));
    };
    const onWheelBubble = (e: WheelEvent) => {
      if (!debugOn('input')) return;
      const sent = reports - before.reports;
      const scrolled = term.buffer.active.viewportY - before.viewportY;
      const verdict =
        sent > 0
          ? `${sent} report(s) to the program`
          : scrolled !== 0
            ? `no report; xterm scrolled its own buffer by ${scrolled}`
            : 'NOTHING: no report encoded and no local scroll';
      debug('input', sessionId, 'wheel ->', verdict, {
        defaultPrevented: e.defaultPrevented,
        tracking: term.modes.mouseTrackingMode,
        screen: term.buffer.active.type,
      });
    };
    const frame = frameRef.current;
    frame?.addEventListener('wheel', onWheelCapture, { capture: true, passive: true });
    frame?.addEventListener('wheel', onWheelBubble, { passive: true });

    /*
     * Right-click, decided the way rightClick.ts decides it and executed
     * here because that is where the clipboard and the terminal both live.
     *
     * Capture is what puts this ahead of xterm's own listener on the
     * `.xterm-screen` descendant, for the same reason onWheelCapture does -
     * without it, a program with mouse tracking on would already have
     * consumed the event by the time it reached here. `mousedown` rather than
     * `contextmenu` because that is the event xterm itself listens for when
     * deciding whether to encode a button-2 report; matching it means the
     * two can never disagree about which button 2 this frame is looking at.
     */
    const onRightClickMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      const action = rightClickAction({
        mouseTracking: term.modes.mouseTrackingMode,
        hasSelection: term.hasSelection(),
        shift: e.shiftKey,
      });
      if (action === 'program') {
        // xterm still gets to encode this as a mouse report; staying out of
        // its way is the whole point of this branch.
        debug('input', sessionId, 'right-click -> program (mouse tracking on)');
        return;
      }
      e.preventDefault();
      // Also keeps xterm from clearing the selection out from under a copy -
      // its own mousedown handler runs right after this one in capture order.
      e.stopPropagation();
      if (action === 'copy') {
        const text = term.getSelection();
        void writeClipboard(text).then((wrote) => {
          debug(
            'input',
            sessionId,
            wrote
              ? `right-click -> copied ${text.length} char(s)`
              : 'right-click -> copy failed; selection kept',
          );
          if (wrote) term.clearSelection();
        });
      } else {
        void readClipboard().then((text) => {
          if (text === null) {
            // The one a LAN user will hit: navigator.clipboard.readText does
            // not exist outside a secure context, so a plain-http canvas
            // opened from another machine cannot read the clipboard at all.
            // Traced rather than thrown, because there is nothing to recover
            // into - Ctrl+V still works, since it never touches this API.
            debug('input', sessionId, 'right-click -> paste: clipboard unreadable (non-secure context?)');
            return;
          }
          if (text.length === 0) {
            debug('input', sessionId, 'right-click -> paste: clipboard empty');
            return;
          }
          debug('input', sessionId, `right-click -> pasted ${text.length} char(s)`);
          term.paste(text);
        });
      }
    };
    frame?.addEventListener('mousedown', onRightClickMouseDown, { capture: true });

    /*
     * The last resort, for a window that would otherwise ignore the wheel.
     *
     * See wheel.ts for when this applies and why it has to exist at all. It
     * only ever fires where xterm was going to do nothing anyway - no program
     * wants reports and there is no history to move through - so returning
     * false here suppresses nothing the user would have got.
     */
    term.attachCustomWheelEventHandler((e) => {
      const action = wheelAction(
        {
          mouseTracking: term.modes.mouseTrackingMode,
          totalLines: term.buffer.active.length,
          rows: term.rows,
        },
        e.deltaY,
      );
      const key = wheelKey(action);
      if (!key) return true;
      debug('input', sessionId, `wheel -> ${action} (nothing else could move)`);
      client.sendInput(sessionId, key);
      return false;
    });

    const onData = term.onData((d) => {
      reports++;
      client.sendInput(sessionId, d);
    });
    /*
     * Mouse reports do not all come out of onData. xterm splits its input, and
     * the default mouse encoding — what a program gets when it enables
     * tracking (mode 1000/1002/1003) without also asking for SGR — goes to
     * onBinary instead. Unwired, a wheel over such a terminal produced nothing
     * at all, which is what made scrolling look broken in some agents and fine
     * in others: the ones that ask for SGR were never on this path.
     *
     * These are bytes, not text: the default encoding spells a coordinate as
     * `32 + n`, so past column or row 95 a report contains bytes above 0x7f.
     * Sending them down the UTF-8 input path re-encoded each of those as two
     * bytes, and the program - unable to parse the report it had asked for -
     * printed the remainder as text. That is the garbage that appeared in
     * terminals whenever the mouse moved over the wide half of one. Hence
     * sendInputBytes, which is byte-faithful end to end.
     */
    const onBinary = term.onBinary((d) => {
      reports++;
      client.sendInputBytes(sessionId, d);
    });

    applyGrid();

    return () => {
      frame?.removeEventListener('wheel', onWheelCapture, { capture: true });
      frame?.removeEventListener('wheel', onWheelBubble);
      frame?.removeEventListener('mousedown', onRightClickMouseDown, { capture: true });
      unwatchSnapshot();
      onData.dispose();
      onBinary.dispose();
      detach();
      term.dispose();
      termRef.current = null;
    };
    // Deliberately not re-running on w/h/renderScale/focused: remounting a
    // terminal loses its viewport. Those are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, client]);

  // Only the window geometry changes the grid. Zoom deliberately does not.
  // No-op in 'follow' mode; kept unconditional so this hook never changes
  // count between renders.
  useEffect(() => {
    const id = requestAnimationFrame(applyGrid);
    return () => cancelAnimationFrame(id);
  }, [w, h, applyGrid]);

  /**
   * The 'follow' half of resizing: apply the owner's grid to this terminal -
   * a local `resize()`, never a `resize` message - and refit the render scale
   * to whatever viewport this view actually has. This is how a share view
   * ever learns the owner changed the grid at all: `SessionManager.resize`
   * emits `sessionUpserted` when cols/rows actually change, and that is the
   * only signal that reaches here.
   */
  useEffect(() => {
    if (!follow || !followCols || !followRows) return;
    const term = termRef.current;
    if (term && (term.cols !== followCols || term.rows !== followRows)) {
      term.resize(followCols, followRows);
    }
    setFollowScale(
      renderScaleToFit(followCols, followRows, w, h, window.devicePixelRatio || 1, measureBaseCell()),
    );
  }, [follow, followCols, followRows, w, h]);

  // Re-rasterize at the new resolution, keeping the same grid. No resize is
  // sent: the PTY's view of the terminal has not changed, only its sharpness.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const fontSize = terminalFontSize(effectiveScale);
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
  }, [effectiveScale]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorBlink = focused;
    if (focused) term.focus();
  }, [focused]);

  return (
    <div
      className="term-host"
      ref={frameRef}
      /*
       * The menu is still suppressed, but now because the mousedown listener
       * above has already turned button 2 into a program report, a copy, or
       * a paste - not because a program is assumed to always own it. Letting
       * the browser's menu through on top of any of those would just cover
       * up whichever one happened.
       */
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="term-scale"
        ref={hostRef}
        style={{
          width: `${100 * effectiveScale}%`,
          height: `${100 * effectiveScale}%`,
          transform: `scale(${1 / effectiveScale})`,
        }}
      />
    </div>
  );
}
