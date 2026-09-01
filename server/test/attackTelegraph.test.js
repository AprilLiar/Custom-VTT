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
  // Never a Fool: present on the payload only for a viewer whose Perk earns it,
  // so the default here is "the key is not there at all".
  isFeint = undefined,
} = {}) => ({
  id,
  characterId,
  placementTic,
  revealTic,
  activeEndTic: revealTic + activeTics,
  publiclyRevealed,
  ...(isFeint === undefined ? {} : { isFeint }),
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

test('attackStartsByTic: marks the first Startup Tic and nothing else', () => {
  // Deliberately back to one square (decided, revised back): marking the whole
  // run published the move's Startup length, and frame data is exactly what a
  // Tell is supposed to make you guess at.
  const marks = starts([dm({ placementTic: 2, revealTic: 5 })]);
  assert.deepEqual([...marks.keys()], [2]);
  assert.deepEqual(marks.get(2), [
    // `isFeint` is false for a row the server never marked — the mark is built
    // from a per-viewer key the client is not entitled to decide (Never a Fool).
    { declaredMoveId: 1, characterId: 10, characterName: 'Char10', isFeint: false },
  ]);
});

test('attackStartsByTic: carries the viewer\'s Feint marking through (Never a Fool)', () => {
  // Only ever true when the SERVER put `isFeint` on the row for this viewer —
  // the client has no other way to decide it, which is what keeps the
  // entitlement in one place. Every other viewer's payload has no such key and
  // the mark comes back false.
  const marked = starts([dm({ placementTic: 1, revealTic: 4, isFeint: true })]);
  assert.equal(marked.get(1)[0].isFeint, true);
  const plain = starts([dm({ placementTic: 1, revealTic: 4 })]);
  assert.equal(plain.get(1)[0].isFeint, false);
});

test('attackStartsByTic: a long wind-up and a short one draw identically', () => {
  // The property the single square exists to have: you can see that something
  // is committed on this Tic, and you cannot read off how long it runs.
  const long = starts([dm({ id: 1, placementTic: 0, revealTic: 3 })]);
  const short = starts([dm({ id: 2, placementTic: 0, revealTic: 1 })]);
  assert.deepEqual([...long.keys()], [0]);
  assert.deepEqual([...short.keys()], [0]);
});

test('attackStartsByTic: the reveal Tic is never marked unless the move is placed on it', () => {
  // Past the placement square the move draws as itself; a glow further along
  // the run would be publishing frame data.
  const marks = starts([dm({ placementTic: 2, revealTic: 5 })]);
  assert.equal(marks.has(5), false);
  assert.equal(marks.has(3), false);
});

test('attackStartsByTic: a 0-Startup move still marks its placement Tic', () => {
  // It is committed on that Tic like anything else, and the glow drops the
  // moment it goes public anyway — so there is nothing to protect by hiding it.
  const marks = starts([dm({ placementTic: 4, revealTic: 4 })]);
  assert.deepEqual([...marks.keys()], [4]);
});

test('attackStartsByTic: a move that has gone public no longer glows', () => {
  assert.equal(starts([dm({ publiclyRevealed: true })]).size, 0);
});

test('attackStartsByTic: a pure guard glows too (decided, revised)', () => {
  // The gate used to be "can this move hit you", which made the ABSENCE of a
  // glow a free and perfectly reliable read that the opponent was turtling.
  // There is no longer any such field to pass — every unrevealed declared move
  // in the pair marks its placement Tic, whatever it turns out to be.
  const guard = dm({ id: 7, placementTic: 2 });
  assert.deepEqual([...starts([guard]).keys()], [2]);
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

test('attackStartsByTic: only Tics this round actually draws are marked', () => {
  // A wind-up that BEGAN last round has no square here — its telegraph was
  // shown on the round that owned its placement Tic.
  assert.equal(starts([dm({ placementTic: -2, revealTic: 2 })], { roundStartTic: 0 }).size, 0);

  // Past this round's last Tic there is no square to glow on at all.
  assert.equal(starts([dm({ placementTic: 7, revealTic: 9 })], { roundStartTic: 0, roundLength: 7 }).size, 0);
  // The last square of the window is still in it.
  assert.deepEqual(
    [...starts([dm({ placementTic: 6, revealTic: 9 })], { roundStartTic: 0, roundLength: 7 }).keys()],
    [6]
  );
  // A later round's window: absolute Tics, not relative ones.
  assert.deepEqual(
    [...starts([dm({ placementTic: 9, revealTic: 11 })], { roundStartTic: 7, roundLength: 7 }).keys()],
    [9]
  );
});

test('attackStartsByTic: several attacks can begin on the same Tic', () => {
  const marks = starts([
    dm({ id: 1, characterId: 10, placementTic: 3, revealTic: 5 }),
    dm({ id: 2, characterId: 11, placementTic: 3, revealTic: 5 }),
  ]);
  assert.deepEqual(marks.get(3).map((m) => m.characterName), ['Char10', 'Char11']);
  assert.equal(marks.has(4), false);
});

test('attackStartsByTic: nothing to draw before a pair has a round', () => {
  assert.equal(starts([dm()], { pairIndex: null }).size, 0);
  assert.equal(starts([dm()], { roundStartTic: undefined }).size, 0);
  assert.equal(starts(undefined).size, 0);
});
