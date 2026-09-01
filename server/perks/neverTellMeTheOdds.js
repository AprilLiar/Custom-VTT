// **Never Tell Me the Odds** — Tier 2, the `rollBonus` seam.
//
// "In Uneven Combat, when you are at a numbers disadvantage, you get a +5 Bonus
// to all rolls."
//
// **The condition is the pair's own headcount, not the Uneven Combat toggle.**
// That toggle only *permits* lopsided pairs; it does not make any particular one
// lopsided, and reading it would hand the bonus to a fighter in a perfectly even
// 1v1 happening elsewhere in the same fight. This asks the only question the
// sentence is actually about: are there more of them than of me, right here.
// (The Stance matchup already learned this distinction the hard way — see the
// bugfix note in combatBonuses.js.)
//
// A flat +5 however badly outnumbered, because that is what the text says: it is
// a fighter's back against the wall, not a scaling formula. One against three is
// already the same story as one against two, only worse.
export default {
  name: 'Never Tell Me the Odds',
  description:
    'The worse it looks, the better you get. While you are outnumbered in your own fight — more of them on the other side than there are of you on yours — every roll you make counts +5.',

  rollBonus: ({ sideCounts }) => {
    const mine = sideCounts?.mine ?? 0;
    const theirs = sideCounts?.theirs ?? 0;
    return mine > 0 && theirs > mine ? 5 : 0;
  },
};
