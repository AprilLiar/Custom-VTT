import { motion } from 'framer-motion';
import { TOKEN_BY_KEY } from '../../lib/panicTokens.js';
import { KIND_CLASS, TokenIcon } from '../../lib/panicIcons.jsx';
import { effectsFor, signOf } from '../../lib/boardFx.js';
import { ChallengeLock } from '../FighterOverlay.jsx';

// **Board animations (decided):** what the beat playing does to one fighter,
// drawn round it on the map or the lane. `center` (view pixels) and
// `diameter` (the figure's own size) place and scale everything, so one
// component serves both views. `centerOf(combatantId)`: another fighter's
// center (the Challenge points at its Challenger).
export default function FighterFx({ beat, combatantId, center, diameter, centerOf }) {
  const effects = effectsFor(beat, combatantId);
  if (!effects.length || !center) return null;
  const d = Math.max(28, diameter);
  const s = (beat.ms ?? 1000) / 1000;
  return (
    <div className="pointer-events-none absolute left-0 top-0" style={{ zIndex: 40 }} aria-hidden>
      {effects.map((e) => {
        const key = `${beat.id}:${e.id}`;
        if (e.kind === 'tokens') return <TokenFloat key={key} effect={e} center={center} d={d} s={s} />;
        if (e.kind === 'damage') return <DamagePop key={key} effect={e} center={center} d={d} s={s} />;
        if (e.kind === 'heal') return <NumberRise key={key} center={center} d={d} s={s} text={`+${e.data.amount}`} color="#4ade80" />;
        if (e.kind === 'shield') return <ShieldShell key={key} center={center} d={d} s={s} />;
        if (e.kind === 'challenge') {
          const to = centerOf?.(e.data.challengerId);
          return to ? <ChallengeFlash key={key} from={center} to={to} d={d} s={s} /> : null;
        }
        return null;
      })}
    </div>
  );
}

// Tokens gained or lost (decided): the token's picture with "+", "++", "-"
// or "--" beside it, about the figure's diameter, from its center; it flies up
// half a diameter while fading, gone by the end. Several kinds: side by side.
function TokenFloat({ effect, center, d, s }) {
  const changes = effect.data.changes ?? [];
  if (!changes.length) return null;
  const item = d;
  const icon = d * 0.58;
  const width = item * changes.length;
  return (
    <motion.div
      className="absolute flex items-center justify-center"
      style={{ left: center.x - width / 2, top: center.y - item / 2, width, height: item }}
      initial={{ y: 0, opacity: 0, scale: 0.7 }}
      animate={{ y: -d / 2, opacity: [0, 1, 1, 0], scale: [0.7, 1, 1, 1] }}
      transition={{ duration: 1 * s, ease: 'easeOut', times: [0, 0.15, 0.55, 1] }}
    >
      {changes.map((c) => {
        const def = TOKEN_BY_KEY[c.key];
        const gain = c.delta > 0;
        return (
          <div key={c.key} className="flex items-center justify-center" style={{ width: item, height: item, gap: d * 0.02 }}>
            <span
              className="flex shrink-0 items-center justify-center rounded-lg border-2 bg-zinc-950/85"
              style={{ width: icon, height: icon, borderColor: gain ? '#fde047' : '#71717a', boxShadow: `0 0 ${d * 0.15}px ${gain ? 'rgba(253,224,71,0.6)' : 'rgba(0,0,0,0.6)'}` }}
            >
              <TokenIcon tokenKey={c.key} className={`h-[78%] w-[78%] ${c.key === 'challenge' ? 'text-red-400' : (KIND_CLASS[def?.kind] ?? 'text-zinc-200')}`} />
            </span>
            <span
              className="font-display font-black leading-none"
              style={{
                fontSize: d * 0.4,
                letterSpacing: -d * 0.03,
                color: gain ? '#fde047' : '#f87171',
                WebkitTextStroke: `${Math.max(1, d * 0.025)}px black`,
                textShadow: '0 2px 4px rgba(0,0,0,0.9)',
              }}
            >
              {signOf(c.delta)}
            </span>
          </div>
        );
      })}
    </motion.div>
  );
}

// A number that rises and fades (damage, heal, absorbed).
function NumberRise({ center, d, s, text, color, delay = 0, dx = 0, size = 0.68 }) {
  return (
    <motion.div
      className="absolute flex items-center justify-center font-display font-black leading-none"
      style={{
        left: center.x - d / 2 + dx,
        top: center.y - d / 2,
        width: d,
        height: d,
        fontSize: d * size,
        color,
        WebkitTextStroke: `${Math.max(1, d * 0.03)}px black`,
        textShadow: '0 3px 6px rgba(0,0,0,0.9)',
      }}
      initial={{ y: 0, opacity: 0, scale: 0.6 }}
      animate={{ y: -d * 0.6, opacity: [0, 1, 1, 0], scale: [0.6, 1.15, 1, 1] }}
      transition={{ duration: Math.max(0.1, 0.8 * s - delay), delay, ease: 'easeOut', times: [0, 0.2, 0.6, 1] }}
    >
      {text}
    </motion.div>
  );
}

// Damage (decided): an impact on the token, then the red amount flies up and
// fades. What the Shield absorbed shows blue, with the shell flashing; a hit
// that did nothing shows "BLOCKED".
function DamagePop({ effect, center, d, s }) {
  const { amount = 0, absorbed = 0 } = effect.data ?? {};
  const hurt = amount > 0;
  const both = hurt && absorbed > 0;
  return (
    <>
      {hurt && (
        <>
          <motion.div
            className="absolute rounded-full"
            style={{ left: center.x - d / 2, top: center.y - d / 2, width: d, height: d, background: 'radial-gradient(circle, rgba(255,255,255,0.85) 0%, rgba(239,68,68,0.55) 45%, rgba(239,68,68,0) 70%)' }}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: [0, 1, 0], scale: [0.5, 1.1, 1.3], x: [0, -d * 0.05, d * 0.05, -d * 0.03, 0] }}
            transition={{ duration: 0.35 * s, ease: 'easeOut' }}
          />
          <motion.div
            className="absolute rounded-full border-white"
            style={{ left: center.x - d / 2, top: center.y - d / 2, width: d, height: d, borderWidth: Math.max(2, d * 0.05) }}
            initial={{ opacity: 0.9, scale: 0.8 }}
            animate={{ opacity: 0, scale: 1.6 }}
            transition={{ duration: 0.4 * s, ease: 'easeOut' }}
          />
        </>
      )}
      {absorbed > 0 && <ShieldHit center={center} d={d} s={s} />}
      {hurt && <NumberRise center={center} d={d} s={s} text={amount} color="#ef4444" delay={0.12 * s} dx={both ? d * 0.3 : 0} />}
      {absorbed > 0 && <NumberRise center={center} d={d} s={s} text={absorbed} color="#60a5fa" delay={0.05 * s} dx={both ? -d * 0.3 : 0} size={0.5} />}
      {!hurt && !absorbed && <NumberRise center={center} d={d} s={s} text="BLOCKED" color="#d4d4d8" size={0.3} />}
    </>
  );
}

// The Shield taking a hit: its shell flashes.
function ShieldHit({ center, d, s }) {
  const r = d / 2 + Math.max(4, d * 0.08);
  return (
    <motion.svg
      className="absolute overflow-visible"
      style={{ left: center.x, top: center.y, width: 1, height: 1 }}
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 1, 0] }}
      transition={{ duration: 0.5 * s, ease: 'easeOut' }}
    >
      <circle r={r} fill="rgba(96,165,250,0.25)" stroke="#93c5fd" strokeWidth={Math.max(2, d * 0.05)} />
      {[20, 140, 250].map((deg) => (
        <path key={deg} d={`M0 ${-r} l${r * 0.12} ${r * 0.22} l${-r * 0.1} ${r * 0.14}`} stroke="white" strokeWidth="1.5" fill="none" transform={`rotate(${deg})`} />
      ))}
    </motion.svg>
  );
}

// Gaining a Shield (decided): an energy shell closes over the whole token
// from below, pulses once to confirm, and fades quickly.
function ShieldShell({ center, d, s }) {
  const r = d / 2 + Math.max(4, d * 0.08);
  const id = `shield-${Math.round(center.x)}-${Math.round(center.y)}`;
  const t = 1.2 * s;
  return (
    <motion.svg
      className="absolute overflow-visible"
      style={{ left: center.x, top: center.y, width: 1, height: 1 }}
      initial={{ opacity: 1, scale: 1 }}
      animate={{ opacity: [1, 1, 1, 0], scale: [1, 1, 1.1, 1.02] }}
      transition={{ duration: t, times: [0, 0.68, 0.82, 1], ease: 'easeOut' }}
    >
      <defs>
        <radialGradient id={`${id}-g`}>
          <stop offset="55%" stopColor="rgba(96,165,250,0.12)" />
          <stop offset="88%" stopColor="rgba(96,165,250,0.45)" />
          <stop offset="100%" stopColor="rgba(191,219,254,0.9)" />
        </radialGradient>
        <clipPath id={`${id}-c`}>
          <motion.rect
            x={-r - 4}
            width={2 * r + 8}
            initial={{ y: r + 4, height: 0 }}
            animate={{ y: -r - 4, height: 2 * r + 8 }}
            transition={{ duration: t * 0.68, ease: 'easeInOut' }}
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-c)`}>
        <circle r={r} fill={`url(#${id}-g)`} stroke="#93c5fd" strokeWidth={Math.max(2, d * 0.05)} />
        {/* A faint hex lattice on the shell. */}
        {[-0.5, 0, 0.5].map((k) => (
          <ellipse key={k} rx={r * Math.sqrt(1 - k * k)} ry={r * 0.18} cy={k * r} fill="none" stroke="rgba(191,219,254,0.5)" strokeWidth="1" />
        ))}
        <ellipse rx={r * 0.25} ry={r} fill="none" stroke="rgba(191,219,254,0.4)" strokeWidth="1" />
      </g>
    </motion.svg>
  );
}

// A Challenge given (decided): the target lock plays ~500ms, then fades fast.
function ChallengeFlash({ from, to, d, s }) {
  return (
    <motion.div
      className="absolute left-0 top-0"
      initial={{ opacity: 1 }}
      animate={{ opacity: [1, 1, 0] }}
      transition={{ duration: 0.6 * s, times: [0, 0.83, 1] }}
    >
      <ChallengeLock from={from} to={to} radius={d / 2} />
    </motion.div>
  );
}
