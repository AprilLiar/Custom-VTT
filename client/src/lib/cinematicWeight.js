// Cinematic (Narrative) Weight — Panic at the Dojo: Patch'd Up, p.38-40 — and
// the level tables that add to it. Pure and shared (no imports).
//
// The Director picks one of five weight classes per fight. It sets the HP of
// every Health Bar, the Heal Value (what healing restores when it names no
// number), the Bleed Value (you Bleed when damage brings your HP to it or
// below, once per Round) and how many Super Moves each side may use per Round.

export const WEIGHTS = [
  { key: 'feather', name: 'Featherweight', hp: 10, heal: 1, bleed: 2, supers: 0, blurb: 'Quick, low stakes — a bunch of nobodies who messed with the wrong people.' },
  { key: 'light', name: 'Lightweight', hp: 15, heal: 2, bleed: 3, supers: 1, blurb: 'Fast and deadly; favours quick fighters and big hits.' },
  { key: 'middle', name: 'Middleweight', hp: 20, heal: 2, bleed: 4, supers: 1, blurb: 'The standard. If unsure how serious a fight is, it is Middleweight.' },
  { key: 'heavy', name: 'Heavyweight', hp: 25, heal: 3, bleed: 5, supers: 1, blurb: 'Injury and livelihood on the line; plan several turns ahead.' },
  { key: 'world', name: 'Worldweight', hp: 30, heal: 3, bleed: 6, supers: 2, blurb: 'The world is on the line. A player risking their life makes it Worldweight.' },
];
export const WEIGHT_BY_KEY = Object.fromEntries(WEIGHTS.map((w) => [w.key, w]));

// Bonus HP per level (index = level - 1). Heroes: the Focused, Fused and
// Frantic tables agree (p.102, 107, 110). Warriors (enemies) level faster
// (p.272). Added to EVERY Health Bar.
export const HERO_BONUS_HP = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10];
export const WARRIOR_BONUS_HP = [0, 2, 3, 5, 7, 8, 10, 12, 13, 15];
export const FIGHTER_KINDS = ['hero', 'warrior'];

export const clampLevel = (n) => Math.min(10, Math.max(1, Math.trunc(Number(n)) || 1));

export function bonusHp(kind, level) {
  const table = kind === 'warrior' ? WARRIOR_BONUS_HP : HERO_BONUS_HP;
  return table[clampLevel(level) - 1];
}

// The Bonus Die from level 2 (both tables): rolled with the Stance's Action
// Dice at the start of the turn and added to the Action Pool.
export function bonusDie(level) {
  const l = clampLevel(level);
  if (l < 2) return null;
  if (l < 4) return 4;
  if (l < 6) return 6;
  if (l < 8) return 8;
  if (l < 10) return 10;
  return 12;
}

// HP of each of a fighter's bars in a fight of this weight.
export const barHp = (weightKey, kind, level) => (WEIGHT_BY_KEY[weightKey]?.hp ?? 0) + bonusHp(kind, level);

// Does damage that takes HP from `before` to `after` make the fighter Bleed?
// Only when it CROSSES into the Bleed range (book p.137: falling while already
// at or below it does not re-trigger), and the once-per-Round rule is the
// caller's (it knows the round).
export function crossesBleed(before, after, bleedValue) {
  if (bleedValue == null) return false;
  return before > bleedValue && after <= bleedValue;
}
