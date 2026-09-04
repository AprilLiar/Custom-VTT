// The stage's cramming/overlap layout (Scene tab plan, Phase 5) — pure
// maths, no DOM, so the placement rule can be unit-tested the way
// combat's own placement/reveal timing is (CLAUDE.md's standing rule for
// exactly this kind of thing): built and pinned before any UI touches it.
//
// **Ordering, resolved from the original spec's own wording**: "binding to
// the leftmost edge... pushed to the right to fit the newly added ones" —
// the newest summon binds to the edge; older ones get pushed. So within a
// side, rank 0 (flush against that side's own screen edge) is the most
// recently summoned member. The caller is responsible for pre-sorting each
// side `scene_summons.id DESC` before calling this — this file only lays
// out whatever order it's handed.
export const SLOT_WIDTH = 220; // a picture's natural on-stage width, px
export const SLOT_GAP = 16; // natural gap between neighbors when there's room to spare
export const MIN_STEP_FACTOR = 0.35; // floor: a step never compresses past this fraction

// A GM's own SceneCastDrawer/SceneListDrawer (`w-64` in both) sit directly
// over the left/right edges of the canvas — the same edges decision #3
// wants a GM's own summons entering from. Without accounting for that, a
// small right-side roster renders entirely underneath SceneListDrawer,
// invisible and unclickable behind it. The caller (ScenePage) is
// responsible for subtracting this from the measured canvas width and
// offsetting `x` by it for a GM — this constant only documents the number
// both sides need to agree on, since Tailwind's `w-64` isn't otherwise
// reachable from JS.
export const DRAWER_WIDTH = 256;

// left/right: arrays already ordered rank 0 = nearest that side's edge.
// Returns each entry plus { x, z }, plus the shared compression factor
// itself (worth exposing — Phase 6's motion pass and any future debugging
// both want to know how crammed the stage currently is).
export function layoutStage({ left, right, stageWidth }) {
  const n = left.length + right.length;
  const naturalStep = SLOT_WIDTH + SLOT_GAP;
  const naturalTotal = n > 0 ? n * SLOT_WIDTH + (n - 1) * SLOT_GAP : 0;
  // "equally, amongst the whole roster" — ONE shared factor, applied
  // identically to every character on stage, both sides combined, never a
  // per-character or per-side adjustment.
  const factor =
    n <= 1 || naturalTotal <= stageWidth
      ? 1
      : Math.max(MIN_STEP_FACTOR, (stageWidth - SLOT_WIDTH) / ((n - 1) * naturalStep));
  const step = naturalStep * factor;
  const place = (side, edgeX, sign) =>
    side.map((entry, rank) => ({ ...entry, x: edgeX + sign * rank * step, z: side.length - rank }));
  return { left: place(left, 0, 1), right: place(right, stageWidth - SLOT_WIDTH, -1), factor };
}
