// **The board and movement (full automation, phase D — book pp.53-60).** One
// model for the Combat map and Simple Combat's lanes (a small grid: each lane
// a row of 10 spaces, the ends the arena's edge). Pure: the server builds it
// from the fight's squares and tiles and applies what these planners return.
//
// Squares are { col, row }. **The diamond grid (decided, revised):** there is
// no diagonal step — a diagonal is two lateral moves — so distance is the
// Manhattan distance (a diagonal counts 2) for movement and ranges alike, and
// "adjacent" means the four lateral neighbours. Weightless Style alone still
// steps diagonally, for 1 Speed (its text ignores the diagonal surcharge).
//
// board: { bounds: { colMin, colMax, rowMin, rowMax } | null (no edge known),
//          tiles: Map("c,r" → Set(kind)), unitAt: Map("c,r" → id) }
// Tiles: wall, rubble, pit, trap, fog. A space is Full when it holds a Wall
// or a unit (a Copy, later); Empty otherwise (Fog, Rubble, Pits and Traps
// leave it empty). Movement only ever enters empty spaces.

export const key = (sq) => `${sq.col},${sq.row}`;
// The squares a unit fills from its square: one, or a 2×2 block (the Giant).
export const cellsOf = (sq, size = 1) =>
  size === 2 ? [sq, { col: sq.col + 1, row: sq.row }, { col: sq.col, row: sq.row + 1 }, { col: sq.col + 1, row: sq.row + 1 }] : [sq];
// The closest pair of squares between two units (Range from a 2×2 Giant counts from its nearest square).
export function nearestCells(a, aSize, b, bSize) {
  let best = [a, b];
  let d = Infinity;
  for (const x of cellsOf(a, aSize)) for (const y of cellsOf(b, bSize)) {
    const n = Math.abs(x.col - y.col) + Math.abs(x.row - y.row);
    if (n < d) {
      d = n;
      best = [x, y];
    }
  }
  return best;
}
export const sameSquare = (a, b) => Boolean(a && b && a.col === b.col && a.row === b.row);
export const gridDistance = (a, b) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
const LATERAL = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAGONAL = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];
const around = (dirs) => (sq) => dirs.map(([dc, dr]) => ({ col: sq.col + dc, row: sq.row + dr }));
// The four lateral neighbours: every step of movement, and "adjacent".
export const neighbors = around(LATERAL);
// The corner-touching ones too (Weightless steps; a pull's spin).
export const diagonals = around(DIAGONAL);
export const allNeighbors = around([...LATERAL, ...DIAGONAL]);
export const isDiagonal = (a, b) => a.col !== b.col && a.row !== b.row;

// `exits`: where the Outside is — 'all' four edges (the map), or only the
// 'cols' ends (Simple Combat: a lane's ends are the arena's edge, decided).
export function makeBoard({ bounds = null, tiles = [], units = [], exits = 'all' } = {}) {
  const t = new Map();
  for (const x of tiles) {
    // (A Deadly Trap is a Trap that deals 3: `deadly` says so.)
    const kinds = x.kind === 'pit_trap' ? ['pit', 'trap'] : x.kind === 'deadly_trap' ? ['trap', 'deadly'] : [x.kind];
    const k = key(x);
    if (!t.has(k)) t.set(k, new Set());
    for (const kind of kinds) t.get(k).add(kind);
  }
  const unitAt = new Map();
  // The Giant fills a 2×2 block from its square (the QA pass).
  for (const u of units) if (u.square) for (const c of cellsOf(u.square, u.size)) unitAt.set(key(c), u.id);
  return { bounds, tiles: t, unitAt, exits };
}

export const inBounds = (b, sq) =>
  !b.bounds || (sq.col >= b.bounds.colMin && sq.col <= b.bounds.colMax && sq.row >= b.bounds.rowMin && sq.row <= b.bounds.rowMax);
export const onEdge = (b, sq) =>
  Boolean(b.bounds) &&
  (sq.col === b.bounds.colMin || sq.col === b.bounds.colMax || (b.exits !== 'cols' && (sq.row === b.bounds.rowMin || sq.row === b.bounds.rowMax)));
// Is a step off the board a way Outside (not off a lane's front or back)?
const exitStep = (b, n) => b.exits !== 'cols' || (n.row >= b.bounds.rowMin && n.row <= b.bounds.rowMax);
export const has = (b, sq, kind) => b.tiles.get(key(sq))?.has(kind) ?? false;
export const occupant = (b, sq) => b.unitAt.get(key(sq)) ?? null;
// Full: a Wall, or a unit other than those ignored (the mover itself).
// **A mover's own rules (the QA pass)** ride on the board it plans with
// (server/engine/moves.js boardFor):
//   b.blocked  Set("c,r") — spaces they may not enter (next to Shining Style)
//   b.open     every space is Empty to them (Weightless Style)
//   b.walls    'empty' (Parkour) | 'rubble' (Spirit Style) | 'smash' (the
//              Giant: the Wall becomes Rubble) — Walls they may enter
//   b.pitsLinked  standing on a Pit, every other Pit is adjacent (Vortex Style)
export const isFull = (b, sq, ignore = []) => {
  if (b.blocked?.has(key(sq))) return true;
  if (b.open) return false;
  if (has(b, sq, 'wall') && !b.walls) return true;
  return occupant(b, sq) != null && !ignore.includes(occupant(b, sq));
};
// A mover of size 2 (the Giant, `b.size`) needs its whole 2×2 block empty.
export const isEmpty = (b, sq, ignore = []) => cellsOf(sq, b.size).every((c) => inBounds(b, c) && !isFull(b, c, ignore));
// A Wall they enter as if it were Rubble (or by smashing it): it ends Action Movement.
const stopsAt = (b, sq) => has(b, sq, 'rubble') || has(b, sq, 'pit') || ((b.walls === 'rubble' || b.walls === 'smash') && has(b, sq, 'wall'));
// The spaces one step away — and, from a Pit, every other Pit (Vortex Style).
const pitsOf = (b) => [...b.tiles.entries()].filter(([, kinds]) => kinds.has('pit')).map(([k]) => ({ col: Number(k.split(',')[0]), row: Number(k.split(',')[1]) }));
const stepsFrom = (b, sq, around8 = false) => {
  const near = (around8 ? allNeighbors : neighbors)(sq);
  if (!b.pitsLinked || !has(b, sq, 'pit')) return near;
  return [...near, ...pitsOf(b).filter((p) => !sameSquare(p, sq) && !near.some((n) => sameSquare(n, p)))];
};

// ------------------------------------------------------------------ Free Movement (Speed)

// Every square a fighter can reach with Free Movement, at its cheapest Speed:
// 1 per lateral step (a diagonal is two of them, through a space that must be
// empty), +1 for each step out of a Pit. Never Outside, never through a full
// space. → Map("c,r" → { square, cost, path }) (`path` excludes the start).
// Rubble on the way gives Fatigue and Traps deal damage — the server applies
// them along the chosen path. `costPerSpace` (Weightless Style: every space
// costs 1, a diagonal step and Pits too).
const stepCost = (b, at, n, costPerSpace) => (costPerSpace != null ? costPerSpace : (b.pitsLinked && has(b, at, 'pit') && has(b, n, 'pit') ? 1 : isDiagonal(at, n) ? 2 : 1) + (has(b, at, 'pit') ? 1 : 0));
export function freeMoveReach(b, from, speed, selfId = null, { costPerSpace = null } = {}) {
  const best = new Map([[key(from), { square: from, cost: 0, path: [] }]]);
  const queue = [{ square: from, cost: 0, path: [] }];
  while (queue.length) {
    queue.sort((x, y) => x.cost - y.cost);
    const cur = queue.shift();
    if (best.get(key(cur.square))?.cost < cur.cost) continue;
    for (const n of stepsFrom(b, cur.square, costPerSpace != null)) {
      if (!isEmpty(b, n, [selfId])) continue;
      const cost = cur.cost + stepCost(b, cur.square, n, costPerSpace);
      if (cost > speed) continue;
      const k = key(n);
      if (best.has(k) && best.get(k).cost <= cost) continue;
      const next = { square: n, cost, path: [...cur.path, n] };
      best.set(k, next);
      queue.push(next);
    }
  }
  best.delete(key(from));
  return best;
}

// The Speed a path costs (for a path chosen elsewhere).
export function pathCost(b, from, path, { costPerSpace = null } = {}) {
  let cost = 0;
  let at = from;
  for (const sq of path) {
    cost += stepCost(b, at, sq, costPerSpace);
    at = sq;
  }
  return cost;
}

// ------------------------------------------------------------------ Action Movement

// "Move X" (exactly X — `upTo` false) or "up to X": every square the mover can
// end on, never repeating a space, stopping at once on Rubble or a Pit, never
// Outside. When X spaces aren't possible, the longest moves possible count.
// → [{ square, path }] (one path per destination: the first found).
export function actionMoveDestinations(b, from, distance, upTo = false, selfId = null) {
  const ends = new Map();
  const deadEnds = [];
  const add = (path) => {
    const k = key(path.at(-1));
    if (!ends.has(k) || ends.get(k).path.length > path.length) ends.set(k, { square: path.at(-1), path });
  };
  const walk = (at, path, seen) => {
    if (path.length && stopsAt(b, at)) return add(path);
    if (path.length >= distance) return add(path);
    if (upTo && path.length) add(path);
    let any = false;
    for (const n of stepsFrom(b, at)) {
      const k = key(n);
      if (seen.has(k) || !isEmpty(b, n, [selfId])) continue;
      any = true;
      seen.add(k);
      walk(n, [...path, n], seen);
      seen.delete(k);
    }
    if (!any && path.length) deadEnds.push(path);
  };
  if (distance > 0) walk(from, [], new Set([key(from)]));
  if (upTo || ends.size) return [...ends.values()];
  // X spaces aren't possible anywhere: the longest moves possible.
  const max = Math.max(0, ...deadEnds.map((p) => p.length));
  for (const p of deadEnds) if (p.length === max) add(p);
  return [...ends.values()];
}

// ------------------------------------------------------------------ Teleport and Swap

// "Teleport X": any empty space within Range 1-X (the diamond), ignoring
// what's between.
export function teleportDestinations(b, from, distance, selfId = null) {
  const out = [];
  if (!(distance > 0)) return out;
  for (let dc = -distance; dc <= distance; dc++) {
    for (let dr = -distance; dr <= distance; dr++) {
      if ((!dc && !dr) || Math.abs(dc) + Math.abs(dr) > distance) continue;
      const sq = { col: from.col + dc, row: from.row + dr };
      if (isEmpty(b, sq, [selfId])) out.push({ square: sq, path: [sq] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Forced Movement (push and pull)

// Every way a push (away from `origin`) or pull (toward it) of `distance` can
// go (book p.59, with World of Cardboard always on — decided):
//   - each lateral step is strictly farther from (push) or closer to (pull)
//     the origin than the last; a pull of someone adjacent spins them into any
//     space adjacent to both — on the diamond grid no space is laterally
//     adjacent to both, so (decided) it is the spaces adjacent to the puller
//     that touch the target's corner: one diagonal hop around them;
//   - only into empty spaces — except a Wall, which they smash into: it
//     becomes Rubble, they enter its space, and the movement ends;
//   - Rubble and Pits end it at once; Traps on the way are triggered;
//   - the Outside: only off an edge they started the push on; otherwise they
//     stop at the edge;
//   - when no space goes farther (other units in the way), it ends there.
// `upTo`: any shorter distance may be chosen too.
// → [{ square | null (Outside), path, ends: 'full' | 'rubble' | 'pit' | 'wall' | 'outside' | 'blocked' | 'chosen',
//      traps: [square], smashed: square | null }]
export function forcedMoves(b, target, origin, distance, { pull = false, upTo = false, targetId = null } = {}) {
  const out = [];
  if (!(distance > 0) || !target || !origin) return out;
  const startedOnEdge = onEdge(b, target);
  const d = (sq) => gridDistance(sq, origin);
  const done = (path, ends, extra = {}) =>
    out.push({ square: path.at(-1) ?? null, path, ends, traps: path.filter((sq) => has(b, sq, 'trap')), smashed: null, ...extra });
  const walk = (at, path) => {
    if (path.length === distance) return done(path, 'full');
    // A pull of someone adjacent spins them around the puller: any space
    // adjacent to both (book p.59); otherwise each step strictly farther
    // (push) or closer (pull).
    const steps =
      pull && d(at) === 1 ? diagonals(at).filter((n) => d(n) === 1) : neighbors(at).filter((n) => (pull ? d(n) < d(at) : d(n) > d(at)));
    let moved = false;
    for (const n of steps) {
      if (sameSquare(n, origin) || sameSquare(n, target) || path.some((p) => sameSquare(p, n))) continue;
      if (!inBounds(b, n)) {
        // Off the edge: only from the edge they started on (book p.53).
        if (path.length === 0 && startedOnEdge && exitStep(b, n)) {
          out.push({ square: null, path: [], ends: 'outside', traps: [], smashed: null, from: at });
          moved = true;
        }
        continue;
      }
      if (has(b, n, 'wall')) {
        // World of Cardboard (decided: always on): through the Wall, which becomes Rubble.
        if (occupant(b, n) != null) continue;
        done([...path, n], 'wall', { smashed: n });
        moved = true;
        continue;
      }
      if (!isEmpty(b, n, [targetId])) continue;
      moved = true;
      if (has(b, n, 'rubble')) done([...path, n], 'rubble');
      else if (has(b, n, 'pit')) done([...path, n], 'pit');
      else walk(n, [...path, n]);
    }
    if (upTo && path.length) done(path, 'chosen');
    else if (!moved && path.length) done(path, 'blocked');
  };
  walk(target, []);
  const seen = new Set();
  return out.filter((m) => {
    const k = `${m.square ? key(m.square) : 'out'}|${m.traps.map(key).join(';')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Landings, grouped: for each landing square, its routes. The pusher picks
// the square; only when its routes cross different Traps is a route asked
// (decided).
export function landingsOf(moves) {
  const by = new Map();
  for (const m of moves) {
    const k = m.square ? key(m.square) : 'outside';
    if (!by.has(k)) by.set(k, { square: m.square, ends: m.ends, routes: [] });
    by.get(k).routes.push(m);
  }
  return [...by.values()];
}

// ------------------------------------------------------------------ Save Yourself

// After the last space of Forced Movement: spend 1 Speed (2 out of a Pit) to
// move one space in any lateral direction; from the Outside, into a space adjacent to
// the edge space they went off from. → [square]
export function saveYourselfSquares(b, landing, { from = null, selfId = null } = {}) {
  const at = landing ?? from;
  if (!at) return [];
  return neighbors(at).filter((n) => isEmpty(b, n, [selfId])).concat(landing ? [] : isEmpty(b, from, [selfId]) ? [from] : []);
}
export const saveYourselfCost = (b, landing) => 1 + (landing && has(b, landing, 'pit') ? 1 : 0);
