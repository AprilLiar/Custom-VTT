// Flat, always-on modifiers folded into a seated character's every roll
// while a fight is underway. Kept in their own module rather than duplicated
// across server/index.js and server/roundResolution.js (as this codebase's
// other shared orchestration helpers had to be, because index.js boots a
// real server on import) — nothing here closes over `io` or a socket, so it
// is import-safe and both sides can just use it.

import { all, one } from './db.js';
import { buildBeats, pairScore } from '../client/src/lib/matchups.js';

// "Reasons to Fight" (see combat_participants.reasons_to_fight): +1 per
// point. "While a fight is underway" is a per-pair question (combat_pairs.
// phase set — seating for an about-to-start fight doesn't count yet), since
// each pair runs its own independent round clock.
//
// Folded in at the point each roll actually executes rather than as a
// client-side pre-fill, so it can't be bypassed by whatever a roll dialog
// happened to show.
export async function getReasonsToFightBonus(characterId) {
  const row = await one(
    `SELECT cp.reasons_to_fight AS reasons_to_fight
     FROM combat_participants cp
     JOIN combat_pairs pr ON pr.pair_index = cp.pair_index
     WHERE cp.character_id = ? AND pr.phase IS NOT NULL`,
    [characterId]
  );
  return row?.reasons_to_fight ?? 0;
}

// Stance matchup (decided, new): the counter chart stops being a thing the
// table reads off the Stances tab and applies by hand. Your active stance
// scored against your opponent's — the same `pairScore` the Best/Worst
// Matchups list already shows — becomes a flat bonus on all your rolls,
// behaving exactly like Reasons to Fight above, including being applied
// server-side at roll time.
//
// Returns 0 (not null) whenever the matchup is undefined, so callers can add
// it unconditionally:
//   - Uneven Combat is on. Decided: omitted for *every* participant, not
//     just the outnumbered side. With more than two fighters there is no
//     single enemy stance to score against, and handing the lone fighter a
//     bonus per opponent (or averaging them) would be a new rule nobody
//     asked for.
//   - the character isn't seated in a pair whose fight has actually started.
//   - their side of that pair faces anything other than exactly one
//     opponent — same reason as Uneven Combat, reached independently of the
//     toggle since the app never enforces it.
//   - either fighter has no active stance.
//
// `requireActiveFight: false` drops only the first of those, for the round's
// own initiative roll: that roll happens *while* a round is being opened,
// before the pair's combat_pairs row exists at all on a fight's first round,
// so the usual "is a fight underway" join would answer no to a question
// asked from inside the fight starting. Reasons to Fight sidesteps this by
// reading combat_participants directly, with no pair join to be too early
// for.
export async function getStanceMatchupBonus(characterId, { requireActiveFight = true } = {}) {
  const state = await one('SELECT uneven_combat_enabled FROM combat_state WHERE id = 1');
  if (!state || state.uneven_combat_enabled) return 0;

  const seat = requireActiveFight
    ? await one(
        `SELECT cp.pair_index AS pairIndex, cp.side AS side
         FROM combat_participants cp
         JOIN combat_pairs pr ON pr.pair_index = cp.pair_index
         WHERE cp.character_id = ? AND pr.phase IS NOT NULL`,
        [characterId]
      )
    : await one(
        'SELECT pair_index AS pairIndex, side AS side FROM combat_participants WHERE character_id = ?',
        [characterId]
      );
  if (!seat) return 0;

  const opponents = await all(
    'SELECT character_id AS characterId FROM combat_participants WHERE pair_index = ? AND side != ?',
    [seat.pairIndex, seat.side]
  );
  if (opponents.length !== 1) return 0;

  const [mine, theirs] = await Promise.all([
    activeStanceOf(characterId),
    activeStanceOf(opponents[0].characterId),
  ]);
  if (!mine || !theirs) return 0;

  const counters = await all(
    'SELECT attacker_attribute_id, defender_attribute_id, bonus FROM attribute_counters'
  );
  return pairScore(
    [mine.attribute_a_id, mine.attribute_b_id],
    [theirs.attribute_a_id, theirs.attribute_b_id],
    buildBeats(counters)
  );
}

function activeStanceOf(characterId) {
  return one(
    `SELECT s.attribute_a_id, s.attribute_b_id
     FROM characters ch JOIN stances s ON s.id = ch.active_stance_id
     WHERE ch.id = ?`,
    [characterId]
  );
}

// Every always-on combat modifier for one character, summed. The one place
// to add the next such rule, so it lands in every roll path at once instead
// of whichever ones a future change remembers to touch.
export async function getCombatRollBonus(characterId) {
  const [reasons, stance] = await Promise.all([
    getReasonsToFightBonus(characterId),
    getStanceMatchupBonus(characterId),
  ]);
  return reasons + stance;
}
