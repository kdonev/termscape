import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useStore } from '../state/store.js';

interface Props {
  sessionId: string;
  /** Redraws when the window is resized so cols/rows follow the geometry. */
  w: number;
  h: number;
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
 * Mounted only while the window is in view and above the LOD zoom threshold;
 * unmounting is how the canvas stays cheap. On mount it replays the hub's
 * serialized screen before the live stream, so a re-attached window shows its
 * real content immediately instead of flashing empty.
 */
export function TerminalView({ sessionId, w, h, focused }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const client = useStore((s) => s.client);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !client) return;

    const term = new XTerm({
      theme: THEME,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: focused,
      scrollback: 5000,
      allowProposedApi: true,
convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    try {
      term.loadAddon(new WebglAddon());
    } catch {
      // No WebGL context available; the DOM renderer is correct, just slower.
    }

    termRef.current = term;
    fitRef.current = fit;

    // Replay the hub's snapshot first, then subscribe to live output. Doing it
    // in this order is what prevents a visible empty flash on reattach.
    const pending = useStore.getState().takeSnapshot(sessionId);
    if (pending) term.write(pending);

    const detach = client.attach(sessionId, (chunk) => term.write(chunk));
    const onData = term.onData((d) => client.sendInput(sessionId, d));

    // clientWidth/Height are layout sizes, unaffected by the canvas CSS
    // transform, so fit computes the right cols/rows at any zoom level.
    try {
      fit.fit();
      client.send({ t: 'resize', sessionId, cols: term.cols, rows: term.rows });
    } catch {
      // Element not laid out yet; the size effect below will retry.
    }

    return () => {
      onData.dispose();
      detach();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Deliberately not re-running on w/h/focused: remounting a terminal loses
    // its viewport. Those are handled by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, client]);

  // Geometry changes reflow the PTY rather than rebuilding the terminal.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !client) return;
    const id = requestAnimationFrame(() => {
      try {
        fit.fit();
        client.send({ t: 'resize', sessionId, cols: term.cols, rows: term.rows });
      } catch {
        // Zero-sized during a collapse animation; nothing to do.
      }
    });
    return () => cancelAnimationFrame(id);
  }, [w, h, sessionId, client]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.cursorBlink = focused;
    if (focused) term.focus();
  }, [focused]);

  return <div className="term-host" ref={hostRef} />;
}
