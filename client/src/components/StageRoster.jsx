import { useMemo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { layoutStage } from '../lib/sceneLayout.js';

// The stage itself (Scene tab plan, Phase 5: hard-cut positioning; Phase 6:
// the entrance/exit motion). `summons` already arrives sorted `id DESC`
// from the server (see getStagePayload in server/index.js), which is
// exactly rank-0-first order `layoutStage` wants: the newest summon on
// each side binds to that side's own screen edge, older ones get pushed —
// this file only filters by side and hands the two arrays straight
// through.
//
// **Two elements per figure, because two things want `transform`** — the
// exact conflict RelationshipNode.jsx already hit and documented. The
// outer plain `div` owns POSITION: `left` is a bare number straight off
// `layoutStage`, recomputed on every render as the roster reflows, and it
// stays a plain CSS property rather than anything framer-motion touches.
// The inner `motion.div` owns the ENTRANCE/EXIT slide — if that lived on
// the SAME element as the position, framer-motion's own `animate` would
// compose `transform` itself and overwrite the position's `left`-driven
// layout on every reflow, snapping every figure back to its slide-in
// origin each time somebody else summoned or un-summoned (the exact bug
// RelationshipNode.jsx's own comment describes). Split like this, a
// reposition (a plain re-render with a new `left`) never touches the
// motion.div at all — `initial` only plays once, on that figure's own
// mount, keyed by `entry.id`, which never changes across a reflow.
//
// Bottom-anchored, **height-only** sizing — `h-screen` (the whole scene's
// own height, the cinematic-no-UI look this page is designed around) with
// width left to `auto`, rather than fitting into a fixed SLOT_WIDTH box.
// This is the second attempt at lining up every character's own top edge:
// the first tried a fixed-size BOX (`h-[85vh] w-full object-fit: contain`)
// on the theory that most standing-figure art is taller than the box's own
// narrow aspect ratio and would therefore be height-bound — wrong in
// practice, since plenty of real art is closer to a portrait crop than a
// full-body sprite, which `object-fit: contain` then fits by WIDTH inside
// that box, leaving empty space above and a shorter-looking character.
// Constraining only height sidesteps the whole question: every image is
// scaled to the exact same height, full stop, with whatever width its own
// aspect ratio produces — there is no second dimension left for
// `object-fit` to negotiate, so every character's top is the SAME line by
// construction, not by hoping their aspect ratios cooperate. This is a
// pure rendering rule with no stored-per-picture state, so it applies
// retroactively to every already-uploaded Scene Picture with no migration.
//
// **The width this produces is not `layoutStage`'s SLOT_WIDTH** — that
// constant is still exactly right for the horizontal SPACING/crowding math
// (see that file's own comment: image aspect ratio was always deliberately
// not its problem), but a character now routinely renders wider than it on
// screen. That is intended, not a bug to square away: the whole point of
// this pass is to stop treating the stage's own width as "the middle
// strip between the drawers" and let artwork use the full canvas edge to
// edge, bleeding behind the GM's drawers on the sides exactly as their own
// `bg-zinc-950/90` translucency already implied it might. `layoutStage`
// still receives the FULL measured stage width — see ScenePage, which no
// longer narrows it or applies any offset.

// Named variants, RoundCutscene.jsx's own vocabulary style: a plain object
// of framer-motion keyframes/targets per name, rather than a switch full
// of inline objects. Only two directions for the entrance — the side a
// summon is bound to (decision #3: a Player's own summons always enter
// from the left, a GM's always from the right) is exactly the direction
// its portrait slides in from, so the slide reads as the character
// stepping onto the stage from that edge. One EXIT for both sides —
// un-summoning reads as the picture simply leaving, not as a reversed
// entrance, so it doesn't need its own side split.
const ENTER_LEFT = { x: -140, opacity: 0 };
const ENTER_RIGHT = { x: 140, opacity: 0 };
const IDLE = { x: 0, opacity: 1 };
const EXIT = { opacity: 0, scale: 0.85 };

export default function StageRoster({ summons, stageWidth }) {
  const reduceMotion = useReducedMotion();

  const placed = useMemo(() => {
    const left = summons.filter((s) => s.side === 'left');
    const right = summons.filter((s) => s.side === 'right');
    const result = layoutStage({ left, right, stageWidth });
    return [...result.left, ...result.right];
  }, [summons, stageWidth]);

  return (
    // A stacking context of its own (position + a low, fixed z-index): a
    // crowded roster's own z values (1..N per side, from layoutStage's
    // rank) only ever compete with EACH OTHER inside this box, never leak
    // out to outrank the drawers' z-10/z-20 — without this wrapper, a side
    // with more than ~10 summons would start painting over the GM's own
    // controls.
    <div className="absolute inset-0 z-[1]">
      <AnimatePresence>
        {placed.map((entry) => (
          <div
            key={entry.id}
            // No `width` here any more — `entry.x` (layoutStage's own
            // nominal-SLOT_WIDTH spacing) still anchors where a figure's
            // LEFT edge sits, but how far its own art actually reaches
            // right of that is now up to the image's own aspect ratio at
            // a fixed height, not a column this div would otherwise clip
            // it to.
            className="absolute bottom-0"
            style={{ left: entry.x, zIndex: entry.z }}
          >
            <motion.div
              initial={entry.side === 'left' ? ENTER_LEFT : ENTER_RIGHT}
              animate={IDLE}
              exit={EXIT}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 28 }}
            >
              <img
                src={`data:${entry.image_mime_type || 'image/png'};base64,${entry.image_data}`}
                alt={entry.name ?? ''}
                // `max-w-none` overrides Tailwind's own preflight reset
                // (`img { max-width: 100% }`, meant for ordinary inline
                // images) — without it, a wide/short character's own
                // render silently clamps back down to whatever "100%" of
                // its auto-sized ancestor chain resolves to, defeating the
                // whole height-only sizing rule above for exactly the
                // aspect ratios it exists to fix.
                className="block h-screen w-auto max-w-none"
              />
            </motion.div>
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
