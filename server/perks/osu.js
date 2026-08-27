// **Osu!** — Tier 2, two seams, and a Perk that pays for what it gives.
//
// "You add +1 Recovery to every Attack, in order to return to your stance. For
// that, your technique is improved, giving you +2 to all Attack Rolls."
//
// Both halves are the same clause, which is why they are one Perk and not two:
// the Recovery is the *cost* of the accuracy. Returning to stance after every
// blow is slower and lands harder.
//
// **"Attack" means the same thing in both halves**, deliberately — `isAttackingMove`,
// the shared reading every other attack-conditioned rule in the game uses (a
// telegraphed, non-defensive move with somewhere to land). A Perk whose two
// clauses disagreed about what an Attack is would be unplayable: you would be
// paying the Recovery on moves that never got the bonus.
//
// The Recovery rides `moveFrameDelta`, which folds into the per-character frame
// overrides `getMovesFor` already applies — so the longer footprint is visible
// in the declare picker *before* the move is placed, floors the next
// declaration correctly, and draws on the Tic strip. It is not bookkeeping
// applied at resolution; it is a frame, and it looks like one.
import { isAttackingMove } from '../moveLogic.js';

export default {
  name: 'Osu!',
  description:
    'You add +1 Recovery to every Attack, in order to return to your stance. For that, your technique is improved, giving you +2 to all Attack Rolls.',

  moveFrameDelta: ({ move }) => (isAttackingMove(move) ? { recovery: 1 } : {}),

  rollBonus: async ({ getMove }) => (isAttackingMove(await getMove()) ? 2 : 0),
};
