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
export const DROP_PAD = 18;

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

// **Any pair may be connected any number of times**, so the lines have to fan
// out or they draw exactly on top of each other and read as one.
//
// `offset` is a perpendicular displacement of the quadratic's control point.
// Zero is a straight line; the fan below hands out symmetric offsets so a pair
// with two lines gets one bowing each way rather than one straight and one bent.
export const BEND_SPACING = 30;

export function bendOffsets(count, spacing = BEND_SPACING) {
  if (count <= 0) return [];
  return Array.from({ length: count }, (_, i) => (i - (count - 1) / 2) * spacing);
}

// The control point for a curve from `from` to `to`, pushed `offset` to the
// left of the direction of travel.
function controlPoint(from, to, offset) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x: (from.x + to.x) / 2 - uy * offset,
    y: (from.y + to.y) / 2 + ux * offset,
  };
}

// An SVG path plus the point a label should sit at.
//
// The label goes at the curve's own midpoint (t = 0.5 on the quadratic), not at
// the midpoint of the straight line between the ends — on a bent line those are
// different places, and the second one leaves the label floating off the wire.
export function edgePath(from, to, offset = 0) {
  const c = controlPoint(from, to, offset);
  return {
    d: `M ${from.x} ${from.y} Q ${c.x} ${c.y} ${to.x} ${to.y}`,
    // Quadratic at t=0.5 is (P0 + 2C + P2) / 4.
    mid: { x: (from.x + 2 * c.x + to.x) / 4, y: (from.y + 2 * c.y + to.y) / 4 },
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

// Assigns every edge its bend offset in one pass: group by pair, then hand out
// symmetric offsets in stable id order so a line does not jump to a different
// bend when an unrelated edge is added.
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
    group.forEach((edge, i) => out.set(edge.id, offsets[i]));
  }
  return out;
}

// Where an edge's two ends actually are, given the nodes currently on the
// board. A null answer means the edge references a node that is gone and has no
// stored fallback — it is not drawable, and the caller drops it rather than
// drawing a line to the origin.
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
