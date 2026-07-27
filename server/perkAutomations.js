import { FRAME_MAX } from './moveLogic.js';

// Manual, case-by-case Perk automation hooks. The earlier generic
// automation-type registry (die_step/stamina_multiplier/move_tag/
// move_frame_override/move_roll_bonus, applied automatically on every
// grant/revoke) was removed — Perks are now just picture/name/description
// plus membership (character_perks). Any Perk that needs a real mechanical
// effect gets a bespoke entry here, keyed by its exact name. A renamed Perk
// silently stops matching its hook — an accepted tradeoff for keeping this
// legible. Import whatever's needed at the call site: `run`/`one`/`all`
// from './db.js' for reads/writes, `io` from './index.js' to broadcast a
// live update (e.g. die:updated/character:updated) after one.
//
// Example:
//   import { run, one } from './db.js';
//   import { io } from './index.js';
//
//   export const PERK_HOOKS = {
//     'Iron Skin': {
//       onGrant: async ({ characterId }) => {
//         await run('UPDATE dice SET bonus = bonus + 1 WHERE character_id = ? AND slot_name = ?', [characterId, 'Body']);
//         io.emit('die:updated', /* ... */);
//       },
//       onRevoke: async ({ characterId }) => { /* the inverse */ },
//     },
//   };
export const PERK_HOOKS = {};

// A move's base frame data plus this character's accumulated per-move
// deltas (character_move_overrides — still populated manually via a
// PERK_HOOKS entry if a Perk needs to touch frame data), clamped to the
// same 0-FRAME_MAX-per-segment rule moves are created under.
export function effectiveFrames(base, deltas) {
  const clampSeg = (n) => Math.max(0, Math.min(FRAME_MAX, n));
  return {
    startup_tics: clampSeg(base.startup_tics + deltas.startup),
    active_tics: clampSeg(base.active_tics + deltas.active),
    recovery_tics: clampSeg(base.recovery_tics + deltas.recovery),
  };
}
