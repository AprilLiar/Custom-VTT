// **Last Breath Taker** — Tier 2, the `splashDamage` seam. Piercing Headache's
// twin, one Stat pair over: body damage takes the wind with it.
//
// Same arithmetic and the same reasons — see piercingHeadache.js for why Full
// Damage is two Half-Damage steps and why the seam is asked per blow.
//
// **Stamina is a Stat here, not the bar.** The eight dice include a Stamina
// die, and that is what takes the half-step; the fighter's Stamina *pool* is a
// different thing entirely and is untouched.
import { splashSteps } from '../combatDamage.js';

export default {
  name: 'Last Breath Taker',
  description:
    'You knock the air out of people. For every Full Damage dealt to the Body of the target with a single Attack, deal Half-Damage to their Stamina.',

  splashDamage: ({ appliedBySlot }) => {
    const steps = splashSteps(appliedBySlot?.Body ?? 0);
    return steps ? [{ slotName: 'Stamina', steps }] : [];
  },
};
