import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { socket } from '../socket.js';
import { formatTimestampDate } from '../lib/timestampFormat.js';

// The Timestamp tool's "play" beat (Scene tab, GM-exclusive tool — see
// SceneTimestampDialog.jsx for the management side). Always mounted, like
// StageRoster/SceneDrawingLayer, regardless of `uiHidden` — this is
// narrative content, not a UI control, the same reasoning that already
// keeps summoned figures visible through cinematic mode.
//
// Listens for `stage:timestamp_played` (server/index.js), which every
// connected socket receives regardless of role — a Player sees exactly the
// same card a GM does, just never gets to browse the rest of the list that
// produced it (db.js's own comment on why managing vs. playing are two
// different trust levels for the same table).
//
// **One continuous keyframe run, not AnimatePresence's separate enter/
// exit.** `duration` is a per-viewer Settings value (sceneSettings.js),
// only meaningful at play time, so a single `animate` timeline covering
// fade-in, hold, and fade-out is simpler than splitting it across mount/
// unmount. `key={play.seq}` forces a fresh mount — and therefore restarts
// the animation from t=0 — even if the SAME Timestamp is played again
// before the last run finished, the same trick RoundCutscene.jsx's own
// ImpactBurst uses for back-to-back hits.
//
// `pointer-events-none` on the whole overlay (deliberate): the dim is
// purely visual. Nothing under it — the hide-interface toggle included —
// is ever actually blocked from a click while a card plays.
export default function TimestampCutscene({ duration }) {
  const reduceMotion = useReducedMotion();
  const [play, setPlay] = useState(null); // { seq, date, subtext } | null

  useEffect(() => {
    const onPlayed = ({ date, subtext }) => setPlay({ seq: Date.now(), date, subtext });
    socket.on('stage:timestamp_played', onPlayed);
    return () => socket.off('stage:timestamp_played', onPlayed);
  }, []);

  if (!play) return null;

  const d = Math.max(0.4, duration);
  // Reduced motion keeps the information (the card shown for the full
  // configured duration) and drops the theatrics: no animated dim/fade
  // ramp, straight to fully shown and straight back off — same "keep the
  // information, drop the motion" split RoundCutscene's own ImpactBurst
  // uses for reduced motion.
  const opacityKeyframes = reduceMotion ? [1, 1] : [0, 1, 1, 0];
  const times = reduceMotion ? [0, 1] : [0, 0.2, 0.8, 1];

  return (
    <motion.div
      key={play.seq}
      className="pointer-events-none fixed inset-0 z-[5000] flex items-center justify-center"
      animate={{ opacity: opacityKeyframes }}
      transition={{ duration: d, times, ease: 'easeInOut' }}
      onAnimationComplete={() => setPlay(null)}
    >
      <div className="absolute inset-0 bg-black" style={{ opacity: 0.9 }} />
      <div className="relative max-w-[90vw] px-4 text-center">
        {/* No `uppercase` here (decided, revised) — a free-text flavor date
            ("DAY 47") read fine shouted in caps; an actual calendar date
            ("May 12, 2015") is meant to be read exactly as typed, and
            `uppercase` would render it "MAY 12, 2015" regardless. */}
        <p className="font-display break-words text-5xl font-bold text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)] md:text-7xl">
          {formatTimestampDate(play.date)}
        </p>
        {play.subtext && (
          <p className="mt-3 break-words text-lg text-zinc-200 drop-shadow-[0_2px_8px_rgba(0,0,0,0.8)] md:text-2xl">
            {play.subtext}
          </p>
        )}
      </div>
    </motion.div>
  );
}
