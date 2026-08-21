// **The Simplest Tool** — Tier 2, on two seams at once (`staminaCostDelta` and
// `rollBonus`). The first Perk to hold both, and it works precisely because
// every seam is folded independently: the discount is asked for at declare
// time and the bonus at roll time, and neither knows about the other.
//
// **Bound to a move by name, exactly** (decided) — trimmed and case-insensitive
// like every other name binding in this codebase (`perkDefinition`,
// `hasTagNamed`), but exact otherwise. A move called "Jab" is the Jab; "Power
// Jab" and "Jab!" are different moves and get nothing. There is no Jab in the
// Compendium out of the box: the GM writes one, and this finds it.
//
// **`getMove()` returning null is the important case.** Not every roll belongs
// to a move — a hand-thrown die, the round's own Initiative roll — and those
// must not collect the bonus. The thunk answers null for them, and moveNameIs
// says no to null, so the gate is the same one line in both seams.
import { moveNameIs } from '../moveLogic.js';

const JAB = 'Jab';

export default {
  name: 'The Simplest Tool',
  description:
    'The jab is the whole game. Your Jab costs 1 less Stamina and rolls with a +1 Bonus to the Attack.',

  staminaCostDelta: ({ move }) => (moveNameIs(move, JAB) ? -1 : 0),

  // Rides the roll's own modifierBreakdown under this Perk's name, like every
  // rollBonus does — a Perk that moves a total has to be readable in the
  // breakdown or it is indistinguishable from the engine inventing numbers.
  rollBonus: async ({ getMove }) => (moveNameIs(await getMove(), JAB) ? 1 : 0),
};
