// The Panic at the Dojo token catalog — the one list of every token the app
// knows about.
//
// **Shared by the server and the client.** Plain data, no imports, no JSX, so
// `server/` can import this file directly (the repo is one ESM package) and the
// two ends can never disagree about which token keys exist. Icons live in
// `panicIcons.jsx`, which only the client loads.
//
// Source: *Panic at the Dojo: Patch'd Up* (Vel Mini / Liberi Gothica Games,
// 2024-2025), CC-BY-SA 4.0 — token kinds p.75-78, End Phase p.68. The book
// lists Unique tokens "and others", so this list is meant to grow: adding a
// Unique token is one entry here plus one icon in panicIcons.jsx.

// The book caps every token at 10 (Training at 4, Challenge at 1). **Decided:
// the app caps every type at 9**, so a count is always a single digit.
export const TOKEN_CAP = 9;

export const BASIC_TOKENS = [
  { key: 'iron', name: 'Iron', kind: 'basic', summary: 'Spend 1-2 when hit to reduce the damage and push/pull by 1 each.' },
  { key: 'power', name: 'Power', kind: 'basic', summary: 'Spend 1 when you deal damage: +1 damage and Push 1.' },
  { key: 'speed', name: 'Speed', kind: 'basic', summary: 'Spend for Free Movement. Everyone discards 3 at the end of each turn.' },
];

// Challenge is a Status token, but it is never a count: it is held by one
// fighter and names another. The token panel gives it its own slot.
export const STATUS_TOKENS = [
  { key: 'burning', name: 'Burning', kind: 'status', summary: 'End of your turn: take damage equal to your Burning (Iron cannot reduce it), then discard half, rounded up.' },
  { key: 'fatigue', name: 'Fatigue', kind: 'status', summary: 'Your movement is reduced by 2, then discard 1. End of turn: discard up to 3 if you did not move.' },
  { key: 'weakness', name: 'Weakness', kind: 'status', summary: 'When you deal damage, reduce it by 2, then discard 1.' },
];

export const UNIQUE_TOKENS = [
  { key: 'control', name: 'Control', kind: 'unique', source: 'Control Form (also the Counter bonus)', summary: 'Used to Copy, Dodge or Parry enemy Actions.' },
  { key: 'chaos', name: 'Chaos', kind: 'unique', source: 'Demon (also Mastermind Style)', summary: 'Spend to take a Reactive Action, as if you had spent a 4. Once per turn.' },
  { key: 'luck', name: 'Luck', kind: 'unique', source: 'Underdog', summary: 'After any Action resolves: Teleport 3 and Heal 1. Once per turn.' },
  { key: 'mentor', name: 'Mentor', kind: 'unique', source: 'Teacher', summary: 'Improves your Heroic Spirit; pays for Remember Your Training.' },
  { key: 'inspired', name: 'Inspired', kind: 'unique', source: 'Teacher / Motivating Style', summary: 'Given by the Teacher and Motivating Style.' },
  { key: 'poltergeist', name: 'Poltergeist', kind: 'unique', source: 'Phantom', summary: 'Spend when paying for an Action to modify its properties.' },
  { key: 'training', name: 'Training', kind: 'unique', source: 'Training Style', summary: 'Spend after an Action to improve a number in your Action Pool.' },
  { key: 'rapid_strike', name: 'Rapid Strike', kind: 'super', source: 'Underdog — Blur Super Move', summary: 'Spend (your turn or as a Reactive Action) to move 1, then deal 1 damage to an adjacent enemy.' },
];

// **Armor (decided, new)** — p.24, "Armor, Shields, Unblockable". Not a token
// in the book but a stackable defence, tracked like one: the count is how
// many sources of Armor the fighter has. Every fighter shows it, in the token
// row just after the Challenge slot.
export const SPECIAL_TOKENS = [
  {
    key: 'armor',
    name: 'Armor',
    kind: 'special',
    summary:
      'The first time you take damage each turn, reduce it by 3. More sources trigger again that turn, weaker: the 2nd blocks 2, the 3rd and beyond 1. Works on any damage (Fall, Burning, Traps, Super Moves) but not on HP costs.',
  },
  // **Shield (decided, new)** — p.24. A value, not stacked sources: you hold
  // one Shield, and gaining another either replaces it or raises it by 1.
  // Capped at 8 (the book's Shield Cap). It absorbs damage from Actions and
  // Abilities (absorbWithShield, below); HP "−" never spends it. It is also
  // drawn as a blue extension of the HP bar.
  {
    key: 'shield',
    name: 'Shield',
    kind: 'special',
    cap: 8,
    summary:
      'Blocks incoming damage from any Action or Ability that targets you, up to its value; when used up it breaks and the rest hits you. One Shield at a time: a new one replaces it, or raises it by 1. Cannot be healed. Cap 8.',
  },
  // **Temporary Armor (full automation, phase C)** — p.24: Guard and the like.
  // Binary (cap 1): used after all other Armor, triggers once, then it is lost.
  {
    key: 'temp_armor',
    name: 'Temporary Armor',
    kind: 'special',
    cap: 1,
    summary: 'Armor that triggers once, after all your other Armor (the first trigger of a turn blocks 3, the second 2, then 1), and is then lost. You either have it or you do not.',
  },
];

export const ALL_TOKENS = [...BASIC_TOKENS, ...STATUS_TOKENS, ...UNIQUE_TOKENS, ...SPECIAL_TOKENS];
export const SPECIAL_KEYS = new Set(SPECIAL_TOKENS.map((t) => t.key));
// **Armor sources (decided, new):** a fighter's lasting Armor, set on their
// Combat tab — each source is 'always' or the id of one of their Stances.
// Every source whose condition holds adds 1 Armor to the token row, on top of
// any Armor added by hand. Stored cleaned: at most TOKEN_CAP sources.
export const ARMOR_ALWAYS = 'always';
export function normalizeArmorSources(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (v === ARMOR_ALWAYS) out.push(ARMOR_ALWAYS);
    else if (Number.isInteger(v) && v > 0) out.push(v);
    // A derived Stance's key ("form.x+style.y", builder phase 2).
    else if (typeof v === 'string' && v.length <= 120 && /^[a-z0-9.-]+\+[a-z0-9.-]+$/.test(v)) out.push(v);
    if (out.length >= TOKEN_CAP) break;
  }
  return out;
}
// How many sources hold while the fighter is in `activeStanceId` (null: no
// Stance — only 'always' sources count).
export const innateArmor = (sources, activeStanceId) =>
  normalizeArmorSources(sources).filter((s) => s === ARMOR_ALWAYS || (activeStanceId != null && s === activeStanceId)).length;

// A token's own cap: TOKEN_CAP unless the token has a lower one (Shield: 8).
// **A Shield absorbs damage (decided, revised).** Damage from an Action or an
// Ability that targets you hits the Shield first, up to its value; what's left
// of the Shield stays, a Shield used up breaks, and the rest hits HP. (Traps
// and HP costs never touch it.) → { absorbed, shield, broke, rest }.
export function absorbWithShield(shield, amount) {
  const s = Math.max(0, Math.trunc(Number(shield) || 0));
  const n = Math.max(0, Math.trunc(Number(amount) || 0));
  const absorbed = Math.min(s, n);
  return { absorbed, shield: s - absorbed, broke: s > 0 && absorbed === s && n >= s, rest: n - absorbed };
}

export const capOf = (key) => TOKEN_BY_KEY[key]?.cap ?? TOKEN_CAP;
export const UNIQUE_KEYS = new Set(UNIQUE_TOKENS.map((t) => t.key));
export const TOKEN_BY_KEY = Object.fromEntries(ALL_TOKENS.map((t) => [t.key, t]));

// Every token a fighter shows: Basic and Status always, then whichever Unique
// tokens their Combat tab has checked, in catalog order.
export function tokensFor(uniqueKeys = []) {
  const chosen = new Set(uniqueKeys);
  return [...BASIC_TOKENS, ...STATUS_TOKENS, ...UNIQUE_TOKENS.filter((t) => chosen.has(t.key))];
}

// A stored Unique-token selection, cleaned: known keys only, no duplicates,
// catalog order. Anything that is not an array of strings becomes [].
export function normalizeUniqueKeys(value) {
  if (!Array.isArray(value)) return [];
  const chosen = new Set(value.filter((k) => typeof k === 'string' && UNIQUE_KEYS.has(k)));
  return UNIQUE_TOKENS.filter((t) => chosen.has(t.key)).map((t) => t.key);
}
