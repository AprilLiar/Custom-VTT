// **No Wasted Movements** — Tier 2, the `imposedRecoveryDelta` seam.
//
// "Receive 1 less Recovery Frames from all sources, other than the base Recovery
// of the Move." The exclusion is the interesting half: a move's own Recovery is
// what it costs to throw, and this Perk is not a discount on your own choices.
// What it shortens is Recovery *done to you* — a trip, an Add Recovery
// automation, a Movement Punisher, and (decided) the extension a Block earns
// when its guard held too short to cover the attack.
//
// **1 off each source, not 1 off the round.** A fighter tripped for 3 and then
// given 1 more by an automation takes 2 and 0, not 3 — which is the reading the
// sentence gives, "from all sources" being the list of things reduced rather
// than a budget. An imposition reduced to nothing simply does not happen.
export default {
  name: 'No Wasted Movements',
  description:
    'Nothing you do is wasted motion. Every Recovery frame imposed on you from any source other than a Move’s own base Recovery — a trip, an Add Recovery effect, a guard held too short — is one Tic shorter.',

  imposedRecoveryDelta: () => 1,
};
