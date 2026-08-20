// Pure per-move helpers that Perks write to, kept here rather than in
// perkEngine.js because `getMovesFor` needs them on every move-list read and
// they involve no Perk lookup at all.
//
// **The Perk system itself now lives in two other files** (decided, new — the
// third arrangement, and the one to keep):
//
//   - `server/perks/index.js`  — the registry, and the doctrine for writing a
//                                Perk. Read that first.
//   - `server/perkEngine.js`   — the seam resolvers and per-grant state.
//
// What used to be here — `PERK_HOOKS` (onGrant/onRevoke keyed by name) and
// `IDLE_STAMINA_REGEN_HOOKS` (a second, narrower map keyed the same way) — are
// gone as separate registries. Both were only ever *one field each* of what a
// Perk is, and keeping them as parallel maps meant a single Perk with a grant
// effect and a regen rate had to be written down in two places under the same
// name and kept in step by hand. They are fields on a Perk definition now, and
// `idleStaminaRegenRate` below is re-exported from perkEngine so its callers
// and its tests did not have to move.

import { FRAME_MAX } from './moveLogic.js';

export { idleStaminaRegenRate } from './perkEngine.js';

// A move's base frame data plus this character's accumulated per-move deltas
// (`character_move_overrides`, written by a Perk that needs to touch frame
// data), clamped to the same 0-FRAME_MAX-per-segment rule moves are created
// under.
export function effectiveFrames(base, deltas) {
  const clampSeg = (n) => Math.max(0, Math.min(FRAME_MAX, n));
  return {
    startup_tics: clampSeg(base.startup_tics + deltas.startup),
    active_tics: clampSeg(base.active_tics + deltas.active),
    recovery_tics: clampSeg(base.recovery_tics + deltas.recovery),
  };
}
