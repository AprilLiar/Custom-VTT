// **Iron Skin** — Tier 2, the `minDamageThresholdWhenAttacked` seam.
//
// The Minimum Damage Threshold is the smallest roll that hurts you at all. This
// raises it by 2, so a roll of 5 or 6 that would have cost you half a point now
// costs you nothing. Every gate above the first is untouched: the ladder against
// you reads 7-10-15-20 rather than 5-10-15-20 (see computeHitDamage).
//
// Two knock-on effects, both of which are the same rule rather than extra ones:
// an attack that falls under the threshold becomes **Insignificant Damage**, and
// a Block whose leftover falls under it becomes a **Full** Block. Both are
// defined as "did this deal damage", which is the question this Perk moves.
export default {
  name: 'Iron Skin',
  description:
    'Hitting you is like hitting a wall. The Minimum Damage Threshold for Attacks against you is increased by 2 — the smallest gate only, so damage against you goes 7-10-15-20.',

  minDamageThresholdWhenAttacked: () => 2,
};
