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

// Combat Automation overhaul: which of the two defensive mechanics a
// Defensive move's Defense Frames represent. Block resolves fully
// automatically from dice math alone; Dodge is the one remaining
// human-in-the-loop call (the GM's Successful/Failed prompt) — see
// vttprojectplan.md. Required whenever a move is Defensive with at least one
// Defense Frame; meaningless (and always stored as null) otherwise.
export const DEFENSE_KINDS = ['block', 'dodge'];

export function sanitizeDefenseKind(value, isDefensive, hasDefenseFrames) {
  if (!isDefensive || !hasDefenseFrames) return null;
  return DEFENSE_KINDS.includes(value) ? value : 'block';
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

// Roll type (decided, new): 'stat' is the original body-part Roll above;
// 'custom' replaces it with one flat base die (for weapons — see
// CUSTOM_ROLL_SIZES), not tied to any character stat. Anything else falls
// back to 'stat'.
export const CUSTOM_ROLL_SIZES = [4, 6, 8, 10, 12];

export function sanitizeRollType(value) {
  return value === 'custom' ? 'custom' : 'stat';
}

// Only meaningful (and only ever stored) when rollType is 'custom' —
// writeMove forces this to null otherwise, mirroring how a Default move's
// styleAttributeId is always forced null regardless of what's sent.
export function sanitizeCustomRollSize(value) {
  const n = Math.trunc(Number(value));
  return CUSTOM_ROLL_SIZES.includes(n) ? n : null;
}

// Attack Target (Change 001): which Stats a Roll's damage may land on. The
// Move template stores the same 6-slot abstract vocabulary as a Roll itself
// (ROLL_SLOT_NAMES) — Hand/Leg only resolve to a concrete side once a
// specific attack is declared (see expandAttackTargets below), same as a
// Roll's own ambiguous slots resolve at roll time, not creation time.
export const ATTACK_TARGET_NAMES = ROLL_SLOT_NAMES;

// The 8 concrete Stats a die/damage application can actually target.
export const CONCRETE_ATTACK_TARGET_NAMES = [
  'Skull',
  'Brain',
  'Left Hand',
  'Stamina',
  'Body',
  'Right Hand',
  'Left Leg',
  'Right Leg',
];

// Unlike sanitizeRollSlots (which preserves input order), this returns
// canonical ATTACK_TARGET_NAMES order — MoveCard/MoveCreator display and the
// Chat/Apply "effective target" line are more legible in a fixed order than
// in whatever order the client happened to send.
export function sanitizeAttackTargets(list) {
  const supplied = new Set(Array.isArray(list) ? list : []);
  return ATTACK_TARGET_NAMES.filter((name) => supplied.has(name));
}

// Expands a Move template's abstract attack_targets (or any subset of
// ATTACK_TARGET_NAMES) into concrete Stat names, resolving Hand/Leg to one
// or both sides via the same appendage_choice a declared move already
// records for its own ambiguous Roll slot. appendageChoice = null expands to
// both sides (used for the pre-Block "either side is a valid target" case);
// 'left'/'right' narrows to just that side (used once a Successful Block's
// own declared side is known).
export function expandAttackTargets(list, appendageChoice = null) {
  const slots = sanitizeAttackTargets(list);
  const concrete = [];

  for (const slot of slots) {
    if (slot === 'Hand') {
      concrete.push(
        ...(appendageChoice === 'left'
          ? ['Left Hand']
          : appendageChoice === 'right'
            ? ['Right Hand']
            : ['Left Hand', 'Right Hand'])
      );
    } else if (slot === 'Leg') {
      concrete.push(
        ...(appendageChoice === 'left'
          ? ['Left Leg']
          : appendageChoice === 'right'
            ? ['Right Leg']
            : ['Left Leg', 'Right Leg'])
      );
    } else {
      concrete.push(slot);
    }
  }

  return [...new Set(concrete)];
}

// Parses a declared_moves.effective_attack_targets JSON column, dropping
// anything that isn't a recognized concrete Stat name.
export function parseConcreteAttackTargets(json) {
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((name) => CONCRETE_ATTACK_TARGET_NAMES.includes(name));
}
