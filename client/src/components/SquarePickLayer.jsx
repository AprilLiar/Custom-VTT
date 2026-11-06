import { useSquarePick } from '../lib/squarePick.js';

// The glowing squares of the open square pick (lib/squarePick.js), over the
// map or the lane: tap one to pick it. `quadOf(col, row)` gives a square's
// polygon in stage pixels ([[x, y], …]) or null; `mode` is this board's.
// Free Movement squares show their Speed cost.
export default function SquarePickLayer({ mode, quadOf, width, height, zIndex = 8 }) {
  const pick = useSquarePick();
  if (!pick || pick.mode !== mode) return null;
  const move = pick.tone === 'move';
  const fill = move ? 'rgba(56,189,248,0.32)' : 'rgba(190,242,100,0.34)';
  const stroke = move ? '#38bdf8' : '#bef264';
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} style={{ zIndex }} aria-label={pick.title ?? 'Pick a square'}>
      {pick.options.map((o) => {
        if (o.col == null) return null;
        const q = quadOf(o.col, o.row);
        if (!q) return null;
        const cx = q.reduce((n, p) => n + p[0], 0) / q.length;
        const cy = q.reduce((n, p) => n + p[1], 0) / q.length;
        const size = Math.max(10, Math.min(18, Math.abs(q[1][0] - q[0][0]) * 0.32));
        return (
          <g
            key={o.id}
            className="pointer-events-auto cursor-pointer"
            role="button"
            aria-label={o.label ?? o.id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              pick.onPick(o.id);
            }}
          >
            <polygon points={q.map((p) => p.join(',')).join(' ')} fill={fill} stroke={stroke} strokeWidth="2">
              <animate attributeName="opacity" values="0.75;1;0.75" dur="1.6s" repeatCount="indefinite" />
            </polygon>
            {o.cost != null && (
              <text x={cx} y={cy + size / 3} textAnchor="middle" fontSize={size} fontWeight="800" fill="white" stroke="black" strokeWidth="3" paintOrder="stroke">
                {o.cost}
              </text>
            )}
            {o.title && <title>{o.title}</title>}
          </g>
        );
      })}
    </svg>
  );
}
