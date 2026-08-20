// **Healing Factor** — Tier 2, the `roundStartHalfHealing` seam.
//
// The seam answers **how many** pending Half-Damage markers to clear, and
// nothing else: the engine picks which ones, at random, and says so in the Chat
// Log (see openRoundForCharacters in roundResolution.js). Two Perks answering
// this seam clear two markers, and neither file has to know the other exists.
//
// **It clears a pending marker and never steps a die back up (decided).** A Stat
// that has taken a whole step down is not showing a marker any more, and this
// Perk does not reach it — so a fighter with no pending half-damage anywhere
// heals nothing that round, however badly hurt they are. That is the narrow
// reading of "1 instance of Half-Damage", chosen over the broader one on
// purpose: recovering whole steps is what the Recover Stat effect is for.
export default {
  name: 'Healing Factor',
  description:
    'You knit back together faster than you come apart. At Round Start, one instance of Half-Damage is removed from you at random.',

  roundStartHalfHealing: () => 1,
};
