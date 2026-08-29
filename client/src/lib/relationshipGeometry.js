// Where a relationship line starts, where it ends, and how it bends.
//
// Pure, and separated from the components for the same reason `boardViewport.js`
// is: this is the arithmetic that decides whether two lines between the same
// pair of people sit on top of each other, and that is invisible in a
// screenshot with one line and obvious with three.
//
// Everything here is in **world coordinates** — the space nodes are stored in.
// The camera never enters these functions.

// The node's own footprint. The four connection dots sit on the midpoints of
// the portrait's edges, so these are the only two numbers the geometry needs.
// Kept here rather than imported from the component so the maths can be tested
// without a DOM, and re-exported by RelationshipNode so there is one source.
export const NODE_W = 112;
export const NODE_H = 112;

export const SIDES = ['top', 'right', 'bottom', 'left'];

// How far a dot protrudes from the portrait's edge. Small on purpose: the dots
// are a grab handle, not decoration, and a big one covers the face.
export const DOT_OUT = 5;

// Where a given side's dot is, for a node at (x, y).
export function anchorPoint(node, side) {
  const cx = node.x + NODE_W / 2;
  const cy = node.y + NODE_H / 2;
  switch (side) {
    case 'top':
      return { x: cx, y: node.y - DOT_OUT };
    case 'bottom':
      return { x: cx, y: node.y + NODE_H + DOT_OUT };
    case 'left':
      return { x: node.x - DOT_OUT, y: cy };
    case 'right':
    default:
      return { x: node.x + NODE_W + DOT_OUT, y: cy };
  }
}

// The centre of a node — where a loose end is dropped when its node is deleted,
// and what the "which side should this attach to" test measures against.
export const nodeCenter = (node) => ({ x: node.x + NODE_W / 2, y: node.y + NODE_H / 2 });

// Is this world point inside the node's portrait? Hit-testing is arithmetic
// rather than `document.elementFromPoint` on purpose: it is exact at any zoom,
// it does not fight pointer capture, and it does not care that the element it
// would have hit is covered by the line being dragged.
export function hitNode(node, point) {
  return (
    point.x >= node.x && point.x <= node.x + NODE_W && point.y >= node.y && point.y <= node.y + NODE_H
  );
}

// **The drop region is bigger than the portrait.** The four dots protrude
// beyond the picture's edge, so a connector released exactly ON a dot — the
// most natural aim there is — lands outside `hitNode` and connects to nothing.
// Reported from play as "dragging to the anchor point does not work; you have
// to drag to the picture".
//
// The pad covers the dot's own offset plus a comfortable grab radius around it,
// so the whole visible target and a little air around it all accept the drop.
// Kept in step with the dot's hit box in RelationshipNode (DOT_OUT + half of
// DOT_HIT ≈ 21): a dot you can light up by hovering is a dot you should be able
// to drop on, and a smaller pad here would light one up and then refuse it.
export const DROP_PAD = 22;

export function hitNodeArea(node, point, pad = DROP_PAD) {
  return (
    point.x >= node.x - pad &&
    point.x <= node.x + NODE_W + pad &&
    point.y >= node.y - pad &&
    point.y <= node.y + NODE_H + pad
  );
}

// The node a connector released here should attach to. With a pad this wide,
// two nodes sitting close together can both accept the same point, so the
// nearest centre wins rather than whichever happens to come first in the list.
export function dropTarget(nodes, point, { exceptId = null, pad = DROP_PAD } = {}) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    if (exceptId != null && node.id === exceptId) continue;
    if (!hitNodeArea(node, point, pad)) continue;
    const c = nodeCenter(node);
    const distance = Math.hypot(point.x - c.x, point.y - c.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

// Which of the four dots a point is nearest — what a connector drag snaps to
// when it lands on a node. Measured from the node's centre by direction rather
// than by distance to each dot, so the four sides divide the node into equal
// quadrants and there is no dead zone in the middle.
export function nearestSide(node, point) {
  const c = nodeCenter(node);
  const dx = point.x - c.x;
  const dy = point.y - c.y;
  // Normalised against the node's own proportions, so a non-square node would
  // still split evenly. Square today; this costs nothing and removes a trap.
  const nx = dx / (NODE_W / 2);
  const ny = dy / (NODE_H / 2);
  if (Math.abs(nx) > Math.abs(ny)) return nx > 0 ? 'right' : 'left';
  return ny > 0 ? 'bottom' : 'top';
}

// ---------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------
//
// **A bend is two numbers, not one, and they live in the chord's own frame.**
//
//     C = from + u·(to − from) + v·n          n = the chord's left normal
//
// `u` slides the control point ALONG the line (0 at one end, 1 at the other,
// 0.5 the middle) and `v` pushes it ACROSS. Two degrees of freedom is what
// makes a bend omni-directional and what lets it form where you grabbed rather
// than always at the middle — with `u` pinned at 0.5, which is all the first
// version had, every arc peaked in the centre however near an end you pulled.
//
// The frame is the whole reason this is a pair of fractions and not a point:
// `C` itself would be a fixed place in the world and the arc would flatten the
// moment either portrait moved. `u` and `v` are measured against the line's own
// two ends, so the curve travels with them.
//
// `{ u: 0.5, v: 0 }` is a straight line, and `v` alone is exactly what the old
// single-number bend meant — which is why the stored column keeps its name and
// a NULL `bend_u` reads as 0.5.

export const BEND_SPACING = 30;

// The fan's slot for the i-th of n lines between one pair, as a `v`. Symmetric
// about zero so a pair with two lines gets one bowing each way rather than one
// straight and one bent.
export function bendOffsets(count, spacing = BEND_SPACING) {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);
}

export const STRAIGHT = { u: 0.5, v: 0 };

// A bend as stored on a row. `bend` is `v` (the column predates `u`), `bend_u`
// is `u`. Either missing or unusable falls back to the straight default rather
// than drawing nothing.
// **`null` has to be caught before `Number()` gets its hands on it.** A NULL
// column arrives as `null`, and `Number(null)` is a perfectly finite `0`. On
// `bend` that would read every un-bent line in the world as "hand-bent, dead
// straight" and switch the automatic fan off for the whole board; on `bend_u`
// it would jam every arc stored before that column existed hard against one
// end. Both are silent, and both are one coercion away.
const column = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

export function bendOf(edge) {
  const v = column(edge?.bend);
  if (!Number.isFinite(v)) return null;
  const u = column(edge?.bend_u);
  return { u: Number.isFinite(u) ? u : 0.5, v };
}

// The chord's unit direction and left normal — the frame everything here is
// expressed in. A zero-length chord (two portraits dropped on top of each
// other) answers a valid frame rather than dividing by zero.
export function chordFrame(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { len, ux: dx / len, uy: dy / len, nx: -dy / len, ny: dx / len };
}

// (u, v) -> the control point in world space.
export function controlPoint(from, to, bend = STRAIGHT) {
  const { len, ux, uy, nx, ny } = chordFrame(from, to);
  const u = Number.isFinite(bend?.u) ? bend.u : 0.5;
  const v = Number.isFinite(bend?.v) ? bend.v : 0;
  return {
    x: from.x + ux * len * u + nx * v,
    y: from.y + uy * len * u + ny * v,
  };
}

// The reverse: a control point in world space -> (u, v) in the chord's frame.
export function bendFromControl(from, to, c) {
  const { len, ux, uy, nx, ny } = chordFrame(from, to);
  const dx = c.x - from.x;
  const dy = c.y - from.y;
  return { u: (dx * ux + dy * uy) / len, v: dx * nx + dy * ny };
}

// An SVG path plus the point a label should sit at.
//
// The label goes at the curve's own midpoint (t = 0.5 on the quadratic), not at
// the midpoint of the straight line between the ends — on a bent line those are
// different places, and the second one leaves the label floating off the wire.
export function edgePath(from, to, bend = STRAIGHT) {
  const c = controlPoint(from, to, bend);
  return {
    d: `M ${from.x} ${from.y} Q ${c.x} ${c.y} ${to.x} ${to.y}`,
    // Quadratic at t=0.5 is (P0 + 2C + P2) / 4.
    mid: { x: (from.x + 2 * c.x + to.x) / 4, y: (from.y + 2 * c.y + to.y) / 4 },
    c,
  };
}

// Which fan an edge belongs to. **Unordered**, so A→B and B→A are the same pair
// and share one fan — two lines between the same two people must not overlap
// regardless of which way round they were drawn.
//
// An edge with a loose end belongs to no fan: it is anchored to a point in
// space, so there is nothing for it to collide with systematically.
export function pairKey(edge) {
  if (edge.from_node_id == null || edge.to_node_id == null) return null;
  const a = Number(edge.from_node_id);
  const b = Number(edge.to_node_id);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// **Whose frame is an offset measured in?** The normal is taken from the edge's
// OWN direction, so an edge stored B→A has both its direction and its fan
// offset negated relative to one stored A→B — and the two negations cancel,
// producing an identical control point and an identical curve.
//
// That was the bug: connect A to B, then B to A, and the two lines landed
// exactly on top of each other while the fan believed it had separated them.
// The old unit test asserted the offsets were symmetric and summed to zero.
// Both were true, of a pair of curves that overlapped perfectly — which is why
// it passed. Assert the rendered paths differ, not the numbers behind them.
//
// The fix: lay every fan out in ONE frame — the pair's canonical direction, from
// the lower node id to the higher — and flip the offset handed to a backwards
// edge so that its own negated direction restores it.
const runsBackwards = (edge) => Number(edge.from_node_id) > Number(edge.to_node_id);

// Assigns every edge its bend in one pass: group by pair, then hand out
// symmetric offsets in stable id order so a line does not jump to a different
// bend when an unrelated edge is added. The fan only ever moves a line ACROSS
// its chord, so every automatic bend has `u = 0.5`.
export function assignBends(edges) {
  const byPair = new Map();
  for (const edge of edges) {
    const key = pairKey(edge);
    if (!key) continue;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(edge);
  }
  const out = new Map();
  for (const group of byPair.values()) {
    group.sort((a, b) => a.id - b.id);
    const offsets = bendOffsets(group.length);
    group.forEach((edge, i) =>
      out.set(edge.id, { u: 0.5, v: runsBackwards(edge) ? -offsets[i] : offsets[i] })
    );
  }
  // A hand-bent line keeps exactly the arc it was given. It is already in its
  // own frame — the drag that produced it measured there — so it needs no
  // canonical correction, and it is not part of any fan.
  //
  // Applied over the fan rather than instead of it, so bending one line of a
  // pair leaves its neighbours in the slots they already occupy. Dropping a
  // hand-bent line out of the count would re-fan the others, and a line you
  // never touched would slide sideways because you moved a different one.
  for (const edge of edges) {
    const hand = bendOf(edge);
    if (hand) out.set(edge.id, hand);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bending a line by hand
// ---------------------------------------------------------------------------
//
// Grab a line anywhere and pull: the point under your finger follows, in
// whatever direction you drag it, and the arc forms THERE rather than in the
// middle.
//
// The maths is one identity. A quadratic is
//
//     B(t) = (1−t)²·P0 + 2t(1−t)·C + t²·P2
//
// so the only term the control point touches is `2t(1−t)·C`. Move `C` by Δ and
// the curve at parameter t moves by `2t(1−t)·Δ`. Turn that around: to make the
// point you grabbed follow the pointer exactly, move `C` by the pointer's own
// delta divided by that weight. Both components at once, which is what makes
// the gesture omni-directional — the first version projected the drag onto the
// chord's normal and threw the along-chord half away.

// Where along the chord a point sits: 0 at `from`, 1 at `to`. The pointer is
// projected onto the chord rather than solved against the curve — for the
// gentle arcs this produces the two agree closely, and a root-find per frame to
// place a grab handle is arithmetic nobody can see.
export function chordParam(from, to, point) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lenSq = dx * dx + dy * dy;
  if (!(lenSq > 0)) return 0.5;
  const t = ((point.x - from.x) * dx + (point.y - from.y) * dy) / lenSq;
  return Math.max(0, Math.min(1, t));
}

// How much of a control-point move is felt at parameter t. **Floored**, because
// the ends of a quadratic do not move at all however hard its control point is
// pulled: without a floor, grabbing within a few pixels of an anchor divides by
// nearly zero and throws the line off the board on the first frame.
const MIN_BEND_WEIGHT = 0.25; // t roughly within [0.15, 0.85]
export const bendWeight = (t) => Math.max(MIN_BEND_WEIGHT, 2 * t * (1 - t));

// The bend that results from dragging the point grabbed at chord parameter `t`
// by (dx, dy) in world space, starting from `base`.
//
// **A delta, not an absolute.** Reading the control point straight off the
// pointer is exact in the middle of a line and wrong near its ends, where the
// weight's floor stops dividing honestly — grabbing an already-bent line close
// to an anchor would snap it most of the way flat on the first frame. Adding
// only the CHANGE since the grab makes that first frame a no-op by
// construction, wherever you grabbed.
export function bendFromDrag(from, to, base, t, dx, dy) {
  const w = bendWeight(t);
  const c = controlPoint(from, to, base);
  return clampBend(bendFromControl(from, to, { x: c.x + dx / w, y: c.y + dy / w }));
}

// Close enough to straight that the player meant straight. Without it a line
// dragged back to true keeps a two-pixel kink forever, and no amount of care
// with the mouse gets rid of it. Only `v` is snapped: `u` is where along the
// line the arc sits, and on a straight line it makes no difference at all.
export const BEND_SNAP = 6;
export const snapBend = (bend) =>
  Math.abs(bend.v) < BEND_SNAP ? { u: 0.5, v: 0 } : bend;

// A hand bend is bounded for the same reason a node coordinate is: the plane is
// infinite, a number is not, and one NaN here takes the whole line with it.
// `u` is bounded too, and more tightly — a control point a chord-length past
// either end is already a hairpin, and beyond that the curve stops being a line
// between two people at all.
export const BEND_LIMIT = 4000;
export const BEND_U_LIMIT = 2;
export function clampBend(bend) {
  const u = Number(bend?.u);
  const v = Number(bend?.v);
  return {
    u: Number.isFinite(u) ? Math.max(-BEND_U_LIMIT, Math.min(BEND_U_LIMIT, u)) : 0.5,
    v: Number.isFinite(v) ? Math.max(-BEND_LIMIT, Math.min(BEND_LIMIT, v)) : 0,
  };
}

// The payload the editor and the drag send. Flat, because the columns are flat,
// and rounded because six decimal places is already sub-pixel on any line
// anybody will draw.
const round = (n) => Math.round(n * 1e6) / 1e6;
export const bendFields = (bend) =>
  bend == null ? { bend: null, bendU: null } : { bend: round(bend.v), bendU: round(bend.u) };

// ---------------------------------------------------------------------------
// Where an edge's two ends actually are
// ---------------------------------------------------------------------------

// A null answer means the edge references a node that is gone and has no stored
// fallback — it is not drawable, and the caller drops it rather than drawing a
// line to the origin.
export function edgeEnds(edge, nodesById) {
  const end = (nodeId, side, fx, fy) => {
    if (nodeId != null) {
      const node = nodesById.get(nodeId);
      return node ? anchorPoint(node, side) : null;
    }
    return Number.isFinite(fx) && Number.isFinite(fy) ? { x: fx, y: fy } : null;
  };
  const from = end(edge.from_node_id, edge.from_side, edge.from_x, edge.from_y);
  const to = end(edge.to_node_id, edge.to_side, edge.to_x, edge.to_y);
  return from && to ? { from, to } : null;
}
