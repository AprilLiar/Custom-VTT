const DIE_SIZES = [4, 6, 8, 10, 12];

export const POOLS = [
  { key: 'head', label: 'Head' },
  { key: 'core', label: 'Core' },
  { key: 'legs', label: 'Legs' },
];

// d4=0 .. d12=4, then +1 per bonus point — used for the current-vs-locked tint
export const rankOf = (size, bonus) => DIE_SIZES.indexOf(size) + bonus;

export const dieLabel = (size, bonus) => `d${size}${bonus > 0 ? `+${bonus}` : ''}`;

// Chat-log formula: the die's permanent bonus and the roll's ad-hoc modifier
// combined into one signed suffix, e.g. "d8+3" — matches the printed result.
export function dieFormula(size, bonus, modifier = 0) {
  const total = bonus + modifier;
  if (total === 0) return `d${size}`;
  return `d${size}${total > 0 ? `+${total}` : total}`;
}

// A logged roll stores only the summed `result` — `rollDie(size) + bonus +
// modifier`, see logRoll server-side. The physical die face is never stored,
// so it is recovered by subtracting the two flat additions back out.
//
// Every surface that prints a roll goes through this. Printing `result`
// beside a separately-stated modifier is not merely redundant, it reads as
// false: a d4 rendered as "Skull 14 (+11) — total 14" says the die showed
// 14, that 11 should be added, and that the total is 14 anyway. That was
// the round cutscene's log for its whole life, and it is why the engine's
// automatic rolls looked like they ignored every modifier.
export function decomposeRoll(die, modifier = 0) {
  const flat = (die.bonus ?? 0) + (modifier ?? 0);
  return { flat, raw: die.result - flat, result: die.result };
}

// One-line form of the above: "Skull 3 + 11 = 14", or just "Skull 14" when
// nothing was added. The cutscene log prints this directly; the chat roll
// card lays the same three numbers out across styled spans instead.
export function formatRollPart(die, modifier = 0) {
  const slot = die.slot_name ?? die.slotName ?? '';
  const { flat, raw, result } = decomposeRoll(die, modifier);
  if (flat === 0) return `${slot} ${result}`.trim();
  return `${slot} ${raw} ${flat > 0 ? '+' : '−'} ${Math.abs(flat)} = ${result}`.trim();
}

// Green above locked, red below, no tint when equal; opacity scales with the gap.
export function tintFor(die) {
  if (die.status === 'incapacitated') return null;
  const diff =
    rankOf(die.current_size, die.bonus) - rankOf(die.locked_size, die.locked_bonus);
  if (diff === 0) return null;
  const alpha = Math.min(0.15 + 0.13 * Math.abs(diff), 0.7);
  return diff > 0 ? `rgba(34, 197, 94, ${alpha})` : `rgba(239, 68, 68, ${alpha})`;
}
