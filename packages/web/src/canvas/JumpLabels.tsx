import type { Session, Viewport } from '@termscape/protocol';
import { worldToScreen } from './viewport.js';

/**
 * The badges shown over every window during a jump (issue 52).
 *
 * Drawn outside the world layer, in screen coordinates, rather than inside it
 * with everything else. A badge in the world would shrink with the canvas, and
 * the zoomed-out canvas is exactly where the jump earns its keep - an
 * unreadable badge on a 6px-wide window helps nobody. So the position comes
 * from the viewport and the size does not.
 *
 * Each badge sits at its window's top-left rather than its centre: centres
 * collide when windows overlap, and the corner is also where the eye already
 * is, next to the title.
 */
export function JumpLabels({
  items,
  typed,
  viewport,
}: {
  /**
   * The windows wearing badges, each with its own. Pairs rather than two
   * parallel arrays: a session leaving mid-jump would otherwise shift every
   * badge after it by one, and the badge you read would not be the badge you
   * get.
   */
  items: { session: Session; label: string }[];
  /** What has been typed so far, highlighted on the badges it still fits. */
  typed: string;
  viewport: Viewport;
}) {
  return (
    <div className="jump-layer">
      {items.map(({ session, label }) => {
        const dim = typed !== '' && !label.startsWith(typed);
        const at = worldToScreen({ x: session.window.x, y: session.window.y }, viewport);
        return (
          <span
            key={session.id}
            className={`jump-badge${dim ? ' dim' : ''}`}
            style={{ transform: `translate(${at.x}px, ${at.y}px)` }}
          >
            {[...label].map((ch, c) => (
              // The letters already typed are marked on every badge that is
              // still in the running, so a two-letter jump shows its progress
              // rather than looking like nothing happened.
              <span key={c} className={c < typed.length && !dim ? 'hit' : undefined}>
                {ch}
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}
