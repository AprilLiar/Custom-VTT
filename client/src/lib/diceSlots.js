// Mirrors server/moveLogic.js's Move Roll vocabulary: seven slots, not the 8
// concrete dice — Left/Right Hand collapse into one ambiguous 'Hand' choice,
// Left/Right Leg into 'Leg', resolved to a real die only at roll time.
//
// **'Weapon' is the seventh and names no die at all (decided, new)**: it
// resolves to whatever the character is carrying, which for most of them is
// nothing. A Move that rolls it cannot be declared unarmed — refused by the
// server, and greyed out on the sheet and in the Arena picker so nobody has to
// find that out the hard way.
export const ROLL_SLOT_NAMES = ['Skull', 'Brain', 'Hand', 'Stamina', 'Body', 'Leg', 'Weapon'];

export const ROLL_SLOT_LABELS = {
  Skull: 'Skull',
  Brain: 'Brain',
  Hand: 'Left/Right Hand',
  Stamina: 'Stamina',
  Body: 'Body',
  Leg: 'Left/Right Leg',
  Weapon: 'Weapon',
};

export const AMBIGUOUS_ROLL_SLOTS = new Set(['Hand', 'Leg']);

// What a slot reads as when the Roll takes BOTH of them (an ambiguous slot
// picked twice — a Straight Block guards with both hands). Mirrors
// server/moveLogic.js's MAX_AMBIGUOUS_ROLL_SLOT_COUNT = 2.
export const ROLL_SLOT_BOTH_LABELS = {
  Hand: 'Both Hands',
  Leg: 'Both Legs',
};

export const MAX_AMBIGUOUS_ROLL_SLOT_COUNT = 2;

export const maxRollSlotCount = (slot) =>
  AMBIGUOUS_ROLL_SLOTS.has(slot) ? MAX_AMBIGUOUS_ROLL_SLOT_COUNT : 1;

export const countRollSlot = (rollSlots, slot) =>
  (rollSlots ?? []).reduce((n, s) => (s === slot ? n + 1 : n), 0);

// One human-readable term per distinct slot, collapsing a doubled appendage
// into its "Both …" form rather than repeating the same label twice.
export function describeRollSlots(rollSlots) {
  const seen = new Set();
  const parts = [];
  for (const slot of rollSlots ?? []) {
    if (seen.has(slot)) continue;
    seen.add(slot);
    parts.push(
      countRollSlot(rollSlots, slot) > 1
        ? (ROLL_SLOT_BOTH_LABELS[slot] ?? `${ROLL_SLOT_LABELS[slot] ?? slot} x2`)
        : (ROLL_SLOT_LABELS[slot] ?? slot)
    );
  }
  return parts;
}

// Is there still a Left/Right question to ask? Taking a slot twice answers
// it (both sides are used), so only a slot taken exactly once is ambiguous.
// Must agree with server/moveLogic.js's hasAmbiguousRollSlot.
export const hasAmbiguousRollSlot = (rollSlots) =>
  [...AMBIGUOUS_ROLL_SLOTS].some((slot) => countRollSlot(rollSlots, slot) === 1);
