import { useMemo } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { layoutStage, SLOT_WIDTH } from '../lib/sceneLayout.js';

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
// Bottom-anchored, `object-fit: contain` inside a fixed SLOT_WIDTH-wide,
// `h-[85vh]`-tall box — image aspect ratio is deliberately not
// `layoutStage`'s problem (see that file's own comment), so the framing
// happens here instead. **Height is a fixed `h-`, not a `max-h` cap**: a
// `max-h` alone leaves an image's rendered height driven by its own PNG's
// own aspect ratio (auto, only ever clamped for an unusually tall one) —
// bottoms lined up via `object-bottom`, but two characters uploaded at
// different aspect ratios still had their heads land at different screen
// heights. A fixed height turns that auto sizing into a real box every
// image is scaled into via `object-fit: contain`, so any normal
// standing-figure art (taller than the box's own aspect ratio, the
// overwhelmingly common case) is height-bound and its top lands flush with
// every other character's — width-bound art (unusually wide/short) still
// centers with a gap above, which is the honest CSS limit short of a real
// per-picture crop tool.
//
// `offsetX` shifts every figure right by that many px after layout —
// ScenePage already narrowed `stageWidth` itself to the visible gap
// between a GM's own drawers (see DRAWER_WIDTH), so `layoutStage` lays
// out entirely within that narrower space starting at 0; this is just
// what re-anchors 0 to where the gap actually starts on screen.

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

export default function StageRoster({ summons, stageWidth, offsetX = 0 }) {
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
            className="absolute bottom-0"
            style={{ left: entry.x + offsetX, width: SLOT_WIDTH, zIndex: entry.z }}
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
                className="block h-[85vh] w-full object-contain object-bottom"
              />
            </motion.div>
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
