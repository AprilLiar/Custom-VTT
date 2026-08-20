// **Spiked Shell** — Tier 2, the `blockRiposteSteps` seam.
//
// Out-guard an attack and the attacker hurts themselves on you: one Half-Damage
// step for every full 5 points your guard beat their roll by. Beat them by 4 and
// nothing happens; by 12 and they take 1.0 damage.
//
// The seam answers **how much**, and nothing else. Where it lands is the
// engine's business (`selectRiposteTargets` in combatDamage.js — the limb that
// swung, both hands if they came in with both, one at random if they mixed), and
// so is the fact that it only fires on a Block that resolved **Full**. A guard
// that got scaled back because the blocker ran out of Stamina resolves Partial
// and pays nothing: you did not out-guard them, you ran out of gas.
//
// A Custom Roll names no Stat, so an attack made on one has nothing to catch on
// the spikes and this Perk does not reach it.
export default {
  name: 'Spiked Shell',
  description:
    'Your guard is not a soft place to land. When you Successfully Block, the attacker takes 0.5 damage to the limb they attacked with for every 5 points your guard beat their Attack roll by.',

  blockRiposteSteps: ({ attackerResult = 0, defenderResult = 0 } = {}) =>
    Math.max(0, Math.floor((defenderResult - attackerResult) / 5)),
};
