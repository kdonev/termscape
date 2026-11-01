import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Note, NoteColor } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import { snapWorldPx } from './viewport.js';

interface Props {
  note: Note;
  zoom: number;
  selected: boolean;
  /** True for a note just created this session - it should open with the
   *  keyboard already in its textarea rather than making the click do that. */
  autoFocus: boolean;
}

// Mirrors the floor `hub.saveNote` clamps to (see hub.ts MIN_NOTE_W/H) - kept
// local rather than shared, since it only has to agree closely enough that
// the drag never visibly overshoots before the hub's echo would correct it,
// and a note never echoes back to its own dragger anyway (see server.ts
// `broadcastExcept`).
const MIN_W = 120;
const MIN_H = 80;

const COLORS: NoteColor[] = ['yellow', 'pink', 'green', 'blue'];

/**
 * A free-floating sticky note on the canvas.
 *
 * Copies TerminalWindow's drag/resize pattern verbatim: pointer capture on
 * the handle, window-level move/up listeners while dragging, positions
 * measured from the rect captured at the grab, and a rectRef so everything
 * else about the note (text, colour, z) is the latest rather than the grab's. The one thing a window never needs that a note does is
 * broadcasting the result - see `putNote` in state/store.ts.
 */
export const StickyNote = memo(function StickyNote({ note, zoom, selected, autoFocus }: Props) {
  const { putNote, removeNote, selectNote } = useStore(
    useShallow((s) => ({
      putNote: s.putNote,
      removeNote: s.removeNote,
      selectNote: s.selectNote,
    })),
  );
  // A note is a navigation stop like a window, so it takes and releases the
  // keyboard on the same rule a terminal does (issue 52).
  const canvasMode = useStore((s) => s.canvasMode);
  const focused = selected && !canvasMode;
  const [drag, setDrag] = useState<null | {
    mode: 'move' | 'resize';
    ox: number;
    oy: number;
    start: Note;
  }>(null);
  const rectRef = useRef(note);
  rectRef.current = note;
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) textRef.current?.focus();
    // Only on mount: a note re-rendering after a remote edit must not steal
    // the keyboard back from whatever the user is doing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * Follow the selection in and out of canvas mode, exactly as Terminal.tsx
   * does. Keyed on `focused` alone, so a remote edit still cannot steal the
   * keyboard: that changes the note's text, not whether it is ours.
   *
   * The blur is the half that matters - entering canvas mode while the
   * cursor is in a note has to stop `hjkl` being typed into the note.
   */
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    if (focused) el.focus();
    else el.blur();
  }, [focused]);

  /**
   * Bring this note to the front of the stack, unless it already is.
   *
   * Read via `getState()` rather than a subscription: every note would
   * otherwise re-render on every other note's z change just to answer "am I
   * on top", which is the same one-off-read style Canvas.tsx uses for the
   * dialog and panel checks in its keydown handler.
   */
  const bringToFront = useCallback(() => {
    const notes = useStore.getState().notes;
    const topZ = Math.max(0, ...notes.map((n) => n.z));
    const r = rectRef.current;
    if (r.z < topZ) putNote({ ...r, z: topZ + 1 });
  }, [putNote]);

  const onSelect = useCallback(() => {
    selectNote(note.id);
    bringToFront();
  }, [selectNote, note.id, bringToFront]);

  const onPointerDown = useCallback(
    (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.target as Element).setPointerCapture(e.pointerId);
      onSelect();
      setDrag({ mode, ox: e.clientX, oy: e.clientY, start: rectRef.current });
    },
    [onSelect],
  );

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      // Measured from the grab and divided by zoom, identical to the window
      // drag handler - see the note there on why a step-wise delta runs off.
      const dx = (e.clientX - drag.ox) / zoom;
      const dy = (e.clientY - drag.oy) / zoom;
      const r = rectRef.current;
      const s = drag.start;
      putNote(
        drag.mode === 'move'
          ? { ...r, x: s.x + dx, y: s.y + dy, updatedAt: Date.now() }
          : {
              ...r,
              w: Math.max(MIN_W, s.w + dx),
              h: Math.max(MIN_H, s.h + dy),
              updatedAt: Date.now(),
            },
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
  }, [drag, putNote, zoom]);

  const { x, y, w, h } = note;
  // Same snapping TerminalWindow applies, minus the device-pixel-ratio input
  // it takes: that argument only matters for a canvas-rasterized terminal,
  // and a note's body is ordinary DOM text, which the browser antialiases
  // regardless of which whole CSS pixel it lands on.
  const px = snapWorldPx(x, zoom, 1);
  const py = snapWorldPx(y, zoom, 1);

  return (
    <div
      className={`note${selected ? ' selected' : ''}`}
      data-color={note.color}
      style={{
        transform: `translate(${px}px, ${py}px)`,
        width: w,
        height: h,
        zIndex: note.z + (selected ? 1000 : 0),
      }}
      onPointerDown={onSelect}
    >
      <header className="note-bar" onPointerDown={onPointerDown('move')}>
        {selected && (
          <span className="note-swatches">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`note-swatch${c === note.color ? ' active' : ''}`}
                data-color={c}
                title={c}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => putNote({ ...note, color: c, updatedAt: Date.now() })}
              />
            ))}
          </span>
        )}
        <span className="spacer" />
        <button
          className="btn danger"
          title="Delete this note"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => removeNote(note.id)}
        >
          ×
        </button>
      </header>

      <textarea
        ref={textRef}
        className="note-text"
        value={note.text}
        placeholder="Type something…"
        // Stops the canvas from panning under a drag-select of the text. That
        // also stops the note's own onPointerDown, so select here instead -
        // otherwise clicking into the text of a note leaves it unselected,
        // under its neighbours, and a terminal still holding the selection.
        onPointerDown={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        /*
         * Clicking into a note ends canvas mode, for the same reason it does
         * in a terminal: the click focuses the textarea natively and the
         * effect above cannot undo it, because `focused` is already false
         * while the mode is on and so never changes. The note would really
         * have the keyboard while the toolbar still claimed the canvas did.
         */
        onFocus={() => useStore.getState().setCanvasMode(false)}
        onChange={(e) => putNote({ ...note, text: e.target.value, updatedAt: Date.now() })}
      />

      <div className="resize-handle" onPointerDown={onPointerDown('resize')} />
    </div>
  );
});
