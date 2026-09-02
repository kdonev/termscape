import { useEffect, useState } from 'react';
import type { Session } from '@aicanvas/protocol';
import { useStore } from '../state/store.js';

const FLASH_MS = 2600;

/**
 * Draws the two relationships that make the canvas readable as a system:
 * a faint permanent line from each agent to whoever spawned it, and a bright
 * animated arc for each message as it is delivered.
 */
export function MessageEdges({ sessions }: { sessions: Session[] }) {
  const flashes = useStore((s) => s.flashes);
  const [, force] = useState(0);

  // Flashes fade on a timer, so re-render while any are alive.
  useEffect(() => {
    if (flashes.length === 0) return;
    const id = setInterval(() => force((n) => n + 1), 80);
    return () => clearInterval(id);
  }, [flashes.length]);

  const byAddress = new Map(sessions.map((s) => [s.address, s]));
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const center = (s: Session) => ({
    x: s.window.x + s.window.w / 2,
    y: s.window.y + s.window.h / 2,
  });

  const lineage = sessions
    .filter((s) => s.spawnedBy && byId.has(s.spawnedBy))
    .map((s) => ({ id: s.id, a: center(byId.get(s.spawnedBy!)!), b: center(s) }));

  const now = Date.now();
  const live = flashes
    .map((f) => {
      const from = byAddress.get(f.from);
      const to = byAddress.get(f.to);
      const age = now - f.at;
      if (!from || !to || age > FLASH_MS) return null;
      return { ...f, a: center(from), b: center(to), t: age / FLASH_MS };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (lineage.length === 0 && live.length === 0) return null;

  // One large SVG in world space; the canvas transform scales it with the rest.
  const OFFSET = 100_000;
  return (
    <svg
      className="edges"
      style={{ left: -OFFSET, top: -OFFSET }}
      width={OFFSET * 2}
      height={OFFSET * 2}
      viewBox={`${-OFFSET} ${-OFFSET} ${OFFSET * 2} ${OFFSET * 2}`}
    >
      {lineage.map((l) => (
        <line
          key={`lin-${l.id}`}
          x1={l.a.x}
          y1={l.a.y}
          x2={l.b.x}
          y2={l.b.y}
          stroke="#39415a"
          strokeWidth={2}
          strokeDasharray="6 8"
        />
      ))}

      {live.map((f) => {
        const dx = f.b.x - f.a.x;
        const dy = f.b.y - f.a.y;
        // Bow the arc perpendicular to the run so two agents messaging each
        // other in both directions do not draw one line on top of the other.
        const cx = f.a.x + dx / 2 - dy * 0.12;
        const cy = f.a.y + dy / 2 + dx * 0.12;
        const color = f.failed ? '#e06c75' : '#7c9cf5';
        const px = (1 - f.t) ** 2 * f.a.x + 2 * (1 - f.t) * f.t * cx + f.t ** 2 * f.b.x;
        const py = (1 - f.t) ** 2 * f.a.y + 2 * (1 - f.t) * f.t * cy + f.t ** 2 * f.b.y;
        return (
          <g key={`msg-${f.id}`} opacity={1 - f.t * 0.8}>
            <path
              d={`M ${f.a.x} ${f.a.y} Q ${cx} ${cy} ${f.b.x} ${f.b.y}`}
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              strokeDasharray={f.failed ? '8 6' : undefined}
            />
            {!f.failed && <circle cx={px} cy={py} r={7} fill={color} />}
          </g>
        );
      })}
    </svg>
  );
}
