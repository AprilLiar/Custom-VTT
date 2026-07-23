const DIE_SIZES = [4, 6, 8, 10, 12];

// d4=0 .. d12=4, then +1 per bonus point — used for the current-vs-locked tint
export const rankOf = (size, bonus) => DIE_SIZES.indexOf(size) + bonus;

export const dieLabel = (size, bonus) => `d${size}${bonus > 0 ? `+${bonus}` : ''}`;

// Green above locked, red below, no tint when equal; opacity scales with the gap.
export function tintFor(die) {
  if (die.status === 'incapacitated') return null;
  const diff =
    rankOf(die.current_size, die.bonus) - rankOf(die.locked_size, die.locked_bonus);
  if (diff === 0) return null;
  const alpha = Math.min(0.15 + 0.13 * Math.abs(diff), 0.7);
  return diff > 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
}
