// **Piercing Headache** — Tier 2, the `splashDamage` seam.
//
// Rattle someone's skull hard enough and their thinking goes with it. Every
// FULL point of damage this attack put on the target's Skull sends half a point
// into their Brain.
//
// **Full Damage is two Half-Damage steps** — the game counts in halves, and two
// halves make a whole (see the Damage section of game_rules.md). So the splash
// is `floor(skullSteps / 2)` half-steps: 1.0 to the Skull is 0.5 to the Brain,
// 2.5 to the Skull is 1.0, and anything under a full point is nothing.
//
// **Per attack, not per round.** The seam is asked once per blow with what that
// blow landed, so two separate half-point hits in a round never add up into a
// splash — "with a single Attack" is the rule, and this is the shape that keeps
// it true without any state to remember.
import { splashSteps } from '../combatDamage.js';

export default {
  name: 'Piercing Headache',
  description:
    'You hit hard enough to rattle what is behind the bone. For every Full Damage dealt to the Skull of the target with a single Attack, deal Half-Damage to their Brain.',

  splashDamage: ({ appliedBySlot }) => {
    const steps = splashSteps(appliedBySlot?.Skull ?? 0);
    return steps ? [{ slotName: 'Brain', steps }] : [];
  },
};
