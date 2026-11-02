// Turn order for a Panic at the Dojo fight — the system's one real algorithm.
//
// **The GM's own design, chosen over the book's.** The book's Initiative Meter
// (p.61) alternates side slots and lets anyone on that side fill one. This
// table wants a named, randomised order instead:
//
//   - every HP bar is one turn per round;
//   - after the opener, ally and enemy turns alternate one for one for as long
//     as both sides still have turns, then the bigger side's leftovers follow;
//   - wherever there is a choice, nobody gets two turns in a row;
//   - each new round is re-rolled, opened by the side opposite the one that
//     took the previous round's last turn.
//
// Pure and shared: no imports, so the server can run it too. `rng` is
// injectable so tests are deterministic. Shuffling is not a dice roll and is
// never posted to chat.

export const SIDES = ['allies', 'enemies'];
export const otherSide = (side) => (side === 'allies' ? 'enemies' : 'allies');

// `allies` / `enemies`: [{ id, turns }]. `id` must be unique across both sides
// (the caller's fighter key). `turns` is how many turns that fighter takes
// this round — its unbroken HP bars. A fighter with 0 turns is simply absent.
//
// `firstSide` opens the round; `openerId` (optional) names the exact fighter
// who takes the first turn — round 1's GM pick. When it is missing, or not a
// fighter on `firstSide` with a turn to spend, the opener is chosen like any
// other slot.
//
// Returns [{ side, id }], one entry per turn.
export function buildRound({ allies = [], enemies = [], firstSide = 'allies', openerId = null, rng = Math.random }) {
  const remaining = { allies: new Map(), enemies: new Map() };
  for (const [side, list] of [['allies', allies], ['enemies', enemies]]) {
    for (const f of list) {
      const turns = Math.max(0, Math.trunc(Number(f.turns) || 0));
      if (turns > 0) remaining[side].set(f.id, (remaining[side].get(f.id) ?? 0) + turns);
    }
  }
  const left = (side) => [...remaining[side].values()].reduce((a, b) => a + b, 0);
  const take = (side, id) => {
    const n = remaining[side].get(id) - 1;
    if (n > 0) remaining[side].set(id, n);
    else remaining[side].delete(id);
  };

  const order = [];
  const lastBySide = { allies: null, enemies: null };

  // Choose who fills a slot on `side`:
  //  1. never whoever took the slot immediately before, if anyone else can;
  //  2. preferably not whoever took this side's previous slot either, so a
  //     side's turns spread across its fighters;
  //  3. among those left, someone with the MOST turns still to take — the
  //     greedy rule that keeps a lopsided tail (a 3-bar boss after the heroes
  //     have gone) from being forced into back-to-back turns;
  //  4. random among ties.
  const pick = (side) => {
    let candidates = [...remaining[side].keys()];
    const prev = order.length ? order[order.length - 1].id : null;
    const narrowed = (list, exclude) => {
      const rest = list.filter((id) => id !== exclude);
      return rest.length ? rest : list;
    };
    candidates = narrowed(candidates, prev);
    candidates = narrowed(candidates, lastBySide[side]);
    const most = Math.max(...candidates.map((id) => remaining[side].get(id)));
    const top = candidates.filter((id) => remaining[side].get(id) === most);
    return top[Math.min(top.length - 1, Math.floor(rng() * top.length))];
  };

  const place = (side, id) => {
    take(side, id);
    order.push({ side, id });
    lastBySide[side] = id;
  };

  let side = SIDES.includes(firstSide) ? firstSide : 'allies';
  if (!left(side)) side = otherSide(side);
  if (!left(side)) return order;

  if (openerId != null && remaining[side].has(openerId)) place(side, openerId);
  else place(side, pick(side));

  while (left('allies') + left('enemies') > 0) {
    const next = otherSide(order[order.length - 1].side);
    // Alternate while both sides have turns; afterwards, whoever is left.
    side = left(next) ? next : otherSide(next);
    if (!left(side)) side = next;
    place(side, pick(side));
  }
  return order;
}

// Which side opens the round after `order`: the opposite of whoever took its
// last turn. An empty round leaves the choice where it was.
export function nextFirstSide(order, fallback = 'allies') {
  return order.length ? otherSide(order[order.length - 1].side) : fallback;
}
