// A Stance's dice pool (Panic at the Dojo — decided after scoping): 1 to 8
// slots, each a die from d4 to d12 or a fixed number from 0 to 12 standing in
// for a die. Pure and shared (no imports), so the server validates and rolls
// with exactly the rules the editor shows.
//
// A slot is `{ die: 4|6|8|10|12 }` or `{ fixed: 0..12 }`.

export const STANCE_DIE_SIZES = [4, 6, 8, 10, 12];
export const STANCE_SLOTS_MIN = 1;
export const STANCE_SLOTS_MAX = 8;
export const FIXED_MIN = 0;
export const FIXED_MAX = 12;
export const STANCE_NAME_MAX = 60;
export const STANCES_PER_OWNER_MAX = 20;

// One slot, cleaned, or null if it is not a valid slot.
export function normalizeSlot(slot) {
  if (!slot || typeof slot !== 'object') return null;
  if (slot.die !== undefined) {
    const die = Number(slot.die);
    return STANCE_DIE_SIZES.includes(die) ? { die } : null;
  }
  if (slot.fixed !== undefined) {
    const n = Number(slot.fixed);
    return Number.isInteger(n) && n >= FIXED_MIN && n <= FIXED_MAX ? { fixed: n } : null;
  }
  return null;
}

// A whole pool, cleaned, or null when anything in it is invalid or it has the
// wrong number of slots. All-or-nothing: a half-saved pool would roll the
// wrong dice at a turn start, which is worse than refusing the edit.
export function normalizeDice(value) {
  if (!Array.isArray(value)) return null;
  if (value.length < STANCE_SLOTS_MIN || value.length > STANCE_SLOTS_MAX) return null;
  const slots = value.map(normalizeSlot);
  return slots.every(Boolean) ? slots : null;
}

// Rolls a pool: each slot becomes `{ die, result }` or `{ fixed, result }`,
// in slot order, so chat can show every die's result separately.
export function rollStance(dice, rng = Math.random) {
  return dice.map((slot) =>
    slot.die !== undefined
      ? { die: slot.die, result: 1 + Math.min(slot.die - 1, Math.floor(rng() * slot.die)) }
      : { fixed: slot.fixed, result: slot.fixed }
  );
}

// "d10 d6 d6 5" — the pool as the book writes Action Dice.
export function describeDice(dice) {
  return (dice ?? []).map((s) => (s.die !== undefined ? `d${s.die}` : String(s.fixed))).join(' ');
}
