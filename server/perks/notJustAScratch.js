// **Not Just a Scratch** — Tier 2, the `minDamageThresholdWhenAttacking` seam.
//
// Iron Skin's mirror, and deliberately the same seam shape from the other side:
// this lowers the smallest roll that draws blood, so a 3 or a 4 that would have
// done nothing now costs the target half a point. **Only the first gate moves** —
// the ladder becomes 3-10-15-20, not 3-8-13-18 (see computeHitDamage).
//
// Because the two are separate seams and each folds additively, an Iron Skin
// defender and a Not Just a Scratch attacker meeting each other cancel out to
// the plain 5, which is the right answer and needed no rule of its own.
export default {
  name: 'Not Just a Scratch',
  description:
    'Nothing you land is nothing. The Minimum Damage Threshold against your Attacks is reduced by 2 — the smallest gate only, so your damage goes 3-10-15-20.',

  minDamageThresholdWhenAttacking: () => -2,
};
