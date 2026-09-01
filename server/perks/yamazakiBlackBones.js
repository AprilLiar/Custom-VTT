// **Yamazaki Black Bones** — Tier 2, the `statDamageThreshold` seam.
//
// "Your small bones are the hard ones." A Stat that has already been worn down
// to a d6 or a d4 is +3 harder to hurt than it would otherwise be: the
// Minimum Damage Threshold for damage landing on THAT Stat goes from 5 to 8,
// while every other Stat on the same fighter — and every gate above the first —
// stays exactly where it was.
//
// **Why this needed a new seam rather than Iron Skin's.**
// `minDamageThresholdWhenAttacked` answers once per exchange, for the whole
// fighter, which is right for a hide and wrong for a bone: this Perk has to say
// something different about the Skull than about the Body in the same blow. So
// `statDamageThreshold` is asked once per Stat a blow is about to touch, and is
// summed on top of the exchange-wide figure — a fighter carrying both Perks gets
// both, with no rule for their meeting.
//
// **Read off the die SIZE, not the printed Stat.** A d6+2 is a d6 that someone
// is good with; the bone is still small. The bonus is a separate additive thing
// everywhere else in the game and it stays separate here.
//
// **The Threshold is a gate and only a gate** (see computeHitDamage). A blow
// that clears 8 hurts a d6 for exactly what it would always have been worth —
// this Perk never softens a hit, it stops the ones that were barely there. When
// it does stop one, the engine says so with a `damage_shrugged` event, because a
// Perk that changes a number says so out loud.
export default {
  name: 'Yamazaki Black Bones',
  description:
    'The smaller the bone, the harder it is. Any of your Stats at d6 or lower has its Minimum Damage Threshold increased by 3 — an attack must reach 8 to hurt it at all. Your other Stats are unaffected.',

  statDamageThreshold: ({ die }) => (Number(die?.current_size) <= 6 ? 3 : 0),
};
