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
export function applyRankPenalty({ size, bonus, status }, penalty) {
  if (status === 'incapacitated' || !penalty) return { size, bonus, status };
  const rank = rankOf(size, bonus) - penalty;
  if (rank < 0) return { size: 4, bonus: 0, status: 'incapacitated' };
  const index = Math.min(rank, DIE_SIZES.length - 1);
  return { size: DIE_SIZES[index], bonus: Math.max(0, rank - (DIE_SIZES.length - 1)), status: 'active' };
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
