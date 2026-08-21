// **Perfect Player** — Tier 2, the `staminaCostDelta` seam.
//
// The first Perk to touch what a move COSTS rather than what it does, which is
// why the seam takes the move as well as the character: it is asked once per
// move, and answers 0 for everything that is not a Dodge.
//
// **Undamaged means no die has dropped a rank** (decided). A pending
// Half-Damage marker does not break it — you are still standing on everything
// you started with. An incapacitated Stat does, obviously.
//
// Measured against the **Injury-adjusted** baseline rather than the raw locked
// value, so "your current Locked Value" means what Revert Stats would actually
// give you back: a fighter carrying a permanent Injury is still Perfect at the
// top of what that Injury leaves them.
import { applyRankPenalty, rankOf } from '../gameLogic.js';

export default {
  name: 'Perfect Player',
  description:
    'You are only untouchable while you are untouched. While no Stat of yours is below its current Locked Value, any Dodge move costs 2 less Stamina.',

  staminaCostDelta: ({ move, dice, injuryPenaltyFor }) => {
    // `move` is the facts shape the seam hands every Perk (see moveFacts in
    // perkEngine.js), not the raw row — hence defenseKind, not defense_kind.
    if (move?.defenseKind !== 'dodge') return 0;
    const flawless = (dice ?? []).every((die) => {
      if (die.status === 'incapacitated') return false;
      // A die that was never locked has no baseline to fall below.
      if (die.locked_size == null) return true;
      const baseline = applyRankPenalty(
        { size: die.locked_size, bonus: die.locked_bonus ?? 0, status: die.locked_status ?? 'active' },
        injuryPenaltyFor?.(die.slot_name) ?? 0
      );
      if (baseline.status === 'incapacitated') return true;
      return rankOf(die.current_size, die.bonus) >= rankOf(baseline.size, baseline.bonus);
    });
    return flawless ? -2 : 0;
  },
};
