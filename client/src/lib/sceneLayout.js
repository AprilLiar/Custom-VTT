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
export const SLOT_WIDTH = 220; // a picture's natural on-stage spacing unit, px
export const SLOT_GAP = 16; // natural gap between neighbors when there's room to spare
export const MIN_STEP_FACTOR = 0.35; // floor: a step never compresses past this fraction

// `stageWidth` is always the FULL measured canvas — a GM's own
// SceneCastDrawer/SceneListDrawer sit directly over its left/right edges,
// and a summon is allowed to render behind them (both drawers' own
// `bg-zinc-950/90` translucency already implied this was fine). An earlier
// version had the caller narrow `stageWidth` by a `DRAWER_WIDTH` and shift
// `x` to keep every summon clear of both drawers — removed: the cinematic,
// no-UI view is this page's own look benchmark, and that view has no
// drawers to avoid in the first place, so the layout underneath the
// interface should already match it edge to edge.

// left/right: arrays already ordered rank 0 = nearest that side's edge.
// Returns each entry plus { x, z }, plus the shared compression factor
// itself (worth exposing — Phase 6's motion pass and any future debugging
// both want to know how crammed the stage currently is).
//
// **`x` is a distance from the entry's OWN edge, not an absolute
// left-based coordinate** — 0 at rank 0, growing inward for higher ranks,
// identically for both sides. The caller applies it as CSS `left` for the
// left side and CSS `right` for the right side (see StageRoster.jsx). This
// used to be `stageWidth - SLOT_WIDTH` for the right side's rank 0 — an
// absolute `left` position that only actually landed flush against the
// true right edge when a character rendered at exactly `SLOT_WIDTH` wide.
// Once rendering stopped clipping every figure to that nominal width (see
// StageRoster.jsx's own comment), a right-side character wider than
// `SLOT_WIDTH` had its true right edge land PAST the screen's own right
// edge — not bleeding behind the drawer as intended, but off the canvas
// entirely, on any screen. Anchoring from the entry's own edge instead
// sidesteps the problem: the browser aligns flush to that edge regardless
// of how wide the image actually renders, so a right-side character can
// only ever grow further LEFT (into the drawer, still intended), never
// further right (off the actual screen).
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
  const place = (side) => side.map((entry, rank) => ({ ...entry, x: rank * step, z: side.length - rank }));
  return { left: place(left), right: place(right), factor };
}
