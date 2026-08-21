// **Wounded Wolf** — deliberately manual (see `manual` in perks/index.js).
//
// Trade a Step in one Stat for three in another. There is nothing here for the
// engine to do: it is a one-time act of character building, made at the table
// with a GM, and the Stats it moves are moved with the same Stat controls the
// sheet has always had. Automating it would mean inventing a prompt for a
// decision that happens once and is then simply true.
//
// Registered rather than left out so the card carries the ⚙ badge and the
// rename guard — "accounted for", not "forgotten". perkRegistry.test.js asserts
// a manual Perk declares no seam and no lifecycle hook, so this file cannot
// quietly grow behaviour while still claiming to be hand-run.
export default {
  name: 'Wounded Wolf',
  manual: true,
  description:
    'What the wound took, it paid for. Lose 1 Step in one Stat and gain 3 Steps in another — set with your GM when you take this Perk.',
};
