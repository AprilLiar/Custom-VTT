// Pure grappling rules (Grappling, decided — see vttprojectplan.md).
//
// A grappling move does not land or miss. It opens a four-way branch: the
// grappler picks a direction in secret, the target guesses it, whoever read
// the other correctly takes +5, and the grab is then settled by an opposed
// roll against the target's Resist Roll. Winning chains the move assigned to
// the chosen direction; losing changes nothing, because nothing was written
// until the win (see planChainPlacement).
//
// Everything here is pure — no DB, no `io`, no clock — for the same reason
// combatDamage.js and combatTiming.js are: this is the part with real rules
// in it, and rules are worth testing without standing a server up.

/** The mini-game's outcome, from the grappler's point of view. */
export const GUESS_NONE = 'none'; // no mini-game ran; nobody gets +5
export const GUESS_WRONG = 'wrong'; // target guessed wrong -> grappler +5
export const GUESS_RIGHT = 'right'; // target guessed right -> target +5

/**
 * The grappler's explicit "take it no further" answer. A real choice, not a
 * missing one: the grab has already landed and its interactions have already
 * fired, so declining costs nothing and leaves the hold in place. Kept distinct
 * from the four directions so a decline can never be confused with a guess.
 *
 * Deliberately NOT `'none'`: that is already GUESS_NONE's value, and although
 * the two live in different value spaces, sharing a literal between "the
 * grappler declined" and "no read happened" is exactly the kind of overlap that
 * reads as correct until one is compared against the other.
 */
export const DECLINE_FOLLOW_UP = 'decline';

export const MINI_GAME_BONUS = 5;
export const GRAPPLE_PENALTY = -2;
export const DIRECTIONS = ['up', 'down', 'left', 'right'];

// Whether the direction mini-game runs at all.
//
// Two independent reasons to skip it, both decided:
//   - **Fewer than 2 assigned directions.** With one branch there is nothing
//     to read and nothing to guess; with none there is no branch at all. The
//     contest still happens either way, and a single assigned direction still
//     chains on success — it just arrives without a mini-game.
//   - **Both fighters are NPCs.** The GM would be picking a direction and
//     then guessing against themselves, which is not a game. An all-NPC
//     grapple goes straight to the contest with no ±5 to either side.
export function shouldRunMiniGame({
  assignedDirectionCount = 0,
  grapplerIsNpc = false,
  targetIsNpc = false,
} = {}) {
  if (assignedDirectionCount < 2) return false;
  if (grapplerIsNpc && targetIsNpc) return false;
  return true;
}

// Which directions actually carry a move. Order follows DIRECTIONS so the
// cross always renders the same way round regardless of insertion order.
export function assignedDirections(directionRows = []) {
  const byDirection = new Map(
    directionRows
      .filter((r) => r && r.direction && r.targetMoveId != null)
      .map((r) => [r.direction, r])
  );
  return DIRECTIONS.filter((d) => byDirection.has(d)).map((d) => byDirection.get(d));
}

// The contest. **Both conditions must hold** (decided): the grapple has to
// clear its own Success Threshold AND beat the target's total. Those are
// genuinely different failures and the log says which — a grab that was
// fumbled outright reads differently from one the target simply out-muscled.
//
// **The ±5 is NOT applied here any more (decided, revised).** The contest is
// settled *before* anybody is asked which way the grab goes, so at this point
// no read has happened yet and there is nothing to reward. The ±5 now lands on
// the follow-up move's own roll instead — see chainRollBonusFor below.
//
// Ties go to the target. Being equally strong is not enough to take someone
// down — the grappler has to win it.
export function resolveGrappleContest({
  grapplerTotal = 0,
  targetTotal = 0,
  successThreshold = 5,
} = {}) {
  const grapplerFinal = grapplerTotal;
  const targetFinal = targetTotal;

  if (grapplerFinal < successThreshold) {
    return { grapplerFinal, targetFinal, success: false, reason: 'below-threshold' };
  }
  if (grapplerFinal <= targetFinal) {
    return { grapplerFinal, targetFinal, success: false, reason: 'outrolled' };
  }
  return { grapplerFinal, targetFinal, success: true, reason: 'success' };
}

// What the defender's read is worth, applied to the **follow-up's** roll
// (decided, revised — it used to move the contest instead).
//
// It is a signed swing rather than a bonus to whoever won, because by the time
// the follow-up rolls there is only one roll left to modify: the grappler's.
// Reading the grab right therefore has to make that roll *worse* rather than
// make some other roll better.
//
//   defender guessed WRONG -> they went the wrong way   -> follow-up +5
//   defender guessed RIGHT -> they read it              -> follow-up −5
//   no mini-game ran                                    -> 0
//
// Total-level, like every grapple modifier: applied once to the summed roll,
// never folded into the per-die modifier (see declared_moves.chain_roll_bonus).
export function chainRollBonusFor(guessOutcome = GUESS_NONE) {
  if (guessOutcome === GUESS_WRONG) return MINI_GAME_BONUS;
  if (guessOutcome === GUESS_RIGHT) return -MINI_GAME_BONUS;
  return 0;
}

// Which of a grapple's assigned directions the grappler can actually take,
// and why not when they can't.
//
// Two independent gates, both from the new flow: the grappler has to **own**
// the follow-up (a Default move, or one granted to them — the same rule
// getMovesFor uses), and has to be able to **afford** it right now. An
// unaffordable follow-up is the "chain ends by itself" case, surfaced as a
// reason rather than by silently vanishing, because the prompt shows every
// direction greyed with an explanation (decided).
//
// Pure: the caller supplies what it looked up. `currentStamina` is the
// grappler's stamina at the moment of the pick, already net of anything
// committed earlier this round.
export function annotateFollowUps(
  directions = [],
  { ownedMoveIds = [], currentStamina = 0 } = {}
) {
  const owned = new Set(ownedMoveIds.map(Number));
  return directions.map((d) => {
    const isOwned = Boolean(d.isDefault) || owned.has(Number(d.moveId));
    const cost = Number(d.staminaCost ?? 0);
    if (!isOwned) return { ...d, available: false, reason: 'not-owned' };
    // A negative cost *restores* Stamina, so it is always affordable.
    if (cost > 0 && currentStamina - cost < 0) {
      return { ...d, available: false, reason: 'unaffordable' };
    }
    return { ...d, available: true, reason: 'ok' };
  });
}

// Where the chained move goes, and what has to move out of its way.
//
// The chained move is placed immediately after the grappling move's own
// footprint — it does not jump the round's clock, it simply sits next in line
// (decided). Anything the grappler had queued at or after that point is
// pushed forward to make room, recursively, since each shifted move can
// displace the next.
//
// **Only ever called on a grapple that has already won.** The chained move is
// not created during the contest and neither is this shift, so there is no
// rollback: every write this plans is terminal, exactly like the forward-only
// cascadeShift it mirrors.
//
// `laterMoves` must exclude anything already revealed — a move that has
// resolved must never be shifted. The caller filters on reveal_posted.
export function planChainPlacement({
  grappleFootprintEnd,
  chainedFootprintTics = 1,
  laterMoves = [],
} = {}) {
  const placementTic = grappleFootprintEnd;
  const blockedUntil = placementTic + chainedFootprintTics;

  const ordered = [...laterMoves].sort((a, b) => a.placementTic - b.placementTic);
  const shifted = [];
  let floor = blockedUntil;
  for (const move of ordered) {
    if (move.placementTic >= floor) {
      floor = move.placementTic + move.footprintTics;
      continue;
    }
    shifted.push({
      declaredMoveId: move.declaredMoveId,
      from: move.placementTic,
      to: floor,
    });
    floor += move.footprintTics;
  }

  return { placementTic, shifted };
}

// Whether a roll made at `tic` by this participant is inside a grapple's
// -2 window. The window ends on the grappling move's last ACTIVE Tic,
// inclusive — not its Recovery, and not the end of the round.
export function grapplePenaltyAt({ penaltyUntilTic = null, tic = null } = {}) {
  if (penaltyUntilTic == null || tic == null) return 0;
  return tic <= penaltyUntilTic ? GRAPPLE_PENALTY : 0;
}

// The last Tic the -2 covers, from the grappling move's own frame data.
// Active runs from the reveal Tic for `activeTics` Tics, so the last of them
// is one before the end.
export function grapplePenaltyWindowEnd({ revealTic, activeTics = 0 } = {}) {
  if (!Number.isInteger(revealTic) || activeTics <= 0) return null;
  return revealTic + activeTics - 1;
}
