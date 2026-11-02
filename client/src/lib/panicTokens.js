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

export const ALL_TOKENS = [...BASIC_TOKENS, ...STATUS_TOKENS, ...UNIQUE_TOKENS];
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
