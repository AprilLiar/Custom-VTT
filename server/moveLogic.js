// Pure validation/normalization for Moves — kept free of I/O for unit testing.

export const TRIGGERS = ['hit', 'block', 'miss'];

// Defensive-only triggers — only accepted by normalizeInteractions when the
// move itself is flagged is_defensive (see Defensive Moves in the plan).
export const DEFENSE_TRIGGERS = ['defense_success', 'defense_failure'];

export const ALL_TRIGGERS = [...TRIGGERS, ...DEFENSE_TRIGGERS];

// Frame data: 0-10 squares per segment (Startup/Active/Recovery), at least
// one square total. Startup yellow, Active red, Recovery blue (client-side).
export const FRAME_MAX = 10;

export function clampFrame(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(0, Math.min(FRAME_MAX, n));
}

export function validFrames(startup, active, recovery) {
  return startup + active + recovery >= 1;
}

// Defense Frames: a purely additive annotation on top of the Startup/
// Active/Recovery totals above, not a 4th timing phase — combatTiming.js's
// placement/reveal/overflow math is untouched by this. Each entry is a
// 0-based index into the move's full frame sequence (0..totalTics-1,
// Startup squares first, then Active, then Recovery — same order FrameBar
// renders) marking that particular square as also granting a defensive
// window; the client renders it green instead of its phase color. Can land
// anywhere in the sequence, including mid-Startup or mid-Recovery.
export function sanitizeDefensePositions(list, totalTics) {
  if (!Array.isArray(list)) return [];
  const clean = list
    .map((n) => Math.trunc(Number(n)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < totalTics);
  return [...new Set(clean)].sort((a, b) => a - b);
}

// Automation types on an interaction (the only automated effects for now):
//   self_recovery:     add/remove Recovery on yourself (amount may be negative)
//   opponent_recovery: add Recovery to the opponent (positive)
//   self_stamina:      lose additional Stamina yourself (positive = amount lost)
//   opponent_stamina:  the opponent loses Stamina (positive = amount lost)
// Execution happens in the combat phases; Phase 3 stores and displays them.
export const AUTOMATION_TYPES = [
  'self_recovery',
  'opponent_recovery',
  'self_stamina',
  'opponent_stamina',
];

const AMOUNT_LIMIT = 20;

// Returns a cleaned automations array, dropping anything malformed.
export function sanitizeAutomations(list) {
  if (!Array.isArray(list)) return [];
  const clean = [];
  for (const entry of list) {
    if (!entry || !AUTOMATION_TYPES.includes(entry.type)) continue;
    let amount = Math.trunc(Number(entry.amount) || 0);
    amount = Math.max(-AMOUNT_LIMIT, Math.min(AMOUNT_LIMIT, amount));
    if (amount === 0) continue;
    // Only self_recovery is signed (add or remove); the rest are positive.
    if (entry.type !== 'self_recovery') amount = Math.abs(amount);
    clean.push({ type: entry.type, amount });
  }
  return clean;
}

// Normalizes the interactions payload {hit, block, miss, defense_success?,
// defense_failure?} -> rows worth storing (non-empty text or at least one
// automation). hit/block/miss are always accepted; the two defense triggers
// are only accepted when isDefensive is true — a move switched off and
// re-saved simply stops having them normalized in, so a plain move:update
// (which always replaces move_interactions wholesale) drops them.
export function normalizeInteractions(interactions, isDefensive = false) {
  const rows = [];
  if (!interactions || typeof interactions !== 'object') return rows;
  const allowedTriggers = isDefensive ? ALL_TRIGGERS : TRIGGERS;
  for (const trigger of allowedTriggers) {
    const entry = interactions[trigger];
    if (!entry) continue;
    const text = String(entry.text ?? '').trim();
    const automations = sanitizeAutomations(entry.automations);
    if (text || automations.length) rows.push({ trigger, text, automations });
  }
  return rows;
}

const ROLL_BONUS_LIMIT = 20;

export function clampRollBonus(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(-ROLL_BONUS_LIMIT, Math.min(ROLL_BONUS_LIMIT, n));
}

// Stamina Cost: required on every move, but 0 (free) is valid; negative
// restores Stamina instead of spending it. Same +/-20 bound as roll bonus —
// there's nothing move-specific requiring a different limit.
const STAMINA_COST_LIMIT = 20;

export function clampStaminaCost(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(-STAMINA_COST_LIMIT, Math.min(STAMINA_COST_LIMIT, n));
}

// A move's Roll picks from 6 slots, not the 8 concrete dice: Left/Right Hand
// collapse into one ambiguous 'Hand' choice, Left/Right Leg into 'Leg' — the
// player picks which side at roll time, not the GM at creation time (see
// AMBIGUOUS_ROLL_SLOTS below for how each resolves to a real die).
export const ROLL_SLOT_NAMES = ['Skull', 'Brain', 'Hand', 'Stamina', 'Body', 'Leg'];

// left/right resolution for each ambiguous Roll slot, in [left, right] order.
export const AMBIGUOUS_ROLL_SLOTS = {
  Hand: ['Left Hand', 'Right Hand'],
  Leg: ['Left Leg', 'Right Leg'],
};

// A move's optional Roll: which slots get rolled together. Dedupes, drops
// unknown slot names, empty array = no Roll on this move.
export function sanitizeRollSlots(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((s) => String(s)))].filter((s) => ROLL_SLOT_NAMES.includes(s));
}

// Does this Roll include an ambiguous appendage slot? If so the move needs
// two Tells (right-choice, left-choice) instead of one.
export function hasAmbiguousRollSlot(rollSlots) {
  return rollSlots.some((s) => s in AMBIGUOUS_ROLL_SLOTS);
}
