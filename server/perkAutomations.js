// Pure validation/normalization for Perk automations — kept free of I/O so
// it can be unit tested. server/index.js pairs each type with DB-touching
// apply/revoke logic; adding a new automation type later means adding one
// case here (payload shape) and one in index.js (apply/revoke) — the
// grant/revoke orchestration itself never changes.

import { DICE_TEMPLATE } from './gameLogic.js';
import { FRAME_MAX } from './moveLogic.js';

export const DIE_SLOT_NAMES = DICE_TEMPLATE.map((d) => d.slot_name);

// Two families:
//   - character-scoped (die_step, stamina_multiplier): mutate character/dice
//     state directly, so revoke needs an inverse payload (see below).
//   - move-scoped (move_tag, move_frame_override, move_roll_bonus): apply by
//     inserting a row tagged with the granting character_perk_id; revoke is
//     just deleting rows with that tag, no inverse math needed.
export const AUTOMATION_TYPES = [
  'die_step',
  'stamina_multiplier',
  'move_tag',
  'move_frame_override',
  'move_roll_bonus',
];

const STEP_LIMIT = 20;
const MULTIPLIER_LIMIT = 20;
const FRAME_DELTA_LIMIT = FRAME_MAX;
const ROLL_BONUS_LIMIT = 20;

function intInRange(value, lo, hi) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(lo, Math.min(hi, n));
}

// Validates + cleans one automation's payload for its type. Reference checks
// (does this move/tag id actually exist) need DB access and happen in
// index.js — this only validates shape and bounds.
export function normalizeAutomationPayload(type, payload) {
  if (!payload || typeof payload !== 'object') return null;
  switch (type) {
    case 'die_step': {
      const slotName = String(payload.slotName ?? '');
      if (!DIE_SLOT_NAMES.includes(slotName)) return null;
      const steps = intInRange(payload.steps, -STEP_LIMIT, STEP_LIMIT);
      if (steps === 0) return null;
      const scope = payload.scope === 'current' ? 'current' : 'permanent';
      return { slotName, steps, scope };
    }
    case 'stamina_multiplier': {
      const delta = intInRange(payload.delta, -MULTIPLIER_LIMIT, MULTIPLIER_LIMIT);
      if (delta === 0) return null;
      return { delta };
    }
    case 'move_tag': {
      const moveId = Number(payload.moveId);
      const tagId = Number(payload.tagId);
      if (!Number.isInteger(moveId) || !Number.isInteger(tagId)) return null;
      const action = payload.action === 'remove' ? 'remove' : 'add';
      return { moveId, tagId, action };
    }
    case 'move_frame_override': {
      const moveId = Number(payload.moveId);
      if (!Number.isInteger(moveId)) return null;
      const startupDelta = intInRange(payload.startupDelta, -FRAME_DELTA_LIMIT, FRAME_DELTA_LIMIT);
      const activeDelta = intInRange(payload.activeDelta, -FRAME_DELTA_LIMIT, FRAME_DELTA_LIMIT);
      const recoveryDelta = intInRange(payload.recoveryDelta, -FRAME_DELTA_LIMIT, FRAME_DELTA_LIMIT);
      if (startupDelta === 0 && activeDelta === 0 && recoveryDelta === 0) return null;
      return { moveId, startupDelta, activeDelta, recoveryDelta };
    }
    case 'move_roll_bonus': {
      const moveId = Number(payload.moveId);
      if (!Number.isInteger(moveId)) return null;
      const amount = intInRange(payload.amount, -ROLL_BONUS_LIMIT, ROLL_BONUS_LIMIT);
      if (amount === 0) return null;
      return { moveId, amount };
    }
    default:
      return null;
  }
}

// A Perk's raw automations array -> cleaned { automation_type, payload } rows,
// dropping anything malformed or unrecognized. Mirrors moveLogic's
// normalizeInteractions/sanitizeAutomations pattern.
export function normalizeAutomations(list) {
  if (!Array.isArray(list)) return [];
  const rows = [];
  for (const entry of list) {
    if (!entry || !AUTOMATION_TYPES.includes(entry.type)) continue;
    const payload = normalizeAutomationPayload(entry.type, entry.payload ?? {});
    if (payload) rows.push({ automation_type: entry.type, payload });
  }
  return rows;
}

// Inverse payload for the two character-scoped types, used on revoke. The
// three move-scoped types don't need this — their effect is a tagged row,
// removed wholesale on revoke rather than mathematically reversed.
export function invertAutomationPayload(type, payload) {
  if (type === 'die_step') return { ...payload, steps: -payload.steps };
  if (type === 'stamina_multiplier') return { ...payload, delta: -payload.delta };
  return payload;
}

// A move's base frame data plus this character's accumulated Perk deltas,
// clamped to the same 0-FRAME_MAX-per-segment rule moves are created under.
export function effectiveFrames(base, deltas) {
  const clampSeg = (n) => Math.max(0, Math.min(FRAME_MAX, n));
  return {
    startup_tics: clampSeg(base.startup_tics + deltas.startup),
    active_tics: clampSeg(base.active_tics + deltas.active),
    recovery_tics: clampSeg(base.recovery_tics + deltas.recovery),
  };
}
