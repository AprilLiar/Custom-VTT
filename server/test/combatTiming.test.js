import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSideInitiative,
  computePlacementTic,
  computeMoveFootprint,
  isMoveRevealedTo,
  relativeTic,
  computeNextRoundStartTic,
} from '../combatTiming.js';

test('resolveSideInitiative: higher side wins, loser declares first', () => {
  let r = resolveSideInitiative({ left: [8], right: [3] });
  assert.equal(r.leftInitiative, 8);
  assert.equal(r.rightInitiative, 3);
  assert.equal(r.firstToDeclare, 'right');
  assert.equal(r.secondToDeclare, 'left');

  r = resolveSideInitiative({ left: [2], right: [9] });
  assert.equal(r.firstToDeclare, 'left');
  assert.equal(r.secondToDeclare, 'right');
});

test('resolveSideInitiative: a side\'s initiative is the highest roll among its characters (Uneven Combat)', () => {
  const r = resolveSideInitiative({ left: [4, 4, 11], right: [6, 7] });
  assert.equal(r.leftInitiative, 11);
  assert.equal(r.rightInitiative, 7);
  assert.equal(r.firstToDeclare, 'right');
});

test('resolveSideInitiative: tied initiative — left declares first (deterministic default)', () => {
  const r = resolveSideInitiative({ left: [6], right: [6] });
  assert.equal(r.firstToDeclare, 'left');
  assert.equal(r.secondToDeclare, 'right');
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
