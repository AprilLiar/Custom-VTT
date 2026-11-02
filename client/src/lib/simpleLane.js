// Simple Combat's lanes: rows of ten spaces in perspective, centred at 5/7 of
// the stage's height (Panic at the Dojo, Phase 2 — see vttprojectplan.md).
// One lane by default; the GM can set up to three (a table-wide setting), and
// each count has its own hand-tuned look (LANE_PRESETS).
//
// Pure and shared: the server uses `packLane` to give every summon its space,
// and the client uses the geometry to draw the lane and to find which space a
// drag is over. No imports, so `server/` can load this file directly.

// Spaces per lane.
export const LANE_SLOTS = 10;
export const MAX_LANES = 3;
export const clampLanes = (n) => Math.min(MAX_LANES, Math.max(1, Math.trunc(Number(n)) || 1));
// Every space on the board: lane L, column C is space L * 10 + C. Lane 0 is
// the FRONT lane (nearest the viewer), and packing fills it first.
export const laneCapacity = (lanes) => clampLanes(lanes) * LANE_SLOTS;
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
export function packLane(summons, lanes = 1) {
  const capacity = laneCapacity(lanes);
  const result = new Map();
  const taken = new Set();
  for (const s of summons) {
    const slot = s.lane_slot;
    // A space beyond the current lane count (the GM turned lanes down) counts
    // as unset, so that fighter is packed back onto the lanes that remain.
    if (Number.isInteger(slot) && slot >= 0 && slot < capacity && !taken.has(slot)) {
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
    while (next < capacity && taken.has(next)) next++;
    if (next < capacity) {
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

// **One look per lane count (decided).** Keeping the one-lane tilt and simply
// stacking more rows makes a steep wedge that dominates the scene, so two and
// three lanes each get their own proportions: a slightly wider back edge (a
// flatter tilt), a total depth that grows less than linearly, and rows that
// get thinner towards the back, so the board still reads as floor seen at an
// angle.
//   backRatio — the back edge's width as a share of the front edge's
//   depth     — the whole board's height as a share of the front edge's width
//   rows      — relative thickness of each lane, front to back
//   width     — the front edge, as a share of the usual width
export const LANE_PRESETS = {
  1: { backRatio: 0.83, depth: 0.062, rows: [1], width: 1 },
  2: { backRatio: 0.8, depth: 0.105, rows: [1, 0.86], width: 0.97 },
  3: { backRatio: 0.77, depth: 0.14, rows: [1, 0.87, 0.76], width: 0.94 },
};

// The board's outline and every space, in stage pixels.
//
// `inset` keeps it clear of anything docked at the stage's sides — the GM's
// two drawers — by fitting it into the space between them. Positions are
// spaces, not pixels, so a GM and a Player drawing it at different widths
// still agree on who stands where.
export function laneGeometry(stageWidth, stageHeight, inset = { left: 0, right: 0 }, lanes = 1) {
  const count = clampLanes(lanes);
  const preset = LANE_PRESETS[count];
  const left = Math.max(0, inset.left || 0);
  const usable = Math.max(120, stageWidth - left - Math.max(0, inset.right || 0));
  const middle = left + usable / 2;
  const bottomWidth = Math.min(usable * (left || inset.right ? 0.94 : 0.84), stageHeight * 2.4) * preset.width;
  const topWidth = bottomWidth * preset.backRatio;
  const height = Math.max(28 * count, bottomWidth * preset.depth);
  const centerY = (stageHeight * 5) / 7;
  const topY = centerY - height / 2;
  const bottomY = centerY + height / 2;
  // The board's edges are straight lines, so its width at any height is a
  // straight interpolation between the front and back edges.
  const widthAt = (y) => bottomWidth + ((topWidth - bottomWidth) * (bottomY - y)) / height;
  const leftAt = (y) => middle - widthAt(y) / 2;
  // Row boundaries, front (bottom) to back (top).
  const total = preset.rows.reduce((a, b) => a + b, 0);
  const bounds = [bottomY];
  for (const weight of preset.rows) bounds.push(bounds[bounds.length - 1] - (height * weight) / total);
  const frontWidth = (widthAt(bounds[0]) + widthAt(bounds[1])) / 2 / LANE_SLOTS;
  const segments = [];
  const rows = [];
  for (let lane = 0; lane < count; lane++) {
    const yb = bounds[lane];
    const yt = bounds[lane + 1];
    const yc = (yb + yt) / 2;
    rows.push({ lane, bottomY: yb, topY: yt, centerY: yc });
    for (let col = 0; col < LANE_SLOTS; col++) {
      const at = (y, i) => [leftAt(y) + (widthAt(y) * i) / LANE_SLOTS, y];
      const tl = at(yt, col);
      const tr = at(yt, col + 1);
      const br = at(yb, col + 1);
      const bl = at(yb, col);
      const width = widthAt(yc) / LANE_SLOTS;
      segments.push({
        index: lane * LANE_SLOTS + col,
        lane,
        col,
        points: [tl, tr, br, bl],
        center: { x: leftAt(yc) + (widthAt(yc) * (col + 0.5)) / LANE_SLOTS, y: yc },
        width,
        // Miniatures further back are drawn smaller, by how much narrower
        // their space is than a front-lane space.
        scale: width / frontWidth,
      });
    }
  }
  return {
    lanes: count,
    segments,
    rows,
    topY,
    bottomY,
    centerY,
    height,
    leftAt,
    widthAt,
    outline: [
      [leftAt(topY), topY],
      [leftAt(topY) + topWidth, topY],
      [leftAt(bottomY) + bottomWidth, bottomY],
      [leftAt(bottomY), bottomY],
    ],
  };
}

// Which space a point is over: the lane whose band contains `y` (above the
// board → the back lane, below it → the front lane), then the column at that
// lane's middle height. Off either end snaps to the end column, so a drag
// always has somewhere to land.
export function slotAt(geometry, x, y) {
  const { rows, leftAt, widthAt } = geometry;
  if (!rows?.length) return null;
  let row = rows[0];
  if (y < rows[rows.length - 1].topY) row = rows[rows.length - 1];
  else for (const r of rows) if (y <= r.bottomY && y >= r.topY) row = r;
  const w = widthAt(row.centerY);
  const col = Math.min(LANE_SLOTS - 1, Math.max(0, Math.floor(((x - leftAt(row.centerY)) / w) * LANE_SLOTS)));
  return row.lane * LANE_SLOTS + col;
}

// One-lane shorthand, judged along the lane's centre line.
export const slotAtX = (geometry, x) => slotAt(geometry, x, geometry.rows[0].centerY);

// The board's line work as an SVG path: the outline, the lines between lanes,
// and the column dividers (straight from the back edge to the front edge).
export function laneLinesPath(geometry) {
  const f = (n) => n.toFixed(1);
  const { outline, rows, leftAt, widthAt, topY, bottomY } = geometry;
  const parts = [`M ${outline.map(([x, y]) => `${f(x)},${f(y)}`).join(' L ')} Z`];
  for (let i = 1; i < rows.length; i++) {
    const y = rows[i].bottomY;
    parts.push(`M ${f(leftAt(y))},${f(y)} L ${f(leftAt(y) + widthAt(y))},${f(y)}`);
  }
  for (let c = 1; c < LANE_SLOTS; c++) {
    const xt = leftAt(topY) + (widthAt(topY) * c) / LANE_SLOTS;
    const xb = leftAt(bottomY) + (widthAt(bottomY) * c) / LANE_SLOTS;
    parts.push(`M ${f(xt)},${f(topY)} L ${f(xb)},${f(bottomY)}`);
  }
  return parts.join(' ');
}

export const pointsAttr = (points) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
