// Mirrors server/gameLogic.js's DICE_TEMPLATE — the 8 fixed dice every
// character has, needed client-side for the die_step Perk automation picker.
export const DIE_SLOT_NAMES = [
  'Skull', 'Brain', 'Left Hand', 'Stamina', 'Body', 'Right Hand', 'Left Leg', 'Right Leg',
];

// Mirrors server/moveLogic.js's Move Roll vocabulary: 6 slots, not the 8
// concrete dice — Left/Right Hand collapse into one ambiguous 'Hand' choice,
// Left/Right Leg into 'Leg', resolved to a real die only at roll time.
export const ROLL_SLOT_NAMES = ['Skull', 'Brain', 'Hand', 'Stamina', 'Body', 'Leg'];

export const ROLL_SLOT_LABELS = {
  Skull: 'Skull',
  Brain: 'Brain',
  Hand: 'Left/Right Hand',
  Stamina: 'Stamina',
  Body: 'Body',
  Leg: 'Left/Right Leg',
};

export const AMBIGUOUS_ROLL_SLOTS = new Set(['Hand', 'Leg']);
