import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSideInitiative,
  computePlacementTic,
  computeMoveFootprint,
  isMoveRevealedTo,
  relativeTic,
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
  assert.equal(computePlacementTic({ roundStartTic: 1, previousRevealTic: null }), 1);
  assert.equal(computePlacementTic({ roundStartTic: 6, previousRevealTic: null }), 6);
});

test('computePlacementTic: later move placed at round start once the previous move already revealed', () => {
  // previous move revealed back at tic 3, this round starts at tic 6
  assert.equal(computePlacementTic({ roundStartTic: 6, previousRevealTic: 3 }), 6);
});

test('computePlacementTic: overflow carries — can\'t place before the previous move\'s reveal Tic, even across a round boundary', () => {
  // previous move (declared last round) doesn't reveal until tic 8, which is
  // into the new round (started at tic 6) — the new move can't jump ahead of it
  assert.equal(computePlacementTic({ roundStartTic: 6, previousRevealTic: 8 }), 8);
});

test('computePlacementTic: exactly equal boundary', () => {
  assert.equal(computePlacementTic({ roundStartTic: 6, previousRevealTic: 6 }), 6);
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

test('integration: a move overflowing into the next round blocks that character\'s next placement, with no special-casing', () => {
  // Round 1 starts at tic 1, length 5. A Jab (startup 2) is placed at the
  // last tic of the round (tic 5) — reveals at tic 7, which overflows into
  // round 2 by 2 tics.
  const round1Start = 1;
  const roundLength = 5;
  const placementTic1 = computePlacementTic({ roundStartTic: round1Start, previousRevealTic: null });
  assert.equal(placementTic1, 1);

  // character queues a second move this same round, placed right after the
  // first one reveals (simulating a very fast follow-up declared same round)
  const footprint1 = computeMoveFootprint({ placementTic: 5, startupTics: 2, activeTics: 1, recoveryTics: 0 });
  assert.equal(footprint1.revealTic, 7);
  const overflowInfo = relativeTic({ tic: footprint1.revealTic, roundStartTic: round1Start, roundLength });
  assert.equal(overflowInfo.isOverflow, true);
  assert.equal(overflowInfo.overflowBy, 2);

  // GM presses Next Round once the counter reaches (or passes) the old
  // round's end; round 2 starts wherever the counter currently sits.
  const round2Start = 6;
  // this character's next move can't be placed before tic 7, even though
  // round 2 already started at tic 6 — the overflow carries automatically
  const placementTic2 = computePlacementTic({
    roundStartTic: round2Start,
    previousRevealTic: footprint1.revealTic,
  });
  assert.equal(placementTic2, 7);
});
