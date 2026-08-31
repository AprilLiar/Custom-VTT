// Pure game math for the dice-pool system — no I/O, so it can be unit-tested
// in isolation (see server/test/gameLogic.test.js).

export const DIE_SIZES = [4, 6, 8, 10, 12];

// Ad-hoc roll modifiers are clamped to this range on the server.
export const MODIFIER_LIMIT = 20;

// The fixed 8-slot template every character gets at creation: 2 head + 4 core + 2 legs.
export const DICE_TEMPLATE = [
  { pool: 'head', slot_name: 'Skull' },
  { pool: 'head', slot_name: 'Brain' },
  { pool: 'core', slot_name: 'Left Hand' },
  { pool: 'core', slot_name: 'Stamina' },
  { pool: 'core', slot_name: 'Body' },
  { pool: 'core', slot_name: 'Right Hand' },
  { pool: 'legs', slot_name: 'Left Leg' },
  { pool: 'legs', slot_name: 'Right Leg' },
];

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

export function clampModifier(value) {
  const n = Math.trunc(Number(value) || 0);
  return clamp(n, -MODIFIER_LIMIT, MODIFIER_LIMIT);
}

export function rollDie(size) {
  return 1 + Math.floor(Math.random() * size);
}

// d4=0 .. d12=4, then +1 per bonus point — the same rank unit
// client/src/lib/dice.js's own rankOf uses for the current-vs-locked tint,
// and what an Injury's penalty (see applyRankPenalty below) is expressed in.
export function rankOf(size, bonus) {
  return DIE_SIZES.indexOf(size) + bonus;
}

// Injuries affecting base stats (decided): reverting a die to its locked
// baseline (character:revert_stats) subtracts however many ranks this
// character's active Injuries penalize that slot by, instead of restoring
// the raw locked value untouched — see the Injuries mechanic. An
// already-incapacitated baseline (or a zero penalty) is returned unchanged;
// a penalty that would push the rank below d4 incapacitates the die outright
// rather than going negative, the same floor stepping down manually past a
// bare d4 already hits.
// How many ranks each slot is penalized by, summed — more than one Injury can
// target the same Stat. Pure, and extracted rather than written twice: it was
// inline in character:revert_stats, and Perfect Player needs the identical
// figure to decide whether a fighter is standing on everything they should be
// (see server/perks/perfectPlayer.js). Two copies of "what is this fighter's
// real baseline" is exactly how the two quietly disagree.
export function injuryPenaltyBySlot(injuries) {
  const bySlot = new Map();
  for (const injury of injuries ?? []) {
    if (!injury?.slot_name || !injury.penalty) continue;
    bySlot.set(injury.slot_name, (bySlot.get(injury.slot_name) ?? 0) + injury.penalty);
  }
  return bySlot;
}

export function applyRankPenalty({ size, bonus, status }, penalty) {
  if (status === 'incapacitated' || !penalty) return { size, bonus, status };
  const rank = rankOf(size, bonus) - penalty;
  if (rank < 0) return { size: 4, bonus: 0, status: 'incapacitated' };
  return { ...dieAtRank(rank), status: 'active' };
}

// The inverse of rankOf: rank 0 is a bare d4, rank 4 a d12, and every rank past
// that is another +1 on a d12. Extracted from applyRankPenalty above rather
// than written twice — Character Creation buys Stats in exactly these units
// (one point, one rank), and two implementations of the same ladder is how the
// two quietly disagree about what a d12+2 costs.
//
// A negative rank floors at a bare d4; the caller decides whether that is an
// error or an incapacitation.
export function dieAtRank(rank) {
  const r = Math.max(0, Math.trunc(Number(rank) || 0));
  const index = Math.min(r, DIE_SIZES.length - 1);
  return { size: DIE_SIZES[index], bonus: Math.max(0, r - (DIE_SIZES.length - 1)) };
}

export function computeMaxStamina(multiplier, lockedSize, lockedBonus) {
  return multiplier * (lockedSize + lockedBonus);
}

// Stepping rules:
//   up:   incapacitated revives to a fresh d4; below d12 advances a size;
//         at d12 the permanent bonus stacks instead (d12 -> d12+1 -> ...).
//   down: bonus unwinds first; then size drops; a d4 with no bonus becomes
//         incapacitated; an incapacitated die can't step further down.
export function stepDie({ current_size, bonus, status }, direction) {
  if (direction === 'up') {
    if (status === 'incapacitated') return { current_size: 4, bonus: 0, status: 'active' };
    if (current_size < 12) {
      return {
        current_size: DIE_SIZES[DIE_SIZES.indexOf(current_size) + 1],
        bonus,
        status,
      };
    }
    return { current_size: 12, bonus: bonus + 1, status };
  }
  if (direction === 'down') {
    if (status === 'incapacitated') return { current_size, bonus, status };
    if (bonus > 0) return { current_size, bonus: bonus - 1, status };
    if (current_size > 4) {
      return {
        current_size: DIE_SIZES[DIE_SIZES.indexOf(current_size) - 1],
        bonus,
        status,
      };
    }
    return { current_size: 4, bonus: 0, status: 'incapacitated' };
  }
  return { current_size, bonus, status };
}

// Half-Damage (decided): a half-step towards losing a die's size. Manually
// clicking the toggle (die:toggle_half_damage) is a raw on/off flip and
// never calls this — this is only for a future automated effect (see the
// Combat Automation plan) applying half-damage in code. If the flag is
// already set, applying it again instead clears the flag AND steps the die
// down one full rank (reusing stepDie's own bonus-then-size unwind, same
// floor into 'incapacitated' at a bare d4); if the flag isn't set, applying
// it just sets it, with no other change.
export function applyHalfDamage({ current_size, bonus, status, half_damage }) {
  if (half_damage) {
    return { ...stepDie({ current_size, bonus, status }, 'down'), half_damage: false };
  }
  return { current_size, bonus, status, half_damage: true };
}

// The exact inverse of the line above: **one half-step back UP**.
//
// Written as its own function rather than reusing `stepStat`'s upward branch,
// which is not an inverse — from a die with no pending half it steps a whole
// rank and leaves the flag clear, so applying and then undoing would hand back
// more than was taken. The Temporary Damage Tag heals exactly what it dealt, at
// 0.5 a Round, so it needs the real mirror:
//
//   (d8, half)  --apply-->  (d6, no half)  --heal-->  (d8, half)
//   (d4, half)  --apply-->  (d4, out)      --heal-->  (d4, active, half)
//
// It can walk a die back out of `incapacitated`, which is the whole point: a
// Stat destroyed by temporary damage comes back, because the damage that
// destroyed it was never permanent.
export function healHalfDamage({ current_size, bonus, status, half_damage }) {
  if (half_damage) {
    return { current_size, bonus, status, half_damage: false };
  }
  return { ...stepDie({ current_size, bonus, status }, 'up'), half_damage: true };
}

// **A modifier modifies the ROLL, not each die** (decided, fix). Every
// modifier in the game — the ad-hoc one typed into a roll dialog, Reasons to
// Fight, the Stance matchup, a move's own Roll Modifier, a Perk's per-move
// bonus — used to be added to each die separately, so a move rolling three
// Stats at +3 collected +9. That is not what any of those numbers mean, and
// it made a wide Roll worth far more than its dice.
//
// Each die's own `result` is therefore its face plus **its own** flat bonus
// (the one it earned by stepping past d12, which really does belong to that
// die), and the shared modifier lands once, here, on the sum.
//
// This is also the shape every roll payload now carries: `dice[].result`
// never includes the shared modifier, and `total` always does. The client's
// decomposeRoll relies on exactly that split to recover a die's face.
export function rollTotal(dice, modifier = 0) {
  const sum = (dice ?? []).reduce((acc, d) => acc + (d?.result ?? 0), 0);
  return sum + (Number.isFinite(modifier) ? modifier : 0);
}
