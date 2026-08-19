import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attackStartsByTic } from '../../client/src/lib/attackTelegraph.js';
import { isTelegraphedAttack } from '../moveLogic.js';

// The Attack telegraph splits across the two trees: *whether* a move
// telegraphs is a game rule and lives in moveLogic.js beside the other move
// sanitizers, while *where* the marker lands is a rendering question and
// lives in the client's own pure helper (imported across trees here, same
// precedent as folders.test.js). Both are pinned in one file because they
// are one feature, and getting either wrong is a real gameplay bug: too
// loose and a pure defence's timing leaks, too tight and an incoming attack
// can't be countered.

// A declared-move payload, trimmed to just the fields the telegraph reads.
const dm = ({
  id = 1,
  characterId = 10,
  placementTic = 3,
  revealTic = 5,
  activeTics = 2,
  publiclyRevealed = false,
  telegraphsAttack = true,
} = {}) => ({
  id,
  characterId,
  placementTic,
  revealTic,
  activeEndTic: revealTic + activeTics,
  publiclyRevealed,
  telegraphsAttack,
});

const starts = (declaredMoves, overrides = {}) =>
  attackStartsByTic({
    declaredMoves,
    pairIndexByChar: new Map([[10, 0], [11, 0], [20, 1]]),
    pairIndex: 0,
    roundStartTic: 0,
    roundLength: 7,
    nameOf: (id) => `Char${id}`,
    ...overrides,
  });

test('isTelegraphedAttack: an ordinary attack telegraphs', () => {
  // Jab / Haymaker: not Defensive, no Attack Target of their own (a
  // Successful Block is what gives them one) — still real attacks.
  assert.equal(isTelegraphedAttack({ activeTics: 1, isDefensive: 0, attackTargets: [] }), true);
  assert.equal(isTelegraphedAttack({ activeTics: 2, isDefensive: 0, attackTargets: ['Body'] }), true);
});

test('isTelegraphedAttack: a defence-pure move stays dark despite its Active frames', () => {
  // Front Guard / Slip Step ship as 1/2/x. Defense Frames may only sit on
  // ACTIVE positions (see sanitizeDefensePositions), so every working
  // defence HAS Active frames — which is exactly why Active count alone
  // cannot be the test.
  assert.equal(isTelegraphedAttack({ activeTics: 2, isDefensive: 1, attackTargets: [] }), false);
});

test('isTelegraphedAttack: a counter-attack telegraphs — it does hit you', () => {
  assert.equal(isTelegraphedAttack({ activeTics: 2, isDefensive: 1, attackTargets: ['Body'] }), true);
});

test('isTelegraphedAttack: no Active frames, nothing to telegraph', () => {
  assert.equal(isTelegraphedAttack({ activeTics: 0, isDefensive: 0, attackTargets: ['Body'] }), false);
  assert.equal(isTelegraphedAttack({ activeTics: undefined, isDefensive: 0, attackTargets: [] }), false);
});

test('isTelegraphedAttack: junk attack-target entries do not buy a telegraph', () => {
  // sanitizeAttackTargets filters to the known slot names, so a Defensive
  // move cannot escape defence-pure by sending nonsense.
  assert.equal(
    isTelegraphedAttack({ activeTics: 2, isDefensive: 1, attackTargets: ['Nose', ''] }),
    false
  );
});

test('attackStartsByTic: marks the WHOLE Startup run, up to but not including the reveal Tic', () => {
  // The revision this file's helper comment describes: a 3-Tic wind-up used to
  // light one square, so it was indistinguishable from a 1-Tic one and there
  // was no visible window to aim an Interrupt into.
  const marks = starts([dm({ placementTic: 2, revealTic: 5 })]);
  assert.deepEqual([...marks.keys()], [2, 3, 4]);
  assert.deepEqual(marks.get(2), [
    { declaredMoveId: 1, characterId: 10, characterName: 'Char10', isStart: true },
  ]);
});

test('attackStartsByTic: only the first Tic of a run is flagged isStart', () => {
  // The Tell↔Tic connector anchors on exactly one square. Without this flag it
  // would re-anchor on every square of the run and end up pointing at the last
  // one — the end of the wind-up rather than its beginning.
  const marks = starts([dm({ placementTic: 2, revealTic: 5 })]);
  assert.deepEqual(
    [2, 3, 4].map((t) => marks.get(t)[0].isStart),
    [true, false, false]
  );
});

test('attackStartsByTic: the reveal Tic itself is never marked', () => {
  // Past that point the move is public and draws as itself; a wind-up glow
  // there would be claiming the move is still secret.
  const marks = starts([dm({ placementTic: 2, revealTic: 5 })]);
  assert.equal(marks.has(5), false);
});

test('attackStartsByTic: a 0-Startup move marks nothing — it never winds up', () => {
  // It reveals on the Tic it was placed on, so there is no secret run to
  // telegraph. (This is a deliberate change: it used to glow on that one Tic,
  // which said "something starts here" about a move already on the table.)
  const marks = starts([dm({ placementTic: 4, revealTic: 4 })]);
  assert.equal(marks.size, 0);
});

test('attackStartsByTic: drops pure defences and already-public moves', () => {
  assert.equal(starts([dm({ telegraphsAttack: false })]).size, 0);
  assert.equal(starts([dm({ publiclyRevealed: true })]).size, 0);
});

test('attackStartsByTic: scoped to one pair', () => {
  // Character 20 is seated in pair 1; its timing is no business of pair 0's
  // strip.
  const marks = starts([dm({ id: 1, characterId: 10 }), dm({ id: 2, characterId: 20 })]);
  assert.deepEqual(
    [...new Set([...marks.values()].flat().map((m) => m.declaredMoveId))],
    [1]
  );
});

test('attackStartsByTic: clipped to the round window actually on screen', () => {
  // A wind-up that began LAST round is still winding through this one, and the
  // part of its run that lands on a visible square is drawn — clipped at the
  // window edge, not dropped. It has no isStart square here, since the Tic it
  // actually began on is off-screen behind the round boundary.
  const carried = starts([dm({ placementTic: -2, revealTic: 2 })], { roundStartTic: 0 });
  assert.deepEqual([...carried.keys()], [0, 1]);
  assert.equal(carried.get(0)[0].isStart, false);

  // Past this round's last Tic there is no square to glow on at all.
  assert.equal(starts([dm({ placementTic: 7, revealTic: 9 })], { roundStartTic: 0, roundLength: 7 }).size, 0);
  // ...and a run that spills over the end is clipped to the squares that exist.
  assert.deepEqual(
    [...starts([dm({ placementTic: 6, revealTic: 9 })], { roundStartTic: 0, roundLength: 7 }).keys()],
    [6]
  );
  // A later round's window: absolute Tics, not relative ones.
  assert.deepEqual(
    [...starts([dm({ placementTic: 9, revealTic: 11 })], { roundStartTic: 7, roundLength: 7 }).keys()],
    [9, 10]
  );
});

test('attackStartsByTic: several attacks can wind up over the same Tic', () => {
  const marks = starts([
    dm({ id: 1, characterId: 10, placementTic: 3, revealTic: 5 }),
    dm({ id: 2, characterId: 11, placementTic: 3, revealTic: 5 }),
  ]);
  assert.deepEqual(marks.get(3).map((m) => m.characterName), ['Char10', 'Char11']);
  // Both runs overlap on Tic 4 as well — one square, two marks.
  assert.deepEqual(marks.get(4).map((m) => m.characterName), ['Char10', 'Char11']);
});

test('attackStartsByTic: runs of different lengths are distinguishable, which is the point', () => {
  // The reported case: a 3-Tic wind-up next to a 1-Tic one. Before the
  // revision these drew identically.
  const long = starts([dm({ id: 1, placementTic: 0, revealTic: 3 })]);
  const short = starts([dm({ id: 2, placementTic: 0, revealTic: 1 })]);
  assert.equal(long.size, 3);
  assert.equal(short.size, 1);
});

test('attackStartsByTic: nothing to draw before a pair has a round', () => {
  assert.equal(starts([dm()], { pairIndex: null }).size, 0);
  assert.equal(starts([dm()], { roundStartTic: undefined }).size, 0);
  assert.equal(starts(undefined).size, 0);
});
