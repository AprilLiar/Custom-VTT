// Flat, always-on modifiers folded into a seated character's every roll
// while a fight is underway. Kept in their own module rather than duplicated
// across server/index.js and server/roundResolution.js (as this codebase's
// other shared orchestration helpers had to be, because index.js boots a
// real server on import) — nothing here closes over `io` or a socket, so it
// is import-safe and both sides can just use it.

import { all, one, run } from './db.js';
import { buildBeats, matchupStyles, pairScore } from '../client/src/lib/matchups.js';
import { grapplePenaltyAt } from './grappleLogic.js';
import { perkRollBonusTerms } from './perkEngine.js';
import { effectiveTagNames, punisherBonus, punisherStats } from './tagAutomations.js';

// A move's Tag names as they apply to ONE character — the template's own tags
// plus/minus whatever Perks have added or removed for them
// (character_move_tags). Tag automation has to read the resolved set, or a Perk
// that grants the Block Tag would show up on the Moves tab and change nothing in
// a fight. Mirrors the effective_tag_ids resolution in server/index.js, on names
// instead of ids (see tagAutomations.js on why names).
//
// **Lives here rather than in roundResolution.js** (which is where it used to
// be, and which re-exports it for server/index.js's move:declare): the Punisher
// Tag is read at the shared roll-modifier funnel below, and this module is
// imported by roundResolution rather than the other way round.
export async function moveTagNamesFor(characterId, moveId) {
  const [own, overrides] = await Promise.all([
    all('SELECT t.name FROM move_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.move_id = ?', [moveId]),
    all(
      `SELECT cmt.action, t.name AS tag_name
       FROM character_move_tags cmt JOIN tags t ON t.id = cmt.tag_id
       WHERE cmt.character_id = ? AND cmt.move_id = ?`,
      [characterId, moveId]
    ),
  ]);
  return effectiveTagNames({ moveTagNames: own.map((r) => r.name), overrides });
}

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
//   - the character isn't seated in a pair whose fight has actually started.
//   - their side of that pair faces anything other than exactly one
//     opponent. With more than one enemy there is no single stance to score
//     against, and handing the outnumbered fighter a bonus per opponent (or
//     averaging them) would be a new rule nobody asked for.
//
// **The Uneven Combat toggle is NOT one of those conditions (bugfix).** This
// used to return 0 for everyone the moment the toggle was on, anywhere in the
// fight — but the toggle only *permits* lopsided pairs, it does not make any
// particular pair lopsided. A plain 1v1 with the toggle enabled has exactly
// one stance on each side and a perfectly well-defined matchup, and silently
// zeroing it took the modifier out of every roll in that fight as well as the
// badge off the VS divider. The opponent count below is the real rule and
// already answers the genuinely-uneven case on its own.
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
export async function getStanceMatchupBonus(characterId, opts = {}) {
  return (await stanceMatchupParts(characterId, opts)).total;
}

// **Stats the Stance matchup does not reach (decided, new).** The matchup
// scores what two fighters' STYLES do to each other — it is a fact about an
// exchange of blows. Two of the eight Stats are not part of that exchange:
//
//   - **Brain** is thinking. Reading the room, going first, keeping your head.
//   - **Stamina** is your engine. It does not care what stance you took.
//
// A roll made of nothing but those two therefore gets no matchup, in either
// direction — no stance score and no Combat Style, which are two halves of the
// same term.
export const MATCHUP_EXEMPT_SLOTS = ['Brain', 'Stamina'];

// Does the matchup apply to a roll of these slots?
//
// **Only a roll made ENTIRELY of exempt Stats is exempt**, and that asymmetry
// is the point: a move rolling Skull + Brain is still a punch, and letting it
// shed the matchup by naming Brain would turn the exemption into a loophole
// worth building moves around. An empty/unknown slot list (a Custom Roll, a
// hand-thrown roll with nothing to name) keeps the matchup, which is the
// behaviour every one of those paths already had.
//
// Pure, so the rule can be pinned without a socket.
export function matchupAppliesToSlots(slotNames) {
  const slots = (slotNames ?? []).filter(Boolean);
  if (!slots.length) return true;
  return !slots.every((slot) => MATCHUP_EXEMPT_SLOTS.includes(slot));
}

// The matchup split into the two things it is actually made of: what the two
// STANCES are worth against each other (plus whatever the opponent's own move
// contributes, which is theirs and not attributable to this fighter's choice),
// and what THIS roll's move added on top by carrying a Combat Style.
//
// Separated because the cutscene log now says so out loud (decided, new): a
// Combat Style can swing a roll several points and it used to vanish into one
// unexplained "Modifier: +5", which read as the engine inventing numbers. The
// sum is unchanged — this only makes the halves nameable.
async function stanceMatchupParts(
  characterId,
  { requireActiveFight = true, moveId = null, includeMoveStyles = true, tic = null } = {}
) {
  const none = { total: 0, stance: 0, moveStyle: 0, moveStyleId: null };
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
  if (!seat) return none;

  const opponents = await all(
    'SELECT character_id AS characterId FROM combat_participants WHERE pair_index = ? AND side != ?',
    [seat.pairIndex, seat.side]
  );
  if (opponents.length !== 1) return none;
  const opponentId = opponents[0].characterId;

  const [mine, theirs] = await Promise.all([
    activeStanceOf(characterId),
    activeStanceOf(opponentId),
  ]);
  if (!mine || !theirs) return none;

  const atTic = tic ?? seat.currentTic;
  const [myMoveStyle, theirMoveStyle] = includeMoveStyles
    ? await Promise.all([
        moveId != null ? combatStyleOfMove(moveId) : combatStyleInPlay(characterId, atTic),
        combatStyleInPlay(opponentId, atTic),
      ])
    : [null, null];

  const { beats } = await rulesetTables();
  const myStance = [mine.attribute_a_id, mine.attribute_b_id];
  const theirSide = matchupStyles([theirs.attribute_a_id, theirs.attribute_b_id], theirMoveStyle);
  const withoutMyMove = pairScore(myStance, theirSide, beats);
  const total = pairScore(matchupStyles(myStance, myMoveStyle), theirSide, beats);
  return {
    total,
    stance: withoutMyMove,
    moveStyle: total - withoutMyMove,
    moveStyleId: myMoveStyle ?? null,
  };
}

// **The ruleset's own two tables, read once per process (decided, new).**
//
// `attributes` and `attribute_counters` are the seven Styles and the counter
// grid between them. Every combat snapshot read both of them — twice, in the
// case of a snapshot that also scores a pair — and they are the one thing in
// this database that genuinely cannot change while the server is running:
// `seedRuleset` in db.js is the only writer, and it runs at boot before
// anything can ask.
//
// So this is a memo rather than a cache: there is no invalidation, because
// there is no second writer to invalidate against. Restarting the server is
// what picks up a ruleset change, which is already true of the seed itself.
let rulesetPromise = null;

function rulesetTables() {
  rulesetPromise ??= (async () => {
    const [counters, attributes] = await Promise.all([
      all('SELECT attacker_attribute_id, defender_attribute_id, bonus FROM attribute_counters'),
      all('SELECT id, name FROM attributes'),
    ]);
    return {
      beats: buildBeats(counters),
      nameById: new Map(attributes.map((a) => [a.id, a.name])),
      // The raw rows as well as the name lookup: getPairStanceMatchup scores
      // every Style in the ruleset for its per-move deltas and needs to iterate
      // them. Leaving this out is what broke the Arena — the memo replaced a
      // local `attributes` binding that a closure further down still used, so
      // the endpoint threw `attributes is not defined` for any pair where a
      // seated fighter had an active stance, and only then.
      attributes,
    };
  })();
  return rulesetPromise;
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
// Returns null whenever the matchup rule does not apply at all (a side that
// isn't exactly one fighter, a missing stance), so the UI can render nothing
// rather than a misleading 0. **Not gated on the Uneven Combat toggle** — see
// getStanceMatchupBonus above for why that gate was wrong and removed; this
// function's own one-per-side check is the rule, and it answers the actually-
// uneven pairs the toggle exists to allow.
export async function getPairStanceMatchup(pairIndex) {
  const seats = await all(
    'SELECT character_id AS characterId, side FROM combat_participants WHERE pair_index = ?',
    [pairIndex]
  );
  const left = seats.filter((s) => s.side === 'left');
  const right = seats.filter((s) => s.side === 'right');
  if (!left.length || !right.length) return null;

  // **Every fighter against every opponent, not just the 1v1 pair (decided,
  // widened).** This used to return null outright unless each side held exactly
  // one person, which meant an Uneven Combat showed no matchup anywhere — the
  // rule still applied to the rolls, it was simply never displayed. Stances are
  // read for everyone seated here and the per-opponent scores are built below;
  // the 1v1 fields at the bottom are unchanged and still only present when the
  // pair really is one against one, so nothing that reads them had to change.
  const stanceByChar = new Map(
    await Promise.all(
      seats.map(async (seat) => [seat.characterId, await activeStanceOf(seat.characterId)])
    )
  );

  const { beats, nameById, attributes } = await rulesetTables();
  const stylesOf = (characterId) => {
    const stance = stanceByChar.get(characterId);
    return stance ? [stance.attribute_a_id, stance.attribute_b_id] : null;
  };
  // Names ride along so the Arena can label the matchup without fetching the
  // ruleset and re-deriving what the server just computed.
  const namesOf = (ids) => ids.map((id) => nameById.get(id)).filter(Boolean);

  // **What each possible Combat Style would add, per side (new).** A move may
  // carry a Combat Style of its own, which joins its user's stance for the
  // scoring — so the same move is worth a different number depending on who is
  // holding it and who they are facing, and until now the only way to find that
  // number out was to declare the move and watch the roll.
  //
  // Computed here, per side, for every style in the ruleset rather than for one
  // move: the declare picker needs it for a whole list of moves at once, the
  // attributes table is a handful of rows, and this is the one place that
  // already holds both stances and the counter chart. The client looks its move
  // up by `combat_style_attribute_id` and shows the delta.
  //
  // **Scored against the opponent's STANCE only**, exactly like `score` itself
  // (see this function's own comment): during Declaration nothing has revealed,
  // so what the other side's move contributes is unknowable — and a number that
  // changed as their moves came and went would be unreadable anyway.
  const deltasFor = (mineStyles, theirStyles) => {
    const base = pairScore(mineStyles, theirStyles, beats);
    return attributes.map((a) => ({
      attributeId: a.id,
      name: a.name,
      delta: pairScore(matchupStyles(mineStyles, a.id), theirStyles, beats) - base,
    }));
  };

  // characterId -> opponentId -> what that specific facing is worth to them.
  // A fighter with no active stance, or an opponent without one, simply has no
  // entry for that facing — the same "drop it rather than send a 0 that reads
  // as even" rule the 1v1 shape has always followed.
  const byCharacter = {};
  for (const seat of seats) {
    const mine = stylesOf(seat.characterId);
    if (!mine) continue;
    const opponents = seat.side === 'left' ? right : left;
    for (const other of opponents) {
      const theirs = stylesOf(other.characterId);
      if (!theirs) continue;
      byCharacter[seat.characterId] ??= {};
      byCharacter[seat.characterId][other.characterId] = {
        score: pairScore(mine, theirs, beats),
        myStyleNames: namesOf(mine),
        theirStyleNames: namesOf(theirs),
        styleDeltas: deltasFor(mine, theirs),
      };
    }
  }

  // The original 1v1 shape, unchanged and still only present when the pair is
  // genuinely one against one — every existing reader keeps working, and an
  // uneven pair reads `byCharacter` instead. pairScore is antisymmetric, so one
  // call answers both sides.
  const isDuel = left.length === 1 && right.length === 1;
  const leftStyles = isDuel ? stylesOf(left[0].characterId) : null;
  const rightStyles = isDuel ? stylesOf(right[0].characterId) : null;
  const duel =
    leftStyles && rightStyles
      ? {
          leftCharacterId: left[0].characterId,
          rightCharacterId: right[0].characterId,
          leftStyles,
          rightStyles,
          leftStyleNames: namesOf(leftStyles),
          rightStyleNames: namesOf(rightStyles),
          leftStyleDeltas: deltasFor(leftStyles, rightStyles),
          rightStyleDeltas: deltasFor(rightStyles, leftStyles),
          left: pairScore(leftStyles, rightStyles, beats),
          right: -pairScore(leftStyles, rightStyles, beats),
        }
      : {};

  return { pairIndex, byCharacter, ...duel };
}

// Every always-on combat modifier for one character, summed. The one place
// to add the next such rule, so it lands in every roll path at once instead
// of whichever ones a future change remembers to touch.
// `moveId` names the move this roll belongs to, when there is one, so its
// Combat Style joins the matchup (see getStanceMatchupBonus). Omitted by the
// ad-hoc roll paths, which fall back to whatever the roller has in play.
export async function getCombatRollBonus(characterId, opts = {}) {
  return (await getCombatRollBonusBreakdown(characterId, opts)).total;
}

// The same sum, itemised — every always-on modifier as its own named term, in
// the order a person would read them out. Roll events carry this so the
// cutscene log can show what a total is made of instead of one opaque number,
// and so a Combat Style's contribution in particular is visibly its own thing
// (decided, new). Zero-valued terms are dropped: a list that says
// "Reasons to Fight +0" every round is noise, not transparency.
export async function getCombatRollBonusBreakdown(
  characterId,
  // `slotNames` is which Stats this roll is actually made of, and it exists for
  // one rule: see matchupAppliesToSlots above. Every caller that knows its
  // slots passes them; the ones that genuinely have none (a Custom Roll) omit
  // it and are unaffected.
  //
  // `declaredMoveId` names the row on the board this roll belongs to, when
  // there is one. Nothing in here reads it — it is forwarded straight to the
  // Perk seam, which needs it to answer "what did this fighter throw right
  // before this?" (Deadly Pendulum). Omitted by the hand-thrown paths, whose
  // rolls belong to no declaration.
  //
  // `againstCharacterId` is who this roll is aimed at, when the caller knows —
  // the declared move's own target for an attack, the attacker for a defensive
  // or Interruption roll. Only `opponent_next_roll_bonus` reads it, and only to
  // decide whether a credit is good here; omitting it consumes nothing rather
  // than guessing, which is what keeps an Uneven Combat honest.
  { moveId = null, tic = null, slotNames = null, declaredMoveId = null, againstCharacterId = null } = {}
) {
  // Two phases, because the Perk seam needs facts the first phase produces:
  // `reasonsToFight` is the very term Anime Protagonist doubles, and it would be
  // read twice if the seam fetched its own. Everything within each phase still
  // runs in parallel.
  const [reasons, matchup, grapple, owed, credited, punisher, sideCounts] = await Promise.all([
    getReasonsToFightBonus(characterId),
    stanceMatchupParts(characterId, { moveId, tic }),
    getGrapplePenalty(characterId, tic),
    consumeNextRollPenalty(characterId),
    consumeNextRollBonus(characterId, againstCharacterId),
    punisherRollBonus(characterId, moveId, tic),
    sideCountsFor(characterId),
  ]);
  // Perks (decided, new — see server/perks/index.js). One term per Perk
  // rather than one lump, under the Perk's own name, for the same reason the
  // Combat Style got its own line: a modifier nobody can account for reads as
  // the engine inventing numbers. Zero contributions are already dropped by
  // the resolver, so this is empty for the overwhelming majority of rolls.
  //
  // `reasonsToFight` and `sideCounts` ride along for the two Perks that ask
  // about them (Anime Protagonist, Never Tell Me the Odds): a Perk file never
  // touches the database itself — every seam answers from its context.
  const perkTerms = await perkRollBonusTerms(characterId, {
    moveId,
    tic,
    declaredMoveId,
    reasonsToFight: reasons,
    sideCounts,
  });
  // Zeroed rather than skipped, so the shape below stays one expression and a
  // future term cannot be added on the wrong side of an early return.
  const matchupApplies = matchupAppliesToSlots(slotNames);
  const stanceTerm = matchupApplies ? matchup.stance : 0;
  const styleTerm = matchupApplies ? matchup.moveStyle : 0;
  const matchupTotal = matchupApplies ? matchup.total : 0;
  const styleName =
    matchup.moveStyleId != null
      ? (await one('SELECT name FROM attributes WHERE id = ?', [matchup.moveStyleId]))?.name ?? null
      : null;
  const terms = [
    { key: 'reasons', label: 'Reasons to Fight', amount: reasons },
    { key: 'stance', label: 'Stance matchup', amount: stanceTerm },
    { key: 'combat_style', label: styleName ? `Combat Style: ${styleName}` : 'Combat Style', amount: styleTerm },
    { key: 'grapple', label: 'Held in a grapple', amount: grapple },
    { key: 'next_roll_penalty', label: 'Weakened', amount: -owed },
    // Named for what it is from the roller's side: an opening somebody left
    // them. The label has to be as accountable as every other term here — a
    // modifier nobody can explain reads as the engine inventing numbers.
    { key: 'next_roll_bonus', label: 'Opening', amount: credited },
    // **Named with the Stat AND the move it caught.** "Punisher: Body" was
    // already better than a bare +2; "Punisher: Body (Mira's Low Kick)" is what
    // makes the Tag auditable at the table — it was reported as firing when it
    // should not, and a modifier that cannot say what it is reacting to leaves
    // nobody able to tell a wide rule from a wrong one.
    {
      key: 'punisher',
      label: punisher.stat
        ? `Punisher: ${punisher.stat}${punisher.moveName ? ` (${punisher.moveName})` : ''}`
        : 'Punisher',
      amount: punisher.amount,
    },
    ...perkTerms,
  ].filter((t) => t.amount !== 0);
  const perkTotal = perkTerms.reduce((sum, t) => sum + t.amount, 0);
  return {
    total: reasons + matchupTotal + grapple - owed + credited + punisher.amount + perkTotal,
    terms,
  };
}

// The `opponent_next_roll_penalty` automation's debt: read it and spend it in
// one go (see characters.pending_roll_penalty). Returns the points owed, as a
// positive number — the caller subtracts.
//
// **This is the one modifier in here that is consumed rather than re-read**,
// which is exactly why it lives at this single funnel: every roll a character
// actually makes comes through `getCombatRollBonusBreakdown` — the engine's
// move rolls, the defensive roll, the Interruption roll, and the three hand-
// thrown paths in server/index.js — and each of them calls it exactly once per
// roll. Spending it anywhere else would mean finding all six again, and
// spending it twice would be worse.
//
// **The per-round Initiative roll is deliberately NOT one of them** (assumed —
// worth confirming). It reads getStanceMatchupBonus directly rather than this,
// so it never sees the debt. Taken literally, "the next roll of any kind"
// would include it, and then a penalty applied mid-round would be paid off by
// the *next round's* Initiative before its victim ever threw a move — which
// would make the automation almost impossible to actually feel. The reading
// here is "the next roll they make", where Initiative is bookkeeping the round
// does on their behalf.
async function consumeNextRollPenalty(characterId) {
  const row = await one('SELECT pending_roll_penalty AS n FROM characters WHERE id = ?', [characterId]);
  const owed = row?.n ?? 0;
  if (!owed) return 0;
  await run('UPDATE characters SET pending_roll_penalty = 0 WHERE id = ?', [characterId]);
  return owed;
}

// The `opponent_next_roll_bonus` automation's credit — the mirror of the debt
// above, and the one difference is the whole rule: **it is only good against the
// fighter who handed it over.**
//
// So it is consumed only when the caller knows who this roll is aimed at and
// that answer matches. A roll with no opponent in it — a hand-thrown Stat roll,
// a Weapon check, an Initiative roll — consumes nothing and leaves the credit
// standing: "their next roll against you" has not happened yet, and spending it
// on a roll that was never against you is exactly the bug this table exists to
// prevent. Same reasoning in an Uneven Combat, where the fighter beside you gets
// nothing out of a guard you dropped.
//
// Consumed at the same single funnel as the penalty, and once per roll, for the
// same reason: six call sites each spending it themselves is six chances to
// spend it twice.
async function consumeNextRollBonus(characterId, againstCharacterId) {
  if (againstCharacterId == null) return 0;
  const row = await one(
    'SELECT amount AS n FROM pending_roll_bonuses WHERE character_id = ? AND against_character_id = ?',
    [characterId, againstCharacterId]
  );
  const owed = row?.n ?? 0;
  if (!owed) return 0;
  await run('DELETE FROM pending_roll_bonuses WHERE character_id = ? AND against_character_id = ?', [
    characterId,
    againstCharacterId,
  ]);
  return owed;
}

// How many fighters are on each side of this character's own pair — theirs and
// mine. Read by Never Tell Me the Odds, which is about being outnumbered *here*
// rather than about the Uneven Combat toggle: that toggle only permits lopsided
// pairs, it does not make any particular one lopsided, and reading it would hand
// the bonus to a fighter in a perfectly even 1v1 elsewhere in the same fight.
//
// `{ mine: 0, theirs: 0 }` for anybody not seated, so a Perk can compare without
// a null check.
async function sideCountsFor(characterId) {
  const seat = await one(
    'SELECT pair_index AS pairIndex, side FROM combat_participants WHERE character_id = ?',
    [characterId]
  );
  if (!seat) return { mine: 0, theirs: 0 };
  const rows = await all('SELECT side FROM combat_participants WHERE pair_index = ?', [seat.pairIndex]);
  return {
    mine: rows.filter((r) => r.side === seat.side).length,
    theirs: rows.filter((r) => r.side !== seat.side).length,
  };
}

// **Punisher — (Stat)**: +2 while the opponent is mid-move with the named Stat
// in its Roll.
//
// The window is the opponent's whole footprint — **Startup, Active and
// Recovery** — which is wider than anything else in here reads. `placement_tic`
// rather than `reveal_tic` is what makes Startup count: a move being wound up
// is exactly the thing a Punisher is built to catch.
//
// **A move still hidden by a Feint is not punished**, and that is a rule rather
// than an oversight: the +2 lands as a named term on a roll the whole table
// sees, so paying it out of a concealed move would announce what that move rolls
// — the one fact the Feint exists to hide. The move becomes punishable the
// instant it reveals, like everything else about it.
//
// Every opponent on the far side of the pair counts, not just a chosen target:
// the Tag says "while fighting somebody who is throwing this", and in an Uneven
// Combat there is more than one somebody.
async function punisherRollBonus(characterId, moveId, tic) {
  if (moveId == null || tic == null) return { amount: 0, stat: null };
  const tagNames = await moveTagNamesFor(characterId, moveId);
  // Cheap exit for the overwhelmingly common case — no Punisher Tag on this
  // move, so neither of the two queries below is worth making.
  if (punisherStats(tagNames).size === 0) return { amount: 0, stat: null };
  const seat = await one(
    'SELECT pair_index AS pairIndex, side FROM combat_participants WHERE character_id = ?',
    [characterId]
  );
  if (!seat) return { amount: 0, stat: null };
  const rows = await all(
    `SELECT mrs.slot_name AS slotName, m.name AS moveName, ch.name AS characterName
     FROM declared_moves dm
     JOIN moves m ON m.id = dm.move_id
     JOIN move_roll_slots mrs ON mrs.move_id = dm.move_id
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     JOIN characters ch ON ch.id = dm.character_id
     WHERE cp.pair_index = ? AND cp.side = ?
       AND dm.placement_tic <= ?
       AND dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics > ?
       AND (dm.feint_masked = 0 OR dm.reveal_tic <= ?)`,
    [seat.pairIndex, seat.side === 'left' ? 'right' : 'left', tic, tic, tic]
  );
  return punisherBonus({
    tagNames,
    opponentSlots: rows.map((r) => ({
      slotName: r.slotName,
      moveName: `${r.characterName}'s ${r.moveName}`,
    })),
  });
}

// Grappling's −2: someone held in a grapple rolls worse for as long as the
// grab's ACTIVE frames run (decided). The window's last Tic is stored on the
// seat when the grapple succeeds (grapplePenaltyWindowEnd in
// server/grappleLogic.js); null means nobody has hold of them.
//
// **Read at `tic`, not at combat_pairs.current_tic.** That column is only
// written *after* a Tic finishes processing, so during resolution it lags one
// behind — reading it here would apply the penalty a Tic late at one end of
// the window and a Tic early at the other. Every engine roll site threads its
// own `tic` in for exactly this reason (see getStanceMatchupBonus's note).
//
// A roll made outside combat has no Tic and therefore no window to be inside.
async function getGrapplePenalty(characterId, tic) {
  if (tic == null) return 0;
  const seat = await one(
    'SELECT grapple_penalty_until_tic AS untilTic FROM combat_participants WHERE character_id = ?',
    [characterId]
  );
  return grapplePenaltyAt({ penaltyUntilTic: seat?.untilTic ?? null, tic });
}
