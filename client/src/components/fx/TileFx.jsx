import { motion } from 'framer-motion';

// **Board animations (phase 3): obstacles and Copies.** What the beat playing
// did to the tiles: a tile placed drops in with dust, one destroyed breaks
// into debris, one moved leaves a trail from where it was (a new Copy splits
// off its Original). `quadOf(col, row)` gives a stored square's corners (the
// map's cell, the lane's segment); `d` scales it all.
export default function TileFx({ beat, quadOf, d }) {
  const effects = (beat?.effects ?? []).filter((e) => e.kind === 'tile');
  if (!effects.length) return null;
  const s = beat.speed ?? 1;
  const centerOf = (at) => {
    const q = at ? quadOf(at.col, at.row) : null;
    if (!q?.length) return null;
    const pts = q.map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
    return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
  };
  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ zIndex: 39 }} aria-hidden>
      {effects.map((e) => {
        const at = centerOf(e.data.at);
        if (!at) return null;
        const from = centerOf(e.data.from);
        const key = `${beat.id}:${e.id}`;
        if (e.data.change === 'destroyed') return <Debris key={key} at={at} d={d} s={s} />;
        return (
          <span key={key}>
            {from && <Trail from={from} to={at} d={d} s={s} ghost={e.data.tile === 'copy'} />}
            <DropIn at={at} d={d} s={s} delay={from ? 0.2 : 0} />
          </span>
        );
      })}
    </div>
  );
}

function DropIn({ at, d, s, delay }) {
  return (
    <motion.div
      className="absolute rounded-full"
      style={{ left: at.x - d / 2, top: at.y - d * 0.2, width: d, height: d * 0.4, border: `${Math.max(2, d * 0.06)}px solid rgba(212,212,216,0.75)`, filter: 'blur(1px)' }}
      initial={{ opacity: 0, scale: 0.4 }}
      animate={{ opacity: [0, 0.9, 0], scale: [0.4, 1.4, 1.8] }}
      transition={{ duration: 0.45 * s, delay: delay * s, ease: 'easeOut' }}
    />
  );
}

function Debris({ at, d, s }) {
  return (
    <div className="absolute" style={{ left: at.x, top: at.y }}>
      {Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2;
        const size = d * (0.1 + (i % 3) * 0.03);
        return (
          <motion.span
            key={i}
            className="absolute bg-stone-400"
            style={{ left: -size / 2, top: -size / 2, width: size, height: size, borderRadius: 2, boxShadow: '0 0 0 1px rgba(0,0,0,0.6)' }}
            initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
            animate={{ x: Math.cos(a) * d * 0.6, y: [0, Math.sin(a) * d * 0.4 - d * 0.3, Math.sin(a) * d * 0.4 + d * 0.2], opacity: [1, 1, 0], rotate: 180 }}
            transition={{ duration: 0.5 * s, ease: 'easeOut' }}
          />
        );
      })}
      <motion.div
        className="absolute rounded-full"
        style={{ left: -d / 2, top: -d / 2, width: d, height: d, background: 'radial-gradient(circle, rgba(168,162,158,0.7) 20%, rgba(0,0,0,0) 70%)' }}
        initial={{ opacity: 0.9, scale: 0.6 }}
        animate={{ opacity: 0, scale: 1.5 }}
        transition={{ duration: 0.5 * s, ease: 'easeOut' }}
      />
    </div>
  );
}

function Trail({ from, to, d, s, ghost }) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const angle = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return (
    <motion.div
      className="absolute"
      style={{ left: from.x, top: from.y - d * 0.15, width: len, height: d * 0.3, transformOrigin: '0 50%', rotate: angle, borderRadius: d, background: ghost ? 'linear-gradient(to right, rgba(167,139,250,0), rgba(167,139,250,0.7))' : 'linear-gradient(to right, rgba(212,212,216,0), rgba(212,212,216,0.6))' }}
      initial={{ scaleX: 0, opacity: 1 }}
      animate={{ scaleX: [0, 1, 1], opacity: [1, 1, 0] }}
      transition={{ duration: 0.5 * s, times: [0, 0.5, 1], ease: 'easeOut' }}
    />
  );
}
