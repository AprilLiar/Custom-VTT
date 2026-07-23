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
