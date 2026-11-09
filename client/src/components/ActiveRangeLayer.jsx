import { useEffect, useState } from 'react';
import { socket } from '../socket.js';

// **The active fighter's attack range (decided, batch 3):** during a fight,
// the squares the active fighter's Stance reaches now are shaded very faintly
// red on the map or lane. The server works them out (`fight:active_range`,
// with modifiers and sight), refreshed whenever the stage changes. It stays
// up during choices too (decided: the table shares a player monitor), under
// whatever is being picked.
export default function ActiveRangeLayer({ mode, active = true, quadOf, width, height, zIndex = 4 }) {
  const [range, setRange] = useState(null);
  useEffect(() => {
    if (!active) {
      setRange(null);
      return undefined;
    }
    let alive = true;
    let timer = null;
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(() => socket.emit('fight:active_range', { mode }, (r) => alive && setRange(r ?? null)), 300);
    };
    load();
    socket.on('stage:updated', load);
    return () => {
      alive = false;
      clearTimeout(timer);
      socket.off('stage:updated', load);
    };
  }, [mode, active]);
  if (!range?.squares?.length) return null;
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} style={{ zIndex }} aria-hidden>
      {range.squares.map((sq) => {
        const q = quadOf(sq.col, sq.row);
        return q ? <polygon key={`${sq.col},${sq.row}`} points={q.map((p) => p.join(',')).join(' ')} fill="rgba(239,68,68,0.09)" stroke="rgba(239,68,68,0.2)" strokeWidth="1" /> : null;
      })}
    </svg>
  );
}
