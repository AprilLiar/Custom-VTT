// **Map borders (decided, new).** Lines the GM draws on the Combat map along
// the edges between squares, one edge at a time:
//   red     — no movement of any kind crosses it, except a Teleport (and a
//             Swap, which is two teleports);
//   purple  — nothing crosses it: no movement, and no Teleport or Swap whose
//             every route within its distance would have to cross one.
// Each border also says whether it **blocks range** (default yes; drawn solid,
// a dashed line when it doesn't): no Action, Ability or Range reaches across
// it, for allies and enemies alike — a straight line between the two squares'
// centres that crosses it is blocked (running through a corner is fine,
// unless the borders meeting there close the way).
//
// An edge is named by the square it starts: `v:c,r` is the left edge of
// square (c, r) — between (c-1, r) and (c, r); `h:c,r` its top edge —
// between (c, r-1) and (c, r). Pure: shared by the server's engine and the
// client's drawing.

export const BORDER_COLORS = ['red', 'purple'];
export const BORDER_SIDES = ['v', 'h'];
export const borderKey = (side, col, row) => `${side}:${col},${row}`;

// The edge between two laterally adjacent squares (null otherwise).
export function edgeBetween(a, n) {
  if (!a || !n) return null;
  if (n.row === a.row && n.col === a.col + 1) return borderKey('v', n.col, a.row);
  if (n.row === a.row && n.col === a.col - 1) return borderKey('v', a.col, a.row);
  if (n.col === a.col && n.row === a.row + 1) return borderKey('h', a.col, n.row);
  if (n.col === a.col && n.row === a.row - 1) return borderKey('h', a.col, a.row);
  return null;
}

// [{ side, col, row, color, blocksRange }] → Map(key → { color, blocksRange }).
export function edgeMap(borders = []) {
  const m = new Map();
  for (const x of borders ?? []) {
    if (!BORDER_SIDES.includes(x.side) || !BORDER_COLORS.includes(x.color)) continue;
    m.set(borderKey(x.side, x.col, x.row), { color: x.color, blocksRange: x.blocksRange !== false && x.blocks_range !== 0 });
  }
  return m;
}

// Does a border stand between two lateral neighbours, for walking (`teleport`
// false: red or purple) or for a teleport's route (purple only)?
const edgeStops = (edges, a, n, teleport) => {
  const e = edges.get(edgeBetween(a, n));
  return Boolean(e) && (!teleport || e.color === 'purple');
};

// A step from `a` to `n` (lateral, or a corner-to-corner diagonal) is walled
// off when its edge holds a border — a diagonal when both of its two-step
// routes around the corner do.
export function stepWalled(edges, a, n, { teleport = false } = {}) {
  if (!edges?.size || !a || !n) return false;
  const dc = n.col - a.col;
  const dr = n.row - a.row;
  if (Math.abs(dc) + Math.abs(dr) === 1) return edgeStops(edges, a, n, teleport);
  if (Math.abs(dc) === 1 && Math.abs(dr) === 1) {
    const viaCol = { col: n.col, row: a.row };
    const viaRow = { col: a.col, row: n.row };
    const blocked = (via) => edgeStops(edges, a, via, teleport) || edgeStops(edges, via, n, teleport);
    return blocked(viaCol) && blocked(viaRow);
  }
  // (Farther jumps — Vortex Style's linked Pits — cross no edge.)
  return false;
}

// A 2×2 mover (the Giant) steps as a block: walled when any of its squares is.
export function blockStepWalled(edges, at, n, size = 1, opts = {}) {
  if (!edges?.size) return false;
  if (size !== 2) return stepWalled(edges, at, n, opts);
  const dc = n.col - at.col;
  const dr = n.row - at.row;
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const c = { col: at.col + x, row: at.row + y };
    if (stepWalled(edges, c, { col: c.col + dc, row: c.row + dr }, opts)) return true;
  }
  return false;
}

const hasPurple = (edges) => [...(edges?.values() ?? [])].some((e) => e.color === 'purple');

// **Teleports and purple borders (decided: no route, no teleport).** The
// fewest lateral steps from `from` to `to` that cross no purple border,
// searched only up to `max` steps (whatever stands in the squares — a
// Teleport ignores what is between). → steps | null (no route within `max`).
export function teleportSteps(edges, from, to, max) {
  if (!from || !to) return null;
  const straight = Math.abs(from.col - to.col) + Math.abs(from.row - to.row);
  if (straight > max) return null;
  if (!hasPurple(edges)) return straight;
  const reach = teleportReach(edges, from, max);
  return reach.get(`${to.col},${to.row}`) ?? null;
}

// Every square a Teleport of `max` can reach from `from` (purple borders
// walled off): Map("c,r" → steps). Without purple borders: the diamond.
export function teleportReach(edges, from, max) {
  const out = new Map([[`${from.col},${from.row}`, 0]]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift();
    const d = out.get(`${at.col},${at.row}`);
    if (d >= max) continue;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { col: at.col + dc, row: at.row + dr };
      const k = `${n.col},${n.row}`;
      if (out.has(k) || stepWalled(edges, at, n, { teleport: true })) continue;
      out.set(k, d + 1);
      queue.push(n);
    }
  }
  return out;
}

const EPS = 1e-9;
const isInt = (x) => Math.abs(x - Math.round(x)) < EPS;

// **Range across borders:** does the straight line between two squares'
// centres cross a border that blocks range? Through a corner it passes only
// when the borders meeting there don't close it off (both sides of the
// corner's cross, or the two edges hugging the start or end quadrant).
export function rangeBlocked(edges, a, b) {
  if (!edges?.size || !a || !b) return false;
  const blocks = (k) => edges.get(k)?.blocksRange === true;
  if (![...edges.values()].some((e) => e.blocksRange)) return false;
  const ax = a.col + 0.5;
  const ay = a.row + 0.5;
  const dx = b.col - a.col;
  const dy = b.row - a.row;
  // At a grid corner (x, y): the four edges that meet there.
  const cornerShut = (x, y) => {
    const up = blocks(borderKey('v', x, y - 1));
    const down = blocks(borderKey('v', x, y));
    const left = blocks(borderKey('h', x - 1, y));
    const right = blocks(borderKey('h', x, y));
    if ((up && down) || (left && right)) return true;
    // Moving down-right or up-left: the up+right / down+left pair hugs the
    // squares the line skirts, so only up+left and down+right close it —
    // and the mirror for the other diagonal.
    const sameSign = Math.sign(dx) === Math.sign(dy);
    return sameSign ? (up && left) || (down && right) : (up && right) || (down && left);
  };
  // Vertical grid lines crossed (x = integer between the centres).
  if (dx) {
    const step = Math.sign(dx);
    for (let x = step > 0 ? a.col + 1 : a.col; step > 0 ? x <= b.col : x > b.col; x += step) {
      const y = ay + ((x - ax) / dx) * dy;
      if (isInt(y)) {
        if (cornerShut(x, Math.round(y))) return true;
        continue;
      }
      if (blocks(borderKey('v', x, Math.floor(y)))) return true;
    }
  }
  if (dy) {
    const step = Math.sign(dy);
    for (let y = step > 0 ? a.row + 1 : a.row; step > 0 ? y <= b.row : y > b.row; y += step) {
      const x = ax + ((y - ay) / dy) * dx;
      // (A corner was already judged with the vertical lines.)
      if (isInt(x)) continue;
      if (blocks(borderKey('h', Math.floor(x), y))) return true;
    }
  }
  return false;
}
