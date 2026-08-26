import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSideInitiative,
  computePlacementTic,
  computeMoveFootprint,
  isMoveRevealedTo,
  relativeTic,
  computeNextRoundStartTic,
  isTicIdle,
  overlapsRoundWindow,
  computeInitiativeOverflowPenalty,
  findInterruptEligibleTic,
  planImposedRecovery,
} from '../combatTiming.js';

const roll = (n) => ({ roll: n });

test('resolveSideInitiative: higher side wins, loser declares first', () => {
  let r = resolveSideInitiative({ left: [roll(8)], right: [roll(3)] });
  assert.equal(r.leftInitiative, 8);
  assert.equal(r.rightInitiative, 3);
  assert.equal(r.firstToDeclare, 'right');
  assert.equal(r.secondToDeclare, 'left');

  r = resolveSideInitiative({ left: [roll(2)], right: [roll(9)] });
  assert.equal(r.firstToDeclare, 'left');
  assert.equal(r.secondToDeclare, 'right');
});

test('resolveSideInitiative: a side\'s initiative is the highest roll among its characters (Uneven Combat)', () => {
  const r = resolveSideInitiative({ left: [roll(4), roll(4), roll(11)], right: [roll(6), roll(7)] });
  assert.equal(r.leftInitiative, 11);
  assert.equal(r.rightInitiative, 7);
  assert.equal(r.firstToDeclare, 'right');
});

test('resolveSideInitiative: tied roll — higher current Brain wins the tie', () => {
  const r = resolveSideInitiative({
    left: [{ roll: 6, currentBrain: 8 }],
    right: [{ roll: 6, currentBrain: 10 }],
  });
  // right's candidate has the higher current Brain, so right wins the
  // roll-off and left (the loser) declares first.
  assert.equal(r.firstToDeclare, 'left');
  assert.equal(r.secondToDeclare, 'right');
});

test('resolveSideInitiative: tied roll and current Brain — higher locked Brain wins', () => {
  const r = resolveSideInitiative({
    left: [{ roll: 6, currentBrain: 8, lockedBrain: 8 }],
    right: [{ roll: 6, currentBrain: 8, lockedBrain: 10 }],
  });
  assert.equal(r.firstToDeclare, 'left');
  assert.equal(r.secondToDeclare, 'right');
});

test('resolveSideInitiative: tied roll/Brain — Speed in current stance wins', () => {
  const r = resolveSideInitiative({
    left: [{ roll: 6, currentBrain: 8, lockedBrain: 8, hasSpeedStance: false }],
    right: [{ roll: 6, currentBrain: 8, lockedBrain: 8, hasSpeedStance: true }],
  });
  assert.equal(r.firstToDeclare, 'left');
  assert.equal(r.secondToDeclare, 'right');
});

test('resolveSideInitiative: Speed tie-break only applies when it actually narrows the field', () => {
  // Both candidates have Speed — doesn't decide anything, falls through to
  // the random tie-break instead of picking either arbitrarily.
  const r = resolveSideInitiative(
    {
      left: [{ roll: 6, currentBrain: 8, lockedBrain: 8, hasSpeedStance: true }],
      right: [{ roll: 6, currentBrain: 8, lockedBrain: 8, hasSpeedStance: true }],
    },
    () => 0 // forces the random pick to land on the first candidate (left)
  );
  assert.equal(r.firstToDeclare, 'right');
  assert.equal(r.secondToDeclare, 'left');
});

test('resolveSideInitiative: fully tied — random tie-break is deterministic given an injected random()', () => {
  const candidates = { left: [{ roll: 6 }], right: [{ roll: 6 }] };
  const pickLeft = resolveSideInitiative(candidates, () => 0);
  assert.equal(pickLeft.secondToDeclare, 'left');
  const pickRight = resolveSideInitiative(candidates, () => 0.999);
  assert.equal(pickRight.secondToDeclare, 'right');
});

test('resolveSideInitiative: only characters who actually tied for the top roll are tie-break candidates', () => {
  // left's 9 beats right's tied-for-top 6es outright — no tie-break needed,
  // and left's other (lower) roller must never factor into anything.
  const r = resolveSideInitiative({
    left: [{ roll: 9, currentBrain: 4 }, { roll: 2, currentBrain: 99 }],
    right: [{ roll: 6, currentBrain: 50 }],
  });
  assert.equal(r.leftInitiative, 9);
  assert.equal(r.firstToDeclare, 'right');
});

test('computePlacementTic: a character\'s first move ever placed at round start', () => {
  assert.equal(computePlacementTic({ roundStartTic: 1, previousBlockedUntilTic: null }), 1);
  assert.equal(computePlacementTic({ roundStartTic: 6, previousBlockedUntilTic: null }), 6);
});

test('computePlacementTic: later move placed at round start once the previous move\'s full footprint already ended', () => {
  // previous move's Recovery ended back at tic 3, this round starts at tic 6
  assert.equal(computePlacementTic({ roundStartTic: 6, previousBlockedUntilTic: 3 }), 6);
});

test('computePlacementTic: overflow carries — can\'t place before the previous move\'s footprint fully ends, even across a round boundary', () => {
  // previous move (declared last round) doesn't finish Recovery until tic 8,
  // which is into the new round (started at tic 6) — the new move can't jump ahead of it
  assert.equal(computePlacementTic({ roundStartTic: 6, previousBlockedUntilTic: 8 }), 8);
});

test('computePlacementTic: exactly equal boundary', () => {
  assert.equal(computePlacementTic({ roundStartTic: 6, previousBlockedUntilTic: 6 }), 6);
});

test('computePlacementTic: blocks through Active/Recovery, not just Startup/reveal (revised rule)', () => {
  // A slow move (Startup 2, Active 3, Recovery 1) placed at tic 1 reveals at
  // tic 3 but doesn't finish Recovery until tic 7 — a follow-up move can't
  // be placed at tic 3 (its reveal Tic) even though that's when it's
  // revealed; it has to wait for the whole footprint to finish.
  const footprint = computeMoveFootprint({ placementTic: 1, startupTics: 2, activeTics: 3, recoveryTics: 1 });
  assert.equal(footprint.revealTic, 3);
  assert.equal(footprint.recoveryEndTic, 7);
  assert.equal(
    computePlacementTic({ roundStartTic: 1, previousBlockedUntilTic: footprint.recoveryEndTic }),
    7
  );
});

test('computeMoveFootprint: worked example from the plan — Hook, Startup 3, placed at round start', () => {
  const f = computeMoveFootprint({ placementTic: 1, startupTics: 3, activeTics: 1, recoveryTics: 2 });
  assert.equal(f.placementTic, 1);
  assert.equal(f.revealTic, 4); // Tell shows through Tics 1-3, revealed the moment the counter reaches Tic 4
  assert.equal(f.activeEndTic, 5);
  assert.equal(f.recoveryEndTic, 7);
});

test('computeMoveFootprint: zero Startup reveals immediately at the placement Tic', () => {
  const f = computeMoveFootprint({ placementTic: 5, startupTics: 0, activeTics: 1, recoveryTics: 0 });
  assert.equal(f.revealTic, f.placementTic);
});

test('computeMoveFootprint: zero Active/Recovery collapse cleanly', () => {
  const f = computeMoveFootprint({ placementTic: 10, startupTics: 2, activeTics: 0, recoveryTics: 0 });
  assert.equal(f.revealTic, 12);
  assert.equal(f.activeEndTic, 12);
  assert.equal(f.recoveryEndTic, 12);
});

test('isMoveRevealedTo: owner sees their own move before it reveals', () => {
  assert.equal(isMoveRevealedTo({ revealTic: 10, currentTic: 4, viewerIsOwner: true }), true);
});

test('isMoveRevealedTo: non-owner only sees it once the counter reaches the reveal Tic', () => {
  assert.equal(isMoveRevealedTo({ revealTic: 10, currentTic: 9, viewerIsOwner: false }), false);
  assert.equal(isMoveRevealedTo({ revealTic: 10, currentTic: 10, viewerIsOwner: false }), true);
  assert.equal(isMoveRevealedTo({ revealTic: 10, currentTic: 11, viewerIsOwner: false }), true);
});

test('isMoveRevealedTo: stateless — moving the Tic counter backward re-hides a move for non-owners', () => {
  const revealTic = 10;
  assert.equal(isMoveRevealedTo({ revealTic, currentTic: 10, viewerIsOwner: false }), true);
  // GM steps the counter back to re-check an earlier moment in the scene
  assert.equal(isMoveRevealedTo({ revealTic, currentTic: 9, viewerIsOwner: false }), false);
});

test('relativeTic: normal mid-round Tic, no overflow', () => {
  const r = relativeTic({ tic: 8, roundStartTic: 6, roundLength: 5 });
  assert.equal(r.relative, 3);
  assert.equal(r.isOverflow, false);
  assert.equal(r.overflowBy, 0);
});

test('relativeTic: first Tic of a round is relative 1', () => {
  const r = relativeTic({ tic: 6, roundStartTic: 6, roundLength: 5 });
  assert.equal(r.relative, 1);
  assert.equal(r.isOverflow, false);
});

test('relativeTic: exact last Tic of the round is not overflow', () => {
  const r = relativeTic({ tic: 10, roundStartTic: 6, roundLength: 5 });
  assert.equal(r.relative, 5);
  assert.equal(r.isOverflow, false);
});

test('relativeTic: past the round window is overflow, by exactly the excess', () => {
  const r = relativeTic({ tic: 12, roundStartTic: 6, roundLength: 5 });
  assert.equal(r.relative, 7);
  assert.equal(r.isOverflow, true);
  assert.equal(r.overflowBy, 2);
});

test('isTicIdle: true with no declared moves at all', () => {
  assert.equal(isTicIdle({ tic: 4, footprints: [] }), true);
});

test('isTicIdle: false for a Tic inside a move\'s Startup/placement', () => {
  assert.equal(isTicIdle({ tic: 4, footprints: [{ placementTic: 4, recoveryEndTic: 9 }] }), false);
});

test('isTicIdle: false for a Tic that only lands in Recovery, not Startup/Active', () => {
  assert.equal(isTicIdle({ tic: 9, footprints: [{ placementTic: 4, recoveryEndTic: 9 }] }), false);
});

test('isTicIdle: true for a Tic strictly between two other footprints', () => {
  const footprints = [
    { placementTic: 1, recoveryEndTic: 3 },
    { placementTic: 6, recoveryEndTic: 8 },
  ];
  assert.equal(isTicIdle({ tic: 4, footprints }), true);
  assert.equal(isTicIdle({ tic: 5, footprints }), true);
});

test('isTicIdle: a carried-over footprint from an earlier round still blocks idle credit', () => {
  // Same shape as any other footprint — isTicIdle doesn't care which round
  // declared it, only whether the Tic falls in [placementTic, recoveryEndTic].
  const footprints = [{ placementTic: 2, recoveryEndTic: 15 }];
  assert.equal(isTicIdle({ tic: 10, footprints }), false);
});

test('computeNextRoundStartTic: the very first round (phase null) just starts wherever the counter sits', () => {
  assert.equal(
    computeNextRoundStartTic({ phase: null, currentTic: 0, roundStartTic: 0, roundLength: 7 }),
    0
  );
});

test('computeNextRoundStartTic: fully-stepped round advances a full round_length past the old start (no 1-tic overlap)', () => {
  // round 1 started at tic 1, length 5; GM stepped all the way to the last
  // legal Tic (5) before pressing Next Round
  assert.equal(
    computeNextRoundStartTic({ phase: 'tic_countdown', currentTic: 5, roundStartTic: 1, roundLength: 5 }),
    6
  );
});

test('computeNextRoundStartTic: bug repro — Next Round pressed without ever stepping the countdown does not replay round 1\'s Tics', () => {
  // GM starts the Tic Countdown but presses Next Round immediately —
  // current_tic never moved off round 1's own start
  assert.equal(
    computeNextRoundStartTic({ phase: 'tic_countdown', currentTic: 1, roundStartTic: 1, roundLength: 5 }),
    6
  );
});

test('computeNextRoundStartTic: partially-stepped round is still floored a full round_length ahead', () => {
  assert.equal(
    computeNextRoundStartTic({ phase: 'tic_countdown', currentTic: 3, roundStartTic: 1, roundLength: 5 }),
    6
  );
});

test('computeNextRoundStartTic: genuine cross-round overflow still carries — the floor never reaches back past a move that ran long', () => {
  // Round 1 (start 1, length 5) fully stepped to tic 5, but this is about the
  // ROUND boundary itself, not a move's footprint — computePlacementTic is
  // what layers actual move overflow on top of whatever this returns.
  const nextStart = computeNextRoundStartTic({
    phase: 'tic_countdown',
    currentTic: 5,
    roundStartTic: 1,
    roundLength: 5,
  });
  assert.equal(nextStart, 6);
  // a move whose footprint didn't end until tic 8 still correctly blocks
  // placement in round 2 despite the new round starting at tic 6
  assert.equal(
    computePlacementTic({ roundStartTic: nextStart, previousBlockedUntilTic: 8 }),
    8
  );
});

test('integration: a move overflowing into the next round blocks that character\'s next placement, with no special-casing', () => {
  // Round 1 starts at tic 1, length 5. A Jab (startup 2, active 1, no
  // recovery) is placed at the last tic of the round (tic 5) — reveals at
  // tic 7, footprint ends at tic 8 (no Recovery beyond Active here), which
  // overflows into round 2.
  const round1Start = 1;
  const roundLength = 5;
  const placementTic1 = computePlacementTic({ roundStartTic: round1Start, previousBlockedUntilTic: null });
  assert.equal(placementTic1, 1);

  // character queues a second move this same round, placed right after the
  // first one's footprint ends (simulating a very fast follow-up declared same round)
  const footprint1 = computeMoveFootprint({ placementTic: 5, startupTics: 2, activeTics: 1, recoveryTics: 0 });
  assert.equal(footprint1.revealTic, 7);
  assert.equal(footprint1.recoveryEndTic, 8);
  const overflowInfo = relativeTic({ tic: footprint1.revealTic, roundStartTic: round1Start, roundLength });
  assert.equal(overflowInfo.isOverflow, true);
  assert.equal(overflowInfo.overflowBy, 2);

  // GM presses Next Round once the counter reaches (or passes) the old
  // round's end; round 2 starts wherever the counter currently sits.
  const round2Start = 6;
  // this character's next move can't be placed before tic 8 (the first
  // move's full footprint end), even though round 2 already started at tic
  // 6 — the overflow carries automatically
  const placementTic2 = computePlacementTic({
    roundStartTic: round2Start,
    previousBlockedUntilTic: footprint1.recoveryEndTic,
  });
  assert.equal(placementTic2, 8);
});

test('overlapsRoundWindow: a footprint fully inside the round window overlaps', () => {
  assert.equal(
    overlapsRoundWindow({ placementTic: 3, recoveryEndTic: 5, roundStartTic: 1, roundLength: 7 }),
    true
  );
});

test('overlapsRoundWindow: a footprint that already fully resolved before the window does not overlap', () => {
  assert.equal(
    overlapsRoundWindow({ placementTic: 1, recoveryEndTic: 8, roundStartTic: 8, roundLength: 7 }),
    false
  );
});

test('overlapsRoundWindow: a footprint entirely after the window does not overlap', () => {
  assert.equal(
    overlapsRoundWindow({ placementTic: 15, recoveryEndTic: 18, roundStartTic: 1, roundLength: 7 }),
    false
  );
});

test('overlapsRoundWindow: a footprint straddling the window start overlaps', () => {
  // declared last round, recovery carries one Tic into this round's window
  assert.equal(
    overlapsRoundWindow({ placementTic: 5, recoveryEndTic: 9, roundStartTic: 8, roundLength: 7 }),
    true
  );
});

test('overlapsRoundWindow: a footprint straddling the window end overlaps', () => {
  assert.equal(
    overlapsRoundWindow({ placementTic: 6, recoveryEndTic: 12, roundStartTic: 1, roundLength: 7 }),
    true
  );
});

test('overlapsRoundWindow: touching the window\'s exclusive end boundary does not overlap', () => {
  // recoveryEndTic === roundStartTic means it resolved on the very last Tic
  // before this round's window starts — same exclusive convention as every
  // other recoveryEndTic check in this module.
  assert.equal(
    overlapsRoundWindow({ placementTic: 1, recoveryEndTic: 1, roundStartTic: 1, roundLength: 7 }),
    false
  );
  assert.equal(
    overlapsRoundWindow({ placementTic: 8, recoveryEndTic: 20, roundStartTic: 1, roundLength: 7 }),
    false
  );
});

test('computeInitiativeOverflowPenalty: no declared moves ever -> no penalty', () => {
  assert.equal(
    computeInitiativeOverflowPenalty({ blockedUntilTic: null, nextRoundStartTic: 8 }),
    0
  );
});

test('computeInitiativeOverflowPenalty: last move already fully resolved before the new round -> no penalty', () => {
  assert.equal(
    computeInitiativeOverflowPenalty({ blockedUntilTic: 6, nextRoundStartTic: 8 }),
    0
  );
  // touching the boundary exactly also floors to 0
  assert.equal(
    computeInitiativeOverflowPenalty({ blockedUntilTic: 8, nextRoundStartTic: 8 }),
    0
  );
});

test('computeInitiativeOverflowPenalty: still-carrying move penalizes by exactly how many new-round Tics it still occupies', () => {
  assert.equal(
    computeInitiativeOverflowPenalty({ blockedUntilTic: 11, nextRoundStartTic: 8 }),
    3
  );
});

const startupMove = (declaredMoveId, placementTic, revealTic) => ({
  declaredMoveId,
  placementTic,
  revealTic,
});

test('findInterruptEligibleTic: fires at the first Active Tic where the target is still in Startup', () => {
  const result = findInterruptEligibleTic({
    attackerActiveStart: 13,
    attackerActiveEnd: 16,
    targetMoves: [startupMove(7, 14, 17)], // Startup covers Tics 14-16
  });
  assert.deepEqual(result, { tic: 14, declaredMoveId: 7 });
});

test('findInterruptEligibleTic: the target already being Active (past their own revealTic) is not interruptible', () => {
  const result = findInterruptEligibleTic({
    attackerActiveStart: 13,
    attackerActiveEnd: 16,
    targetMoves: [startupMove(7, 10, 13)], // revealTic 13 -> already past Startup by Tic 13
  });
  assert.equal(result, null);
});

test('findInterruptEligibleTic: null when the target has no declared move at all during the attack', () => {
  const result = findInterruptEligibleTic({
    attackerActiveStart: 13,
    attackerActiveEnd: 16,
    targetMoves: [],
  });
  assert.equal(result, null);
});

test('findInterruptEligibleTic: picks the earliest qualifying Tic, not just the first move in the list', () => {
  const result = findInterruptEligibleTic({
    attackerActiveStart: 10,
    attackerActiveEnd: 20,
    targetMoves: [startupMove(2, 15, 18), startupMove(1, 10, 12)],
  });
  assert.deepEqual(result, { tic: 10, declaredMoveId: 1 });
});


// ---------- planImposedRecovery ----------
//
// Recovery imposed by an automation lands on the clock: where the frames go
// depends on what the target was doing at that Tic, and everything they had
// declared after it slides.

// A 2/2/2 move placed at 0: Startup 0-1, Active 2-3, Recovery 4-5, ends at 6.
const mv = (id, placementTic, { startup = 2, active = 2, recovery = 2, ext = 0 } = {}) => ({
  id,
  placementTic,
  revealTic: placementTic + startup,
  activeTics: active,
  recoveryTics: recovery,
  recoveryExtensionTics: ext,
});

// Every expectation below carries `tripRecoveryTics: 0`: the update shape grew
// one field when Trip Recovery arrived, and these assert the whole object on
// purpose — a partial match would stop noticing a field that started coming
// back wrong. The trip cases themselves are in tripFrames.test.js.
test('planImposedRecovery: caught in Startup, the move is delayed rather than lengthened', () => {
  const r = planImposedRecovery({ moves: [mv(1, 0)], tic: 1, tics: 2 });
  assert.equal(r.phase, 'startup');
  assert.equal(r.affectedMoveId, 1);
  assert.deepEqual(r.updates, [
    // placementTic stays — the wind-up really did begin there — and the
    // extra Tics go into Startup, dragging Active and Recovery later.
    { id: 1, placementTic: 0, revealTic: 4, recoveryExtensionTics: 0, tripRecoveryTics: 0 },
  ]);
});

test('planImposedRecovery: caught mid-Active or mid-Recovery, the frames go on the END', () => {
  for (const tic of [2, 3, 4, 5]) {
    const r = planImposedRecovery({ moves: [mv(1, 0)], tic, tics: 3 });
    assert.equal(r.phase, 'in-flight', `tic ${tic}`);
    assert.deepEqual(r.updates, [{ id: 1, placementTic: 0, revealTic: 2, recoveryExtensionTics: 3, tripRecoveryTics: 0 }], `tic ${tic}`);
  }
});

test('planImposedRecovery: an existing extension is added to, not replaced', () => {
  const r = planImposedRecovery({ moves: [mv(1, 0, { ext: 1 })], tic: 3, tics: 2 });
  assert.equal(r.updates[0].recoveryExtensionTics, 3);
});

test('planImposedRecovery: the extension counts toward what "in flight" means', () => {
  // Without the extension this move ends at 6, so Tic 6 would be idle.
  assert.equal(planImposedRecovery({ moves: [mv(1, 0)], tic: 6, tics: 1 }).phase, 'idle');
  assert.equal(planImposedRecovery({ moves: [mv(1, 0, { ext: 2 })], tic: 6, tics: 1 }).phase, 'in-flight');
});

test('planImposedRecovery: caught between moves, the whole effect is the displacement', () => {
  const moves = [mv(1, 0), mv(2, 9)];
  const r = planImposedRecovery({ moves, tic: 7, tics: 2 });
  assert.equal(r.phase, 'idle');
  assert.equal(r.affectedMoveId, null);
  // Nothing is drawn on the idle Tics — there is no declared move there to
  // draw — so the only change is that what came later moved later.
  assert.deepEqual(r.updates, [{ id: 2, placementTic: 11, revealTic: 13, recoveryExtensionTics: 0, tripRecoveryTics: 0 }]);
});

test('planImposedRecovery: everything declared after the affected move slides by the same amount', () => {
  const moves = [mv(1, 0), mv(2, 6), mv(3, 12)];
  const r = planImposedRecovery({ moves, tic: 3, tics: 2 });
  assert.equal(r.phase, 'in-flight');
  assert.deepEqual(r.updates, [
    { id: 1, placementTic: 0, revealTic: 2, recoveryExtensionTics: 2, tripRecoveryTics: 0 },
    { id: 2, placementTic: 8, revealTic: 10, recoveryExtensionTics: 0, tripRecoveryTics: 0 },
    { id: 3, placementTic: 14, revealTic: 16, recoveryExtensionTics: 0, tripRecoveryTics: 0 },
  ]);
});

test('planImposedRecovery: the slide keeps the timeline legal — no move ever overlaps another', () => {
  // The whole reason later moves move at all: lengthening one without
  // shifting the next would put the next inside it, which is exactly the
  // state computePlacementTic exists to prevent at declare time.
  const moves = [mv(1, 0), mv(2, 6)];
  const r = planImposedRecovery({ moves, tic: 4, tics: 3 });
  const byId = new Map(r.updates.map((u) => [u.id, u]));
  const first = byId.get(1);
  const firstEnd = first.revealTic + 2 + 2 + first.recoveryExtensionTics;
  assert.ok(byId.get(2).placementTic >= firstEnd, `${byId.get(2).placementTic} vs ${firstEnd}`);
});

test('planImposedRecovery: a move ALREADY past is never touched', () => {
  const moves = [mv(1, 0), mv(2, 9)];
  const r = planImposedRecovery({ moves, tic: 10, tics: 2 });
  assert.equal(r.phase, 'startup'); // move 2's own Startup is 9-10
  assert.deepEqual(r.updates, [{ id: 2, placementTic: 9, revealTic: 13, recoveryExtensionTics: 0, tripRecoveryTics: 0 }]);
});

test('planImposedRecovery: zero, negative and non-integer amounts change nothing', () => {
  const moves = [mv(1, 0), mv(2, 9)];
  for (const tics of [0, -2, 1.5, NaN, undefined, null, '2']) {
    const r = planImposedRecovery({ moves, tic: 3, tics });
    assert.equal(r.phase, 'none', String(tics));
    assert.deepEqual(r.updates, [], String(tics));
  }
});

test('planImposedRecovery: nothing declared at all is a legitimate no-op', () => {
  const r = planImposedRecovery({ moves: [], tic: 3, tics: 2 });
  assert.equal(r.phase, 'idle');
  assert.deepEqual(r.updates, []);
});
