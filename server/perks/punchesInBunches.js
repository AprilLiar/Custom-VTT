// **Punches in Bunches** — Tier 2, the `staminaCostDelta` seam.
//
// Throw a punch off the back of another punch and the second one comes cheap.
// The first Perk to care about what the fighter did BEFORE this move, which is
// why the seam context grew a `getPreviousMove()` (see perkEngine.js).
//
// **"Right after" is the queue, not the clock** — the same reading Requirements
// already run on (requirementSatisfiedBy) and the same one Deadly Pendulum
// uses: the move this character has queued immediately before, by footprint
// end. That is also the only reading available here, because a Stamina Cost is
// quoted and charged during Declaration, before a single Tic has resolved.
//
// It stacks by its nature and deliberately has no cap: a third punch after a
// second is still a punch after a punch. What limits it is the board — each one
// has to fit after the last, and every punch you string together is Tics you
// are not guarding with.
//
// **A Hand Attack is a move whose ROLL uses a Hand** (decided; see isHandAttack
// in moveLogic.js for why the Attack Target would have been the wrong column).
import { isHandAttack } from '../moveLogic.js';

export default {
  name: 'Punches in Bunches',
  description:
    'You throw in combinations, not singles. Making a Hand Attack right after another Hand Attack reduces that Attack’s Stamina Cost by 1.',

  staminaCostDelta: async ({ move, getPreviousMove }) => {
    // Cheapest test first: most moves being priced are not punches at all, and
    // answering those without touching the database is what keeps the declare
    // picker to one extra query for a whole move list.
    if (!isHandAttack(move)) return 0;
    return isHandAttack(await getPreviousMove()) ? -1 : 0;
  },
};
