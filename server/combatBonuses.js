// Flat, always-on modifiers folded into a seated character's every roll
// while a fight is underway. Kept in their own module rather than duplicated
// across server/index.js and server/roundResolution.js (as this codebase's
// other shared orchestration helpers had to be, because index.js boots a
// real server on import) — nothing here closes over `io` or a socket, so it
// is import-safe and both sides can just use it.

import { all, one } from './db.js';
import { buildBeats, matchupStyles, pairScore } from '../client/src/lib/matchups.js';

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
// **Combat Styles (decided, new)** join this on top. A move may carry its own
// style, which is added to its user's stance for the scoring — three styles
// against three, duplicates kept (see matchupStyles). Both sides contribute
// their own move: a styled attack met by a styled guard is scored as what
// both fighters are actually doing, not as one side's commitment against the
// other's bare stance.
//
// Which move counts for a fighter:
//   - `moveId`, when the caller knows it. Every engine roll does — it is
//     rolling *for* a specific declared move, so there is no guessing.
//   - otherwise, whatever they are visibly doing at the pair's current Tic:
//     their revealed declared move whose footprint covers it, freshest first
//     if somehow more than one does. That covers a manual roll made mid-round
//     and, on the other side, the opponent — whose move we are never handed.
//
// `includeMoveStyles: false` turns all of that off for the round's Initiative
// Brain roll, which is not a move's roll at all: it happens as the round
// opens, before anything this round is declared, and letting a move still
// running from last round tilt it would be a rule nobody asked for.
//
// `tic` is the Tic the caller is resolving. It matters: combat_pairs.
// current_tic is written only AFTER a Tic finishes processing (see
// advancePairResolution's crash-recovery ordering), so during resolution it
// lags a Tic behind, and reading it here made the opponent's just-revealed
// move look like it wasn't out yet. Every engine roll passes its own Tic;
// manual rolls omit it and fall back to current_tic, which is accurate
// precisely because no resolution is mid-flight when a human clicks a die.
export async function getStanceMatchupBonus(
  characterId,
  { requireActiveFight = true, moveId = null, includeMoveStyles = true, tic = null } = {}
) {
  const state = await one('SELECT uneven_combat_enabled FROM combat_state WHERE id = 1');
  if (!state || state.uneven_combat_enabled) return 0;

  const seat = requireActiveFight
    ? await one(
        `SELECT cp.pair_index AS pairIndex, cp.side AS side, pr.current_tic AS currentTic
         FROM combat_participants cp
         JOIN combat_pairs pr ON pr.pair_index = cp.pair_index
         WHERE cp.character_id = ? AND pr.phase IS NOT NULL`,
        [characterId]
      )
    : await one(
        `SELECT cp.pair_index AS pairIndex, cp.side AS side, pr.current_tic AS currentTic
         FROM combat_participants cp
         LEFT JOIN combat_pairs pr ON pr.pair_index = cp.pair_index
         WHERE cp.character_id = ?`,
        [characterId]
      );
  if (!seat) return 0;

  const opponents = await all(
    'SELECT character_id AS characterId FROM combat_participants WHERE pair_index = ? AND side != ?',
    [seat.pairIndex, seat.side]
  );
  if (opponents.length !== 1) return 0;
  const opponentId = opponents[0].characterId;

  const [mine, theirs] = await Promise.all([
    activeStanceOf(characterId),
    activeStanceOf(opponentId),
  ]);
  if (!mine || !theirs) return 0;

  const atTic = tic ?? seat.currentTic;
  const [myMoveStyle, theirMoveStyle] = includeMoveStyles
    ? await Promise.all([
        moveId != null ? combatStyleOfMove(moveId) : combatStyleInPlay(characterId, atTic),
        combatStyleInPlay(opponentId, atTic),
      ])
    : [null, null];

  const counters = await all(
    'SELECT attacker_attribute_id, defender_attribute_id, bonus FROM attribute_counters'
  );
  return pairScore(
    matchupStyles([mine.attribute_a_id, mine.attribute_b_id], myMoveStyle),
    matchupStyles([theirs.attribute_a_id, theirs.attribute_b_id], theirMoveStyle),
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

async function combatStyleOfMove(moveId) {
  const row = await one('SELECT combat_style_attribute_id AS styleId FROM moves WHERE id = ?', [moveId]);
  return row?.styleId ?? null;
}

// The Combat Style of what this fighter is visibly doing at `tic`: a declared
// move that has already revealed (a secret move contributes nothing — it
// would leak, and it isn't out yet) and whose full footprint still covers the
// Tic. Ordered so the most recently revealed wins, since a fighter may have
// several moves queued and the freshest is the one they are committing to.
async function combatStyleInPlay(characterId, tic) {
  if (tic == null) return null;
  const row = await one(
    `SELECT m.combat_style_attribute_id AS styleId
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
     WHERE dm.character_id = ? AND dm.reveal_posted = 1
       AND dm.reveal_tic <= ?
       AND dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics > ?
     ORDER BY dm.reveal_tic DESC, dm.id DESC
     LIMIT 1`,
    [characterId, tic, tic]
  );
  return row?.styleId ?? null;
}

// The stance-only matchup for one pair, both sides, for display rather than
// for a roll — the Arena's VS divider (see CombatArena.jsx) shows each
// fighter what the stance they are facing is worth before anyone commits a
// move. Deliberately stance-only: it is a standing fact about the two
// fighters, visible during Declaration when nothing has revealed yet, and a
// number that flickered as moves came and went would be unreadable.
//
// Returns null whenever the matchup rule does not apply at all (Uneven
// Combat, a side that isn't exactly one fighter, a missing stance), so the UI
// can render nothing rather than a misleading 0.
export async function getPairStanceMatchup(pairIndex) {
  const state = await one('SELECT uneven_combat_enabled FROM combat_state WHERE id = 1');
  if (!state || state.uneven_combat_enabled) return null;

  const seats = await all(
    'SELECT character_id AS characterId, side FROM combat_participants WHERE pair_index = ?',
    [pairIndex]
  );
  const left = seats.filter((s) => s.side === 'left');
  const right = seats.filter((s) => s.side === 'right');
  if (left.length !== 1 || right.length !== 1) return null;

  const [leftStance, rightStance] = await Promise.all([
    activeStanceOf(left[0].characterId),
    activeStanceOf(right[0].characterId),
  ]);
  if (!leftStance || !rightStance) return null;

  const [counters, attributes] = await Promise.all([
    all('SELECT attacker_attribute_id, defender_attribute_id, bonus FROM attribute_counters'),
    all('SELECT id, name FROM attributes'),
  ]);
  const nameById = new Map(attributes.map((a) => [a.id, a.name]));
  const leftStyles = [leftStance.attribute_a_id, leftStance.attribute_b_id];
  const rightStyles = [rightStance.attribute_a_id, rightStance.attribute_b_id];
  const score = pairScore(leftStyles, rightStyles, buildBeats(counters));
  // Names ride along so the Arena can label the matchup without fetching the
  // ruleset and re-deriving what the server just computed.
  const namesOf = (ids) => ids.map((id) => nameById.get(id)).filter(Boolean);
  // pairScore is antisymmetric — scoring the other direction is exactly the
  // negation — so one call answers both sides.
  return {
    pairIndex,
    leftCharacterId: left[0].characterId,
    rightCharacterId: right[0].characterId,
    leftStyles,
    rightStyles,
    leftStyleNames: namesOf(leftStyles),
    rightStyleNames: namesOf(rightStyles),
    left: score,
    right: -score,
  };
}

// Every always-on combat modifier for one character, summed. The one place
// to add the next such rule, so it lands in every roll path at once instead
// of whichever ones a future change remembers to touch.
// `moveId` names the move this roll belongs to, when there is one, so its
// Combat Style joins the matchup (see getStanceMatchupBonus). Omitted by the
// ad-hoc roll paths, which fall back to whatever the roller has in play.
export async function getCombatRollBonus(characterId, { moveId = null, tic = null } = {}) {
  const [reasons, stance] = await Promise.all([
    getReasonsToFightBonus(characterId),
    getStanceMatchupBonus(characterId, { moveId, tic }),
  ]);
  return reasons + stance;
}
