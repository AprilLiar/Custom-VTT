// Pure dice math for the chat Dice Tray — no I/O, so it can be unit-tested in
// isolation (see server/test/gameLogic.test.js).
//
// This file held the whole dice-pool system — the eight Stat dice, stepping a
// die up and down its ladder, Half-Damage, Injury penalties, max Stamina —
// until the pivot removed it. What is left is what one ad-hoc roll needs.

export const DIE_SIZES = [4, 6, 8, 10, 12];

// Ad-hoc roll modifiers are clamped to this range on the server.
export const MODIFIER_LIMIT = 20;

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

// **A modifier modifies the ROLL, not each die** (decided, fix). A die's own
// `result` is its face plus **its own** flat bonus, and the shared modifier
// lands once, here, on the sum — it used to be added to every die, so a roll of
// three dice at +3 collected +9.
//
// This is also the shape every roll payload carries: `dice[].result` never
// includes the shared modifier, and `total` always does. The client's
// decomposeRoll relies on exactly that split to recover a die's face.
export function rollTotal(dice, modifier = 0) {
  const sum = (dice ?? []).reduce((acc, d) => acc + (d?.result ?? 0), 0);
  return sum + (Number.isFinite(modifier) ? modifier : 0);
}
