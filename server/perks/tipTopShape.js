// **Tip Top Shape** — Tier 2, the `staminaOverflowHealing` seam.
//
// "For every 5 Stamina that you would recover above your Maximum Stamina, heal
// back 1 Step of Damage from a random Stat." A fighter already at full turns
// wasted recovery into repair.
//
// **The remainder banks (decided).** A regen overflowing by 3 heals nothing yet
// and keeps the 3; the next one overflowing by 2 pays out. Without it the Perk
// would be worth almost nothing to anybody whose Stamina die is small, since a
// single roll rarely clears the cap by 5 on its own — and "for every 5" reads as
// a running total rather than as a per-roll test. The bank is per grant and
// scoped to the fight, so it does not follow anybody into the next one.
//
// Which Stat is not this file's business: the seam says the rate, and the engine
// picks at random among the Stats actually damaged — the same division of labour
// Healing Factor already has.
export default {
  name: 'Tip Top Shape',
  description:
    'You are never anything but ready. For every 5 Stamina you would recover above your Maximum, one Step of Damage heals on a random damaged Stat instead — and recovery that does not reach 5 is saved toward the next one.',

  staminaOverflowHealing: () => ({ perStamina: 5, steps: 1 }),
};
