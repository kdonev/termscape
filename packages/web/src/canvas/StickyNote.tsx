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
 * the handle, window-level move/up listeners while dragging, and a rectRef so
 * the move handler always reads the latest rect instead of one captured at
 * drag start. The one thing a window never needs that a note does is
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
  const [drag, setDrag] = useState<null | { mode: 'move' | 'resize'; ox: number; oy: number }>(
    null,
  );
  const rectRef = useRef(note);
  rectRef.current = note;
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) textRef.current?.focus();
    // Only on mount: a note re-rendering after a remote edit must not steal
    // the keyboard back from whatever the user is doing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setDrag({ mode, ox: e.clientX, oy: e.clientY });
    },
    [onSelect],
  );

  useEffect(() => {
    if (!drag) return;

    const onMove = (e: PointerEvent) => {
      // Divide by zoom so the note tracks the cursor in world space rather
      // than running away from it when zoomed out - identical to the window
      // drag handler.
      const dx = (e.clientX - drag.ox) / zoom;
      const dy = (e.clientY - drag.oy) / zoom;
      const r = rectRef.current;
      putNote(
        drag.mode === 'move'
          ? { ...r, x: r.x + dx, y: r.y + dy, updatedAt: Date.now() }
          : {
              ...r,
              w: Math.max(MIN_W, r.w + dx),
              h: Math.max(MIN_H, r.h + dy),
              updatedAt: Date.now(),
            },
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
        // Stops the canvas from panning under a drag-select of the text, and
        // keeps a click here from re-triggering the outer onSelect's z-bump
        // math twice for the one gesture.
        onPointerDown={(e) => e.stopPropagation()}
        onChange={(e) => putNote({ ...note, text: e.target.value, updatedAt: Date.now() })}
      />

      <div className="resize-handle" onPointerDown={onPointerDown('resize')} />
    </div>
  );
});
