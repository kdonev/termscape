import { memo, useCallback, useRef, useState } from 'react';
import type { Workspace } from '@termscape/protocol';
import { useStore } from '../state/store.js';
import type { Rect } from './viewport.js';

interface Props {
  ws: Workspace;
  /** The bounds of the workspace's windows, padded - see workspaceBounds. */
  box: Rect;
  /** Every window in the workspace, on screen or not. */
  sessionIds: readonly string[];
  zoom: number;
}

/**
 * The dashed frame around a workspace's windows, and the handle that moves
 * all of them at once.
 *
 * The frame itself stays transparent to the pointer - it covers the empty
 * canvas between windows, which has to keep panning and taking double-clicks
 * for notes. Only the label is a handle, the way a window's title bar is.
 *
 * There is no workspace position to store: the frame is drawn from the
 * windows' own rects, so moving a workspace is moving each of its windows by
 * the same offset, and the frame follows by construction.
 */
export const WorkspaceFrame = memo(function WorkspaceFrame({ ws, box, sessionIds, zoom }: Props) {
  const moveWindowsBy = useStore((s) => s.moveWindowsBy);
  const dragRef = useRef<{ x: number; y: number; ids: readonly string[] } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // Not the canvas's: a press here is a grab, not a pan or a deselect.
      e.stopPropagation();
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      // Membership is taken at the grab, so a window that joins mid-drag is
      // not yanked across the canvas to catch up.
      dragRef.current = { x: e.clientX, y: e.clientY, ids: sessionIds };
      setDragging(true);
    },
    [sessionIds],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // Divided by zoom so the workspace tracks the cursor in world space, as
      // a dragged window does.
      moveWindowsBy(d.ids, (e.clientX - d.x) / zoom, (e.clientY - d.y) / zoom);
      dragRef.current = { ...d, x: e.clientX, y: e.clientY };
    },
    [moveWindowsBy, zoom],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
  }, []);

  return (
    <div
      className="ws-group"
      style={{
        transform: `translate(${box.x}px, ${box.y}px)`,
        width: box.w,
        height: box.h,
        // `color` as well as the border: the frame's background wash is
        // mixed from currentColor, and the label inherits it.
        color: ws.color,
        borderColor: ws.color,
      }}
    >
      <span
        className={`ws-label${dragging ? ' dragging' : ''}`}
        title="Drag to move the whole workspace"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {ws.name}
        <span className="ws-path">{ws.rootPath}</span>
      </span>
    </div>
  );
});
