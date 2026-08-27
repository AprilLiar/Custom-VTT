// **Path To Mastery: Durability** — a charge, not a switch.
//
// "First 2 times in a Fight, that a Stat would be Broken, keep it at 1d4
// instead."
//
// The Stat still takes everything the blow was worth — it lands at a bare d4,
// stripped of every bonus, exactly where a break would have left it — it simply
// does not go out. So this buys the two worst moments of a fight, not two free
// hits: a d4 Stat is one more half-step from breaking anyway.
//
// **Two charges, spent by the engine rather than by the Perk.** The seam
// answers how many and over what window; `perkAbsorbBreak` is what actually
// spends one, because only the damage loop knows a break really happened. A
// Perk that decremented its own counter would have to be told about breaks it
// did not prevent.
//
// Fight-scoped, through the same store Second Wind's once-per-round charge and
// Never Empty-Handed's once-per-Fight one already use — so it refills when a
// fight ends, not when a round does.
export default {
  name: 'Path To Mastery: Durability',
  description:
    'The first 2 times in a Fight that a Stat of yours would be Broken, it is kept at 1d4 instead.',

  absorbsBreak: () => ({ charges: 2, scope: 'fight' }),
};
