import { useCallback, useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../state/store.js';
import { terminalFontSize } from '../canvas/viewport.js';
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_LINE_HEIGHT,
  gridFor,
  measureBaseCell,
} from './grid.js';

interface Props {
  sessionId: string;
  /** Redraws when the window is resized so cols/rows follow the geometry. */
  w: number;
  h: number;
  /**
   * The canvas zoom, quantised to a whole device pixel of text height and
   * shared by every terminal. See the host scaling note below.
   */
  renderScale: number;
  focused: boolean;
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
 * A live xterm bound to one session.
 *
 * Mounted for as long as the window is in view, at any zoom; culling offscreen
 * windows is what keeps the canvas cheap. On mount it replays the hub's
 * serialized screen before the live stream, so a re-attached window shows its
 * real content immediately instead of flashing empty.
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
export function TerminalView({ sessionId, w, h, renderScale, focused }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const client = useStore((s) => s.client);

  // Read through a ref inside the mount effect: the initial font size must
  // match the current zoom (a terminal mounted while zoomed in has to start
  // sharp) without renderScale becoming a remount trigger.
  const scaleRef = useRef(renderScale);
  scaleRef.current = renderScale;

  /**
   * Size the PTY from the window geometry. The frame's clientWidth/Height are
   * layout sizes, unaffected by the world transform or by the host's own
   * counter-scale, so this is world pixels at any zoom.
   */
  const applyGrid = useCallback(() => {
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
    term.resize(cols, rows);
    client.send({ t: 'resize', sessionId, cols, rows });
  }, [client, sessionId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !client) return;

    const term = new XTerm({
      theme: THEME,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: terminalFontSize(scaleRef.current),
      lineHeight: TERMINAL_LINE_HEIGHT,
      cursorBlink: focused,
      scrollback: 5000,
      allowProposedApi: true,
convertEol: false,
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

    // Replay the hub's snapshot first, then subscribe to live output. Doing it
    // in this order is what prevents a visible empty flash on reattach.
    const pending = useStore.getState().takeSnapshot(sessionId);
    if (pending) term.write(pending);

    const detach = client.attach(sessionId, (chunk) => term.write(chunk));
    const onData = term.onData((d) => client.sendInput(sessionId, d));
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
    const onBinary = term.onBinary((d) => client.sendInputBytes(sessionId, d));

    applyGrid();

    return () => {
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
  useEffect(() => {
    const id = requestAnimationFrame(applyGrid);
    return () => cancelAnimationFrame(id);
  }, [w, h, applyGrid]);

  // Re-rasterize at the new resolution, keeping the same grid. No resize is
  // sent: the PTY's view of the terminal has not changed, only its sharpness.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const fontSize = terminalFontSize(renderScale);
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
  }, [renderScale]);

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
       * Right-click belongs to the program, not to the browser. xterm already
       * encodes button 2 for a program that asked for mouse reports; all that
       * was in the way was the context menu opening over the top of it.
       */
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        className="term-scale"
        ref={hostRef}
        style={{
          width: `${100 * renderScale}%`,
          height: `${100 * renderScale}%`,
          transform: `scale(${1 / renderScale})`,
        }}
      />
    </div>
  );
}
