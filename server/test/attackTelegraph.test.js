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

test('attackStartsByTic: marks the first Startup Tic, not the reveal Tic', () => {
  const marks = starts([dm({ placementTic: 2, revealTic: 5 })]);
  assert.deepEqual([...marks.keys()], [2]);
  assert.deepEqual(marks.get(2), [{ declaredMoveId: 1, characterId: 10, characterName: 'Char10' }]);
});

test('attackStartsByTic: a 0-Startup move marks the Tic it was placed on', () => {
  const marks = starts([dm({ placementTic: 4, revealTic: 4 })]);
  assert.deepEqual([...marks.keys()], [4]);
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
    [...marks.values()].flat().map((m) => m.declaredMoveId),
    [1]
  );
});

test('attackStartsByTic: scoped to the round window actually on screen', () => {
  // Placed before this round opened (a carried-over wind-up) or past its
  // last Tic — either way there is no square here to glow on.
  assert.equal(starts([dm({ placementTic: -2 })], { roundStartTic: 0 }).size, 0);
  assert.equal(starts([dm({ placementTic: 7 })], { roundStartTic: 0, roundLength: 7 }).size, 0);
  assert.equal(starts([dm({ placementTic: 6 })], { roundStartTic: 0, roundLength: 7 }).size, 1);
  // A later round's window: absolute Tics, not relative ones.
  assert.equal(starts([dm({ placementTic: 9 })], { roundStartTic: 7, roundLength: 7 }).size, 1);
});

test('attackStartsByTic: several attacks can begin on the same Tic', () => {
  const marks = starts([
    dm({ id: 1, characterId: 10, placementTic: 3 }),
    dm({ id: 2, characterId: 11, placementTic: 3 }),
  ]);
  assert.deepEqual(marks.get(3).map((m) => m.characterName), ['Char10', 'Char11']);
});

test('attackStartsByTic: nothing to draw before a pair has a round', () => {
  assert.equal(starts([dm()], { pairIndex: null }).size, 0);
  assert.equal(starts([dm()], { roundStartTic: undefined }).size, 0);
  assert.equal(starts(undefined).size, 0);
});
