// The five die sizes the game has, mirroring DIE_SIZES in server/gameLogic.js.
// Exported because the Weapon editor offers exactly this list — a weapon's die
// is one of the same five, not a free number.
export const DIE_SIZES = [4, 6, 8, 10, 12];

export const POOLS = [
  { key: 'head', label: 'Head' },
  { key: 'core', label: 'Core' },
  { key: 'legs', label: 'Legs' },
];

// d4=0 .. d12=4, then +1 per bonus point — used for the current-vs-locked tint
export const rankOf = (size, bonus) => DIE_SIZES.indexOf(size) + bonus;

export const dieLabel = (size, bonus) => `d${size}${bonus > 0 ? `+${bonus}` : ''}`;

// One die and its own permanent bonus, e.g. "d8+3". A roll's shared modifier
// is deliberately NOT accepted here: it applies once to the total, not to each
// die (rollTotal in server/gameLogic.js), so folding it into a per-die formula
// would advertise a roll the engine will not produce. Callers append it to the
// whole formula instead — see formulaFor in MoveCard.jsx.
export function dieFormula(size, bonus) {
  if (!bonus) return `d${size}`;
  return `d${size}${bonus > 0 ? `+${bonus}` : bonus}`;
}

// A logged roll stores only each die's summed `result` — `rollDie(size) +
// that die's own bonus`, see logRoll server-side. The physical face is never
// stored, so it is recovered by subtracting the bonus back out.
//
// **The shared modifier is NOT in here** (decided, fix): it modifies the
// roll, not each die, so it is applied once to the total (rollTotal in
// server/gameLogic.js) and printed on the total's own line. It used to be
// added per die — which both inflated a multi-Stat Roll and had to be
// subtracted back out here to find the face.
//
// Every surface that prints a roll goes through this. Printing `result`
// beside a separately-stated modifier is not merely redundant, it reads as
// false: a d4 rendered as "Skull 14 (+11) — total 14" says the die showed
// 14, that 11 should be added, and that the total is 14 anyway. That was
// the round cutscene's log for its whole life.
export function decomposeRoll(die) {
  const flat = die.bonus ?? 0;
  return { flat, raw: die.result - flat, result: die.result };
}

// One-line form of the above: "Skull 3 + 2 = 5", or just "Skull 5" when the
// die has no bonus of its own. The cutscene log prints this directly; the
// chat roll card lays the same three numbers out across styled spans.
export function formatRollPart(die) {
  const slot = die.slot_name ?? die.slotName ?? '';
  const { flat, raw, result } = decomposeRoll(die);
  if (flat === 0) return `${slot} ${result}`.trim();
  return `${slot} ${raw} ${flat > 0 ? '+' : '−'} ${Math.abs(flat)} = ${result}`.trim();
}

// "12 + 3 = 15" — the dice summed, then the one shared modifier, then the
// total. The half of a roll that used to be invisible because the modifier
// was already hidden inside every die.
export function formatRollTotal(dice, modifier = 0, total) {
  const sum = (dice ?? []).reduce((acc, d) => acc + (d.result ?? 0), 0);
  if (!modifier) return `${total ?? sum}`;
  return `${sum} ${modifier > 0 ? '+' : '−'} ${Math.abs(modifier)} = ${total ?? sum + modifier}`;
}

// The same total, itemised: `9 + 3 (Stance matchup) − 2 (Held in a grapple) = 10`.
// Used by the cutscene log, where a modifier that appears from nowhere reads as
// the engine making numbers up — a Combat Style in particular can be worth
// several points and had no way to say so (decided, new).
//
// Falls back to formatRollTotal's plain form when there is nothing to itemise,
// so a roll with one unremarkable modifier stays short.
export function formatRollBreakdown(dice, terms, total, modifier = 0) {
  const parts = (terms ?? []).filter((t) => t && t.amount);
  if (parts.length < 2) return formatRollTotal(dice, modifier, total);
  const sum = (dice ?? []).reduce((acc, d) => acc + (d.result ?? 0), 0);
  const body = parts
    .map((t) => `${t.amount > 0 ? '+' : '−'} ${Math.abs(t.amount)} (${t.label})`)
    .join(' ');
  return `${sum} ${body} = ${total ?? sum + parts.reduce((a, t) => a + t.amount, 0)}`;
}

// Just the named pieces — `+ 4 (Stance matchup) − 5 (Read on the grab)` — with
// no sum and no total. The chat card wants them on a second, quieter line under
// a total that stays big and readable, rather than one long string at 2xl in a
// 320px panel; the cutscene's own log has the width for the full sentence and
// keeps using formatRollBreakdown.
//
// Empty for a roll whose modifier is one plain thing, which is most of them —
// itemising `+ 2 (The move's own modifier)` says nothing the total didn't.
export function formatModifierTerms(terms) {
  const parts = (terms ?? []).filter((t) => t && t.amount);
  if (parts.length < 2) return '';
  return parts.map((t) => `${t.amount > 0 ? '+' : '−'} ${Math.abs(t.amount)} (${t.label})`).join(' ');
}

// **Temporary Damage, in one place.** How many half-steps of this Stat's damage
// wear off at 0.5 a Round — carried on every die payload (see `diePayload` in
// server/index.js), so any surface that draws a Stat can ask without a second
// fetch. Reads the cutscene's own field name too: a replay's roster snapshot
// stores it as `temporarySteps`, because those payloads are camelCase.
export const temporarySteps = (die) =>
  Math.max(0, Math.trunc(Number(die?.temporary_damage ?? die?.temporarySteps ?? 0)) || 0);

export const isTemporarilyDamaged = (die) => temporarySteps(die) > 0;

// The hover line, worded once so it says the same thing on the sheet, in the
// Arena, in the damage dialog and in a replay.
export function temporaryDamageTitle(die) {
  const steps = temporarySteps(die);
  if (!steps) return null;
  const half = steps * 0.5;
  return `${half} of this Stat's damage is Temporary — it comes back at 0.5 per finished Round`;
}

// **Purple for a Stat carrying Temporary Damage (decided, new).** Deliberately a
// short hop from the red it replaces rather than a fresh colour: red-500 is
// hsl(0, 84%, 60%) and this is hsl(300, 60%, 62%) at the same alpha ramp, so a
// purple Stat still reads as "this Stat is hurt" at a glance and only says
// something extra on a second look. A saturated violet would have read as a
// different kind of state entirely.
const DAMAGED = '239, 68, 68';
const TEMPORARY = '196, 92, 196';
const IMPROVED = '34, 197, 94';

// Green above locked, red below, purple below when the damage wears off, no
// tint when equal; opacity scales with the gap.
export function tintFor(die) {
  if (die.status === 'incapacitated') return null;
  const diff =
    rankOf(die.current_size, die.bonus) - rankOf(die.locked_size, die.locked_bonus);
  if (diff === 0) return null;
  const alpha = Math.min(0.15 + 0.13 * Math.abs(diff), 0.7);
  if (diff > 0) return `rgba(${IMPROVED}, ${alpha})`;
  return `rgba(${isTemporarilyDamaged(die) ? TEMPORARY : DAMAGED}, ${alpha})`;
}

// The same purple as a flat wash, for the surfaces that do not use `tintFor` —
// a die at its locked size can still owe Temporary Damage back (the Round that
// dealt it may already have healed the last half-step), and an incapacitated
// one is exactly the case worth marking: a Stat destroyed by Temporary Damage
// walks back out of it.
export function temporaryTint(die, alpha = 0.22) {
  return isTemporarilyDamaged(die) ? `rgba(${TEMPORARY}, ${alpha})` : null;
}
