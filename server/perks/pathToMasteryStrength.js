// **Path To Mastery: Strength** — two clauses, two seams, and one of them new.
//
// "Blocks against you gain a -5 Penalty. Additionally, your Damage Threshold is
// reduced by 1."
//
// Both halves say the same thing from different ends: you are simply harder to
// stand in front of. A guard put up against you is worth less, and blows that
// would have been shrugged off as insignificant land instead.
//
// **The Threshold half is an existing seam.** `minDamageThresholdWhenAttacking`
// is summed onto the Minimum Damage Threshold for attacks THIS character makes
// — Not Just a Scratch's own seam, from the same side. Negative lowers the bar.
//
// **The Block half needed a new one.** Every roll seam so far answers about the
// roller; this is a penalty on somebody *else's* roll, conditioned on who they
// are guarding against. `blockPenaltyAgainstYou` is asked of the attacker and
// folded into the blocker's own modifier, which is the only place that knows
// both halves of the exchange.
//
// It applies to **Blocks only**, deliberately — a Dodge is getting out of the
// way and does not care how hard you hit. It is a flat −5 rather than a scaling
// figure, matching how the game prices a single decided consequence elsewhere
// (Movement Punisher's 3 Recovery, Dogfighter's +2).
export default {
  name: 'Path To Mastery: Strength',
  description:
    'Blocks against you gain a -5 Penalty. Additionally, your Damage Threshold is reduced by 1.',

  blockPenaltyAgainstYou: () => -5,
  minDamageThresholdWhenAttacking: () => -1,
};
