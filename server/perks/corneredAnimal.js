// **Cornered Animal** — Tier 2, the `rollBonus` seam.
//
// A standing modifier with a live condition, which is the shape most numeric
// Perks turn out to have and the one the old grant-time-only hooks could not
// express at all: the bonus is not applied to anything when the Perk is
// granted, it is asked for and answered at every roll.
//
// It appears in the roll's own breakdown under this Perk's name (see
// perkRollBonusTerms), which is the rule for any Perk that moves a number —
// the reader has to be able to account for the total.
//
// **A sample, chosen to exercise the seam rather than proposed as balance.**
// Rename it, retune it or delete it at a cost of this one file.
export default {
  name: 'Cornered Animal',
  description:
    'You fight hardest with your back to the wall. While your Stamina is at a quarter of its maximum or below, every roll you make counts +2.',

  rollBonus: ({ character }) => {
    if (!character?.max_stamina) return 0;
    // A quarter or less. Multiplied out rather than divided, so the threshold
    // is exact at every max_stamina instead of drifting with rounding.
    return character.current_stamina * 4 <= character.max_stamina ? 2 : 0;
  },
};
