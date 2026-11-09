import { usePickViews } from '../lib/pickViews.js';
import { useSquarePick } from '../lib/squarePick.js';

// The board picks open now, as everyone sees them (lib/pickViews.js): a target
// pick's Range faint red and its targets brighter red, a square pick's
// squares lime, a Free Movement's reach sky blue. View-only — whoever is
// asked picks on their own SquarePickLayer, so their own pick isn't drawn twice.
export default function PickViewLayer({ mode, quadOf, width, height, zIndex = 7 }) {
  const views = usePickViews();
  const mine = useSquarePick();
  const shown = views.filter((v) => v.mode === mode && v.id !== mine?.key && !(v.kind === 'move' && mine?.tone === 'move' && v.id === `move:${mine.combatantId}`));
  if (!shown.length) return null;
  const poly = (q) => q.map((p) => p.join(',')).join(' ');
  const tone = (kind) =>
    kind === 'targets' ? { fill: 'rgba(239,68,68,0.45)', stroke: '#fca5a5' } : kind === 'move' ? { fill: 'rgba(56,189,248,0.24)', stroke: '#38bdf8' } : { fill: 'rgba(190,242,100,0.28)', stroke: '#bef264' };
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} style={{ zIndex }} aria-hidden>
      {shown.map((v) => (
        <g key={v.id}>
          {v.kind === 'targets' &&
            (v.area ?? []).map((sq) => {
              const q = quadOf(sq.col, sq.row);
              return q ? <polygon key={`a${sq.col},${sq.row}`} points={poly(q)} fill="rgba(239,68,68,0.16)" stroke="rgba(239,68,68,0.35)" strokeWidth="1" /> : null;
            })}
          {v.options.map((o) => {
            const q = quadOf(o.col, o.row);
            const t = tone(v.kind);
            return q ? <polygon key={o.id} points={poly(q)} fill={t.fill} stroke={t.stroke} strokeWidth="2" strokeDasharray={v.kind === 'move' ? '4 3' : undefined} /> : null;
          })}
        </g>
      ))}
    </svg>
  );
}
