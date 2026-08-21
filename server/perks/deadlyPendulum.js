// **Deadly Pendulum** — Tier 2, the `rollBonus` seam.
//
// Sway out, swing back. The counter-punch you queued behind a Dodge hits harder
// — but only if the Dodge actually worked.
//
// **This is a bet you place during Declaration and collect during resolution.**
// A round is declared in full before any of it resolves, so when you put the
// attack down behind the Dodge you do not yet know the GM will call that Dodge
// Successful. That is the whole shape of the Perk, and it is why the condition
// is read at ROLL time off a fact the engine recorded when the Dodge resolved
// (declared_moves.defense_outcome) rather than gated at declare time like
// Punches in Bunches' discount.
//
// **"Right after" is the queue** — the move ending immediately before this one,
// the same reading Requirements and Punches in Bunches use. So a Dodge, then a
// Block, then a punch is not a pendulum: the punch came right after the Block.
//
// Only a Dodge counts, never a Block. A Block that held is not a swing away
// from anything — you stood there and took it on your arms.
import { isAttackingMove } from '../moveLogic.js';

export default {
  name: 'Deadly Pendulum',
  description:
    'You hit hardest coming back. An Attack declared right after a Dodge gets +2 to the Attack, if that Dodge was Successful.',

  rollBonus: async ({ getMove, getPreviousMove }) => {
    if (!isAttackingMove(await getMove())) return 0;
    const previous = await getPreviousMove();
    return previous?.defenseKind === 'dodge' && previous?.defenseOutcome === 'success' ? 2 : 0;
  },
};
