// Simple Combat's lane: ten spaces in a row, in perspective, at 5/7 of the
// stage's height (Panic at the Dojo, Phase 2 — see vttprojectplan.md).
//
// Pure and shared: the server uses `packLane` to give every summon its space,
// and the client uses the geometry to draw the lane and to find which space a
// drag is over. No imports, so `server/` can load this file directly.

export const LANE_SLOTS = 10;
// Stored for a summon that was put in the tray on purpose — unlike NULL
// ("never placed"), it is not packed back onto the lane by itself.
export const TRAY = -1;

// Who stands where. `summons` is every summon on the Scene, in summon order
// (oldest first); `lane_slot` is the space a summon was explicitly put in, or
// null. Explicit spaces are kept (first come, first served if two somehow
// claim one); everyone else fills the free spaces from the left, in summon
// order. When the lane is full the rest get null — they wait in the tray, as
// does anyone stored as TRAY.
//
// Returns Map(summonId → slot | null). Hidden summons count like anyone else:
// a space a hidden fighter stands in is taken, even if a Player sees it empty.
export function packLane(summons) {
  const result = new Map();
  const taken = new Set();
  for (const s of summons) {
    const slot = s.lane_slot;
    if (Number.isInteger(slot) && slot >= 0 && slot < LANE_SLOTS && !taken.has(slot)) {
      taken.add(slot);
      result.set(s.id, slot);
    }
  }
  let next = 0;
  for (const s of summons) {
    if (s.lane_slot === TRAY) result.set(s.id, null);
  }
  for (const s of summons) {
    if (result.has(s.id)) continue;
    while (next < LANE_SLOTS && taken.has(next)) next++;
    if (next < LANE_SLOTS) {
      taken.add(next);
      result.set(s.id, next);
    } else {
      result.set(s.id, null);
    }
  }
  return result;
}

// Moving a summon to `slot` (or to the tray, `null`), given the current
// packing. Returns the new explicit slot of every summon on the Scene, so the
// whole lane is saved at once and nobody shifts under anyone else. If the
// target space is occupied, its occupant swaps into the mover's old place.
export function moveOnLane(packed, summonId, slot) {
  const next = new Map(packed);
  if (!next.has(summonId)) return next;
  const from = next.get(summonId);
  const target = slot == null ? null : slot;
  if (target != null) {
    for (const [id, s] of next) {
      if (id !== summonId && s === target) next.set(id, from);
    }
  }
  next.set(summonId, target);
  return next;
}

// ---------------------------------------------------------------- geometry

// The lane's outline in stage pixels, matching the sketch: a long, shallow
// trapezoid whose top edge is ~83% of its bottom edge, so the end segments
// lean outwards like a strip of floor seen at an angle.
//
// `inset` keeps it clear of anything docked at the stage's sides — the GM's
// two drawers — by fitting the lane into the space between them. Positions
// are spaces, not pixels, so a GM and a Player drawing the lane at different
// widths still agree on who stands where.
export function laneGeometry(stageWidth, stageHeight, inset = { left: 0, right: 0 }) {
  const left = Math.max(0, inset.left || 0);
  const usable = Math.max(120, stageWidth - left - Math.max(0, inset.right || 0));
  const middle = left + usable / 2;
  const bottomWidth = Math.min(usable * (left || inset.right ? 0.94 : 0.84), stageHeight * 2.4);
  const topWidth = bottomWidth * 0.83;
  const height = Math.max(28, bottomWidth * 0.062);
  const centerY = (stageHeight * 5) / 7;
  const topY = centerY - height / 2;
  const bottomY = centerY + height / 2;
  const topLeft = middle - topWidth / 2;
  const bottomLeft = middle - bottomWidth / 2;
  const segments = [];
  for (let i = 0; i < LANE_SLOTS; i++) {
    const tl = [topLeft + (topWidth * i) / LANE_SLOTS, topY];
    const tr = [topLeft + (topWidth * (i + 1)) / LANE_SLOTS, topY];
    const br = [bottomLeft + (bottomWidth * (i + 1)) / LANE_SLOTS, bottomY];
    const bl = [bottomLeft + (bottomWidth * i) / LANE_SLOTS, bottomY];
    segments.push({
      index: i,
      points: [tl, tr, br, bl],
      center: { x: (tl[0] + tr[0] + br[0] + bl[0]) / 4, y: centerY },
      width: (topWidth + bottomWidth) / 2 / LANE_SLOTS,
    });
  }
  return {
    segments,
    topY,
    bottomY,
    centerY,
    height,
    outline: [
      [topLeft, topY],
      [topLeft + topWidth, topY],
      [bottomLeft + bottomWidth, bottomY],
      [bottomLeft, bottomY],
    ],
  };
}

// Which space a point is over, judged along the lane's centre line: the
// segment whose left and right edges (at the lane's middle height) contain
// `x`. Off either end snaps to the nearest end space, so a drag never has
// nowhere to land.
export function slotAtX(geometry, x) {
  const { segments } = geometry;
  if (!segments.length) return null;
  const edgeAt = (seg, side) => {
    const [tl, tr, br, bl] = seg.points;
    return side === 'left' ? (tl[0] + bl[0]) / 2 : (tr[0] + br[0]) / 2;
  };
  if (x <= edgeAt(segments[0], 'right')) return 0;
  for (const seg of segments) {
    if (x >= edgeAt(seg, 'left') && x < edgeAt(seg, 'right')) return seg.index;
  }
  return segments.length - 1;
}

export const pointsAttr = (points) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
