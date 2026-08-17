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
  annotateFollowUps,
  assignedDirections,
  chainRollBonusFor,
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

// ---------- the contest is now clean of the ±5 ----------

test('the contest ignores the read entirely (decided, revised)', () => {
  // The contest is settled BEFORE anyone is asked which way the grab goes, so
  // there is no read yet to reward. These four tests used to assert the ±5
  // moved these totals; they now assert it cannot.
  const r = resolveGrappleContest({ grapplerTotal: 7, targetTotal: 9 });
  assert.equal(r.grapplerFinal, 7);
  assert.equal(r.targetFinal, 9);
  assert.equal(r.success, false, 'out-rolled, and nothing can rescue it here');
});

test('a guessOutcome passed in is inert — it cannot reach the contest', () => {
  // Belt and braces against the old signature surviving somewhere: even if a
  // caller still hands one over, the totals must not budge.
  for (const guessOutcome of [GUESS_WRONG, GUESS_RIGHT, GUESS_NONE]) {
    const r = resolveGrappleContest({ grapplerTotal: 11, targetTotal: 9, guessOutcome });
    assert.equal(r.grapplerFinal, 11, `grappler total moved for ${guessOutcome}`);
    assert.equal(r.targetFinal, 9, `target total moved for ${guessOutcome}`);
  }
});

test('a roll under the threshold can no longer be rescued by a good read', () => {
  const r = resolveGrappleContest({ grapplerTotal: 3, targetTotal: 1, guessOutcome: GUESS_WRONG });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'below-threshold');
});

// ---------- ...and lands on the follow-up instead ----------

test('a wrong guess is +5 on the follow-up; a right guess is −5', () => {
  // Signed, not "whoever won gets +5": by the time the follow-up rolls there
  // is only one roll left to modify, so reading the grab right has to make
  // that roll worse rather than make some other roll better.
  assert.equal(chainRollBonusFor(GUESS_WRONG), MINI_GAME_BONUS);
  assert.equal(chainRollBonusFor(GUESS_RIGHT), -MINI_GAME_BONUS);
});

test('no mini-game means the follow-up rolls unmodified', () => {
  assert.equal(chainRollBonusFor(GUESS_NONE), 0);
  assert.equal(chainRollBonusFor(), 0);
  assert.equal(chainRollBonusFor(undefined), 0);
});

test('the swing is exactly one ±5, never one per die', () => {
  // Total-level, stored on the declaration and added to the summed roll. A +5
  // folded into the per-die modifier would pay out once per die.
  assert.equal(Math.abs(chainRollBonusFor(GUESS_WRONG)), 5);
  assert.equal(Math.abs(chainRollBonusFor(GUESS_RIGHT)), 5);
});

// ---------- which follow-ups the grappler may actually take ----------

const DIRS = [
  { direction: 'up', moveId: 7, moveName: 'Armbar', staminaCost: 2, isDefault: 0 },
  { direction: 'right', moveId: 9, moveName: 'Sweep', staminaCost: 0, isDefault: 1 },
  { direction: 'down', moveId: 11, moveName: 'Slam', staminaCost: 6, isDefault: 0 },
];

test('a granted, affordable follow-up is available', () => {
  const [up] = annotateFollowUps([DIRS[0]], { ownedMoveIds: [7], currentStamina: 10 });
  assert.equal(up.available, true);
  assert.equal(up.reason, 'ok');
});

test('a Default follow-up is available without being granted', () => {
  const [right] = annotateFollowUps([DIRS[1]], { ownedMoveIds: [], currentStamina: 0 });
  assert.equal(right.available, true);
});

test('a follow-up the grappler does not own is unavailable, and says why', () => {
  const [up] = annotateFollowUps([DIRS[0]], { ownedMoveIds: [], currentStamina: 99 });
  assert.equal(up.available, false);
  assert.equal(up.reason, 'not-owned');
});

test('a follow-up they cannot pay for is unavailable, and says why', () => {
  const [down] = annotateFollowUps([DIRS[2]], { ownedMoveIds: [11], currentStamina: 5 });
  assert.equal(down.available, false);
  assert.equal(down.reason, 'unaffordable');
});

test('exactly affordable is affordable — the floor is 0, not 1', () => {
  const [down] = annotateFollowUps([DIRS[2]], { ownedMoveIds: [11], currentStamina: 6 });
  assert.equal(down.available, true);
});

test('a negative cost restores Stamina and is always affordable', () => {
  const free = { direction: 'up', moveId: 7, staminaCost: -3, isDefault: 1 };
  const [row] = annotateFollowUps([free], { ownedMoveIds: [], currentStamina: 0 });
  assert.equal(row.available, true);
});

test('annotating keeps every direction and its order — the prompt shows them all', () => {
  // The grappler sees all four with the unusable ones greyed (decided), so
  // nothing may be filtered out here.
  const rows = annotateFollowUps(DIRS, { ownedMoveIds: [7], currentStamina: 3 });
  assert.deepEqual(rows.map((r) => r.direction), ['up', 'right', 'down']);
  assert.deepEqual(rows.map((r) => r.available), [true, true, false]);
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
