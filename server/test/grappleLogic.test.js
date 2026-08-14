// Grappling's pure rules (server/grappleLogic.js). Same shape and the same
// reasoning as combatDamage.test.js: the interesting decisions are pure, so
// they are provable without a socket, a database or a clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECTIONS,
  GRAPPLE_PENALTY,
  GUESS_NONE,
  GUESS_RIGHT,
  GUESS_WRONG,
  MINI_GAME_BONUS,
  assignedDirections,
  grapplePenaltyAt,
  grapplePenaltyWindowEnd,
  planChainPlacement,
  resolveGrappleContest,
  shouldRunMiniGame,
} from '../grappleLogic.js';

// ---------- the contest ----------

test('a grapple must clear the threshold AND beat the target', () => {
  // The two conditions are independent, so all four corners are worth pinning.
  assert.equal(resolveGrappleContest({ grapplerTotal: 8, targetTotal: 3 }).success, true);
  assert.equal(resolveGrappleContest({ grapplerTotal: 4, targetTotal: 3 }).success, false);
  assert.equal(resolveGrappleContest({ grapplerTotal: 8, targetTotal: 12 }).success, false);
  assert.equal(resolveGrappleContest({ grapplerTotal: 4, targetTotal: 12 }).success, false);
});

test('the two ways of failing are reported differently', () => {
  // A fumbled grab and one the target out-muscled are different events at the
  // table, and the log has to be able to say which.
  assert.equal(resolveGrappleContest({ grapplerTotal: 4, targetTotal: 3 }).reason, 'below-threshold');
  assert.equal(resolveGrappleContest({ grapplerTotal: 8, targetTotal: 12 }).reason, 'outrolled');
  assert.equal(resolveGrappleContest({ grapplerTotal: 8, targetTotal: 3 }).reason, 'success');
});

test('the threshold is checked before the comparison', () => {
  // A grapple under its own threshold fails even against a target who rolled
  // nothing at all — you cannot fumble your way into a hold.
  const r = resolveGrappleContest({ grapplerTotal: 2, targetTotal: 0 });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'below-threshold');
});

test('a tie goes to the target', () => {
  // Being equally strong is not enough to take someone down.
  const r = resolveGrappleContest({ grapplerTotal: 9, targetTotal: 9 });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'outrolled');
});

test('the move carries its own threshold', () => {
  assert.equal(resolveGrappleContest({ grapplerTotal: 9, targetTotal: 0, successThreshold: 15 }).success, false);
  assert.equal(resolveGrappleContest({ grapplerTotal: 9, targetTotal: 0, successThreshold: 5 }).success, true);
});

// ---------- the mini-game's ±5 ----------

test('a wrong guess gives the grappler +5, on the total', () => {
  const r = resolveGrappleContest({ grapplerTotal: 7, targetTotal: 9, guessOutcome: GUESS_WRONG });
  assert.equal(r.grapplerFinal, 12);
  assert.equal(r.targetFinal, 9);
  assert.equal(r.success, true, 'the +5 is what wins it');
});

test('a right guess gives the TARGET +5', () => {
  const r = resolveGrappleContest({ grapplerTotal: 11, targetTotal: 9, guessOutcome: GUESS_RIGHT });
  assert.equal(r.grapplerFinal, 11);
  assert.equal(r.targetFinal, 14);
  assert.equal(r.success, false, 'reading it right is what saves them');
});

test('no mini-game means neither side gets anything', () => {
  const r = resolveGrappleContest({ grapplerTotal: 7, targetTotal: 9, guessOutcome: GUESS_NONE });
  assert.equal(r.grapplerFinal, 7);
  assert.equal(r.targetFinal, 9);
});

test('the +5 can rescue a roll that was under the threshold', () => {
  // It is added before the threshold check, not after — a read that good
  // turns a fumble into a hold.
  const r = resolveGrappleContest({ grapplerTotal: 3, targetTotal: 1, guessOutcome: GUESS_WRONG });
  assert.equal(r.grapplerFinal, 8);
  assert.equal(r.success, true);
});

test('the bonus is exactly one +5, never one per die', () => {
  // The engine adds a roll's *modifier* to every die separately, so a +5
  // folded in there would pay out per die and a three-die grapple would
  // quietly be worth +15. This is a total-level bonus and must stay one.
  const r = resolveGrappleContest({ grapplerTotal: 20, targetTotal: 0, guessOutcome: GUESS_WRONG });
  assert.equal(r.grapplerFinal - 20, MINI_GAME_BONUS);
});

// ---------- does the mini-game run at all ----------

test('the mini-game needs at least two assigned directions', () => {
  assert.equal(shouldRunMiniGame({ assignedDirectionCount: 0 }), false);
  assert.equal(shouldRunMiniGame({ assignedDirectionCount: 1 }), false);
  assert.equal(shouldRunMiniGame({ assignedDirectionCount: 2 }), true);
  assert.equal(shouldRunMiniGame({ assignedDirectionCount: 4 }), true);
});

test('an all-NPC grapple skips the mini-game', () => {
  // The GM would be picking a direction and then guessing against
  // themselves, which is not a game.
  assert.equal(
    shouldRunMiniGame({ assignedDirectionCount: 4, grapplerIsNpc: true, targetIsNpc: true }),
    false
  );
});

test('one NPC and one PC still play it', () => {
  assert.equal(
    shouldRunMiniGame({ assignedDirectionCount: 4, grapplerIsNpc: true, targetIsNpc: false }),
    true
  );
  assert.equal(
    shouldRunMiniGame({ assignedDirectionCount: 4, grapplerIsNpc: false, targetIsNpc: true }),
    true
  );
});

// ---------- direction bookkeeping ----------

test('assignedDirections keeps only directions carrying a move', () => {
  const rows = [
    { direction: 'up', targetMoveId: 7 },
    { direction: 'down', targetMoveId: null },
    { direction: 'left', targetMoveId: 9 },
  ];
  assert.deepEqual(assignedDirections(rows).map((r) => r.direction), ['up', 'left']);
});

test('assignedDirections renders in a stable order whatever the row order', () => {
  // The cross must always read the same way round.
  const rows = [
    { direction: 'right', targetMoveId: 3 },
    { direction: 'up', targetMoveId: 1 },
    { direction: 'down', targetMoveId: 2 },
  ];
  assert.deepEqual(assignedDirections(rows).map((r) => r.direction), ['up', 'down', 'right']);
  assert.deepEqual(DIRECTIONS, ['up', 'down', 'left', 'right']);
});

// ---------- chaining the next move in ----------

test('the chained move sits immediately after the grapple, not on a jump', () => {
  const { placementTic } = planChainPlacement({ grappleFootprintEnd: 6, chainedFootprintTics: 3 });
  assert.equal(placementTic, 6);
});

test('a later move in the way is pushed forward', () => {
  const { shifted } = planChainPlacement({
    grappleFootprintEnd: 6,
    chainedFootprintTics: 3, // occupies 6,7,8
    laterMoves: [{ declaredMoveId: 40, placementTic: 7, footprintTics: 2 }],
  });
  assert.deepEqual(shifted, [{ declaredMoveId: 40, from: 7, to: 9 }]);
});

test('a move already clear of the chain is left alone', () => {
  const { shifted } = planChainPlacement({
    grappleFootprintEnd: 6,
    chainedFootprintTics: 2, // occupies 6,7
    laterMoves: [{ declaredMoveId: 41, placementTic: 9, footprintTics: 2 }],
  });
  assert.deepEqual(shifted, []);
});

test('a shifted move displaces the next one in turn', () => {
  // The knock-on case: shifting the first move into the second's slot must
  // push the second too, recursively.
  const { shifted } = planChainPlacement({
    grappleFootprintEnd: 5,
    chainedFootprintTics: 2, // occupies 5,6
    laterMoves: [
      { declaredMoveId: 50, placementTic: 6, footprintTics: 2 },
      { declaredMoveId: 51, placementTic: 8, footprintTics: 1 },
    ],
  });
  assert.deepEqual(shifted, [
    { declaredMoveId: 50, from: 6, to: 7 },
    { declaredMoveId: 51, from: 8, to: 9 },
  ]);
});

test('planning is order-independent and does not mutate its input', () => {
  const laterMoves = [
    { declaredMoveId: 61, placementTic: 8, footprintTics: 1 },
    { declaredMoveId: 60, placementTic: 6, footprintTics: 2 },
  ];
  const snapshot = JSON.parse(JSON.stringify(laterMoves));
  const { shifted } = planChainPlacement({
    grappleFootprintEnd: 5,
    chainedFootprintTics: 2,
    laterMoves,
  });
  assert.deepEqual(shifted.map((s) => s.declaredMoveId), [60, 61]);
  assert.deepEqual(laterMoves, snapshot, 'the caller\'s array is untouched');
});

// ---------- the -2 window ----------

test('the -2 window ends on the grapple\'s last ACTIVE Tic', () => {
  // Reveal at 3 with 3 Active Tics covers 3, 4 and 5 — Recovery is not
  // included, and neither is the rest of the round.
  assert.equal(grapplePenaltyWindowEnd({ revealTic: 3, activeTics: 3 }), 5);
});

test('a move with no Active frames opens no window', () => {
  assert.equal(grapplePenaltyWindowEnd({ revealTic: 3, activeTics: 0 }), null);
});

test('the penalty applies inside the window and stops after it', () => {
  const penaltyUntilTic = 5;
  assert.equal(grapplePenaltyAt({ penaltyUntilTic, tic: 3 }), GRAPPLE_PENALTY);
  assert.equal(grapplePenaltyAt({ penaltyUntilTic, tic: 5 }), GRAPPLE_PENALTY, 'inclusive');
  assert.equal(grapplePenaltyAt({ penaltyUntilTic, tic: 6 }), 0);
});

test('no window means no penalty', () => {
  assert.equal(grapplePenaltyAt({ penaltyUntilTic: null, tic: 4 }), 0);
  assert.equal(grapplePenaltyAt({ penaltyUntilTic: 5, tic: null }), 0);
});
