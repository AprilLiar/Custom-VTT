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
// The ±5 is applied HERE, to the totals, and deliberately not to the roll
// modifier: the engine adds a roll's modifier to every die separately, so a
// +5 folded in there would pay out once per die and a two-die grapple would
// quietly be worth +10.
//
// Ties go to the target. Being equally strong is not enough to take someone
// down — the grappler has to win it.
export function resolveGrappleContest({
  grapplerTotal = 0,
  targetTotal = 0,
  successThreshold = 5,
  guessOutcome = GUESS_NONE,
} = {}) {
  const grapplerFinal = grapplerTotal + (guessOutcome === GUESS_WRONG ? MINI_GAME_BONUS : 0);
  const targetFinal = targetTotal + (guessOutcome === GUESS_RIGHT ? MINI_GAME_BONUS : 0);

  if (grapplerFinal < successThreshold) {
    return { grapplerFinal, targetFinal, success: false, reason: 'below-threshold' };
  }
  if (grapplerFinal <= targetFinal) {
    return { grapplerFinal, targetFinal, success: false, reason: 'outrolled' };
  }
  return { grapplerFinal, targetFinal, success: true, reason: 'success' };
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
