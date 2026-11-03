// Map tiles (Panic at the Dojo, "Obstacles", p.70-72, plus the Battle
// Parameters' zones): special squares placed on the Combat map or a Simple
// Combat lane. Pure and shared — the server applies the stacking rules here,
// the client draws from the same list. No imports, so `server/` can load it.
//
// A square holds a SET of tile kinds. Obstacles follow the book's stacking
// rules (placeTile). Zones and the Important Thing are markers: they describe
// an area and share a square with anything (one of each kind per square).

export const TILES = [
  {
    key: 'fog',
    name: 'Fog',
    group: 'obstacle',
    color: '#cbd5e1',
    blurb:
      'Enemies in or next to Fog can only be targeted at Range 1 (adjacent). Allies in Fog can be targeted normally. Empty space; shares a space with any obstacle.',
  },
  {
    key: 'pit',
    name: 'Pit',
    group: 'obstacle',
    color: '#818cf8',
    blurb:
      'Inside a Pit you take 1 less damage from Range 3+, and Forced Movement against you is reduced by 1. Pushed or pulled in: the movement ends and you take 2 Fall damage (save for 2 Speed). Action Movement into it ends. Leaving costs 1 extra Speed.',
  },
  {
    key: 'pit_trap',
    name: 'Pit Trap',
    group: 'obstacle',
    color: '#e11d48',
    blurb:
      'A Pit and a Trap in one space: both apply. Pushing someone in deals the Trap’s damage and 2 Fall damage — dangerous, and easily abused with Forced Movement.',
  },
  {
    key: 'rubble',
    name: 'Rubble',
    group: 'obstacle',
    color: '#c2a27a',
    blurb:
      'Pushes and pulls that enter Rubble end there. Moving onto it gives 1 Fatigue (save for 1 Speed when pushed). Can be targeted as an enemy; 2+ damage in one hit destroys it. Placing Rubble clears the other obstacles in its space.',
  },
  {
    key: 'trap',
    name: 'Trap',
    group: 'obstacle',
    color: '#ef4444',
    blurb:
      'Entering a Trap deals 1 damage to everyone in its space. At the end of every turn, everyone standing on it takes 1 damage. Each Trap deals damage at most once per turn.',
  },
  {
    key: 'wall',
    name: 'Wall',
    group: 'obstacle',
    color: '#f97316',
    blurb:
      'No one can enter, pass through, see through or target enemies through a Wall. Can be targeted as an enemy; 2+ damage in one hit destroys it and leaves Rubble. Full space: shares only with Fog.',
  },
  {
    key: 'danger',
    name: 'Danger Zone',
    group: 'marker',
    color: '#facc15',
    blurb:
      'Traffic: usually safe to fight in, but anyone inside the Danger Zone at the end of each Round takes 6 damage. Armor and Iron tokens may reduce it.',
  },
  {
    key: 'king',
    name: 'King Zone',
    group: 'marker',
    color: '#f59e0b',
    blurb:
      'King of the Hill: no obstacles may be placed inside. At the end of each Round, if everyone inside (not at 0 HP) is from one Side, that Side wins.',
  },
  {
    key: 'control',
    name: 'Control Zone',
    group: 'marker',
    color: '#22c55e',
    blurb:
      'Secure the McGuffin: a Side’s 3×3 home corner; its units start within 2 spaces of it. Obstacles can never be placed inside. Bring the Important Thing here to win.',
  },
  {
    key: 'important',
    name: 'Important Thing',
    group: 'marker',
    color: '#38bdf8',
    blurb:
      'Secure the McGuffin: "Grab It!" (1+) picks it up from an adjacent space; it moves with you. Being moved by anyone else’s Action or Ability, or teleporting, drops it. Carry it into your Control Zone to win.',
  },
];
export const TILE_BY_KEY = Object.fromEntries(TILES.map((t) => [t.key, t]));

// The kinds actually stored. Pit Trap is shorthand for a Pit and a Trap in one
// square, so it is stored as both and only exists as a palette entry and a label.
export const STORED_KINDS = ['fog', 'pit', 'rubble', 'trap', 'wall', 'danger', 'king', 'control', 'important'];
export const OBSTACLES = new Set(['fog', 'pit', 'rubble', 'trap', 'wall']);
export const isPaletteKind = (k) => k in TILE_BY_KEY;

const ORDER = new Map(['fog', 'pit', 'pit_trap', 'rubble', 'trap', 'wall', 'danger', 'king', 'control', 'important'].map((k, i) => [k, i]));
const sorted = (set) => [...set].sort((a, b) => ORDER.get(a) - ORDER.get(b));
const markersOf = (kinds) => kinds.filter((k) => !OBSTACLES.has(k));

// Placing `kind` (a palette key) on a square that holds `kinds`. Returns the
// square's new kinds. The book's stacking rules (p.72):
//   - Fog, Pits and Traps share a space with one another.
//   - Rubble clears every other obstacle in its space; an obstacle placed on
//     Rubble replaces it.
//   - A Wall shares only with Fog (placing a Wall keeps the Fog and clears the
//     rest). Any other obstacle placed on a Wall destroys it into Rubble, and
//     that Rubble then destroys the new obstacle — the square becomes Rubble.
//   - Markers (zones, the Important Thing) share with anything.
export function placeTile(kinds, kind) {
  const have = new Set(kinds);
  if (kind === 'pit_trap') {
    // One placement: on a Wall the pair is destroyed by the Wall's Rubble
    // together, rather than the Trap then replacing that Rubble.
    if (have.has('wall')) return placeTile(kinds, 'pit');
    return placeTile(placeTile(kinds, 'pit'), 'trap');
  }
  if (!STORED_KINDS.includes(kind)) return sorted(have);
  if (!OBSTACLES.has(kind)) {
    have.add(kind);
    return sorted(have);
  }
  const markers = markersOf([...have]);
  if (kind === 'rubble') return sorted(new Set([...markers, 'rubble']));
  if (kind === 'wall') return sorted(new Set([...markers, ...(have.has('fog') ? ['fog'] : []), 'wall']));
  if (kind === 'fog') {
    // Fog on Rubble replaces it (an obstacle placed on Rubble replaces it);
    // Fog on a Wall is the one thing a Wall shares with.
    have.delete('rubble');
    have.add('fog');
    return sorted(have);
  }
  // A Pit or a Trap.
  if (have.has('wall')) return sorted(new Set([...markers, 'rubble']));
  have.delete('rubble');
  have.add(kind);
  return sorted(have);
}

// Taking `kind` (a palette key) off a square. Pit Trap removes both halves.
export function removeTile(kinds, kind) {
  const drop = kind === 'pit_trap' ? new Set(['pit', 'trap']) : new Set([kind]);
  return sorted(new Set(kinds.filter((k) => !drop.has(k))));
}

// Destroying an obstacle by damage: a Wall becomes Rubble (which, being
// placed, clears the square's other obstacles); Rubble is simply gone.
export const DESTRUCTIBLE = new Set(['wall', 'rubble']);
export function destroyTile(kinds, kind) {
  if (!kinds.includes(kind)) return sorted(new Set(kinds));
  if (kind === 'wall') return placeTile(removeTile(kinds, 'wall'), 'rubble');
  if (kind === 'rubble') return removeTile(kinds, 'rubble');
  return sorted(new Set(kinds));
}

// Moving a whole square's tiles onto another square: each kind is placed onto
// the target in turn (a Pit and a Trap travel together as a Pit Trap).
export function mergeInto(targetKinds, movingKinds) {
  let out = [...targetKinds];
  for (const k of displayKinds(movingKinds)) out = placeTile(out, k);
  return out;
}

// The kinds as shown and described: a Pit and a Trap together read as one
// Pit Trap.
export function displayKinds(kinds) {
  const list = sorted(new Set(kinds));
  if (list.includes('pit') && list.includes('trap')) {
    const rest = list.filter((k) => k !== 'pit' && k !== 'trap');
    const at = Math.min(list.indexOf('pit'), list.indexOf('trap'));
    rest.splice(at, 0, 'pit_trap');
    return rest;
  }
  return list;
}

// Squares as stored: [{ col, row, kind }] → Map("col,row" → kinds[]).
export const squareKey = (col, row) => `${col},${row}`;
export function groupSquares(tiles) {
  const out = new Map();
  for (const t of tiles ?? []) {
    const key = squareKey(t.col, t.row);
    if (!out.has(key)) out.set(key, { col: t.col, row: t.row, kinds: [] });
    out.get(key).kinds.push(t.kind);
  }
  for (const sq of out.values()) sq.kinds = sorted(new Set(sq.kinds));
  return out;
}
