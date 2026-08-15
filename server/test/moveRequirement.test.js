// The Requirement field: a move that may only be thrown immediately after
// another one. Pure, like the rest of moveLogic.js, so the rule is provable
// without standing a server up — the *timing* half (the forced placement Tic)
// is exercised against the real server by scripts/playtest-requirement.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequirement, requirementSatisfiedBy } from '../moveLogic.js';

const LIBRARY = [1, 2, 3, 7, 9];

// ---------- authoring ----------

test('a requirement naming a real move is kept', () => {
  assert.equal(normalizeRequirement(7, { moveId: 3, validMoveIds: LIBRARY }), 7);
});

test('no requirement is the normal case and normalizes to null', () => {
  for (const empty of [null, undefined, '', NaN]) {
    assert.equal(normalizeRequirement(empty, { moveId: 3, validMoveIds: LIBRARY }), null);
  }
});

test('a move may not require itself', () => {
  // Such a move could never be declared at all: it would have to follow a
  // copy of itself, which would have been unable to be declared either.
  assert.equal(normalizeRequirement(3, { moveId: 3, validMoveIds: LIBRARY }), null);
});

test('a requirement naming a move that no longer exists is dropped, not stored', () => {
  assert.equal(normalizeRequirement(42, { moveId: 3, validMoveIds: LIBRARY }), null);
});

test('an absent requirement is still null with no library to reject it', () => {
  // The version above passes only because 0 isn't in LIBRARY. Number(null)
  // and Number('') are both 0, and 0 is a valid-looking integer id — so
  // without a library check an absent Requirement silently became "requires
  // move 0", which the gate then refused to ever satisfy.
  for (const empty of [null, undefined, '']) {
    assert.equal(normalizeRequirement(empty, { moveId: 3 }), null);
  }
});

test('the library check is skipped when no library is supplied', () => {
  // writeMove always passes one; callers that only want the self-reference
  // rule (and the id coercion) should not be forced to fetch every move id.
  assert.equal(normalizeRequirement(42, { moveId: 3 }), 42);
});

test('a numeric string id survives, since a form control yields strings', () => {
  assert.equal(normalizeRequirement('7', { moveId: 3, validMoveIds: LIBRARY }), 7);
});

// ---------- the declaration-time gate ----------

test('a move with no Requirement is always declarable', () => {
  assert.equal(requirementSatisfiedBy(null, null), true);
  assert.equal(requirementSatisfiedBy(null, 9), true);
});

test('the Requirement is satisfied only by the move directly before it', () => {
  assert.equal(requirementSatisfiedBy(7, 7), true);
});

test('a Requirement is NOT satisfied by nothing at all', () => {
  // First move of the round, or a character who has never declared: there is
  // no B, so A cannot follow it. "Not without it."
  assert.equal(requirementSatisfiedBy(7, null), false);
});

test('a Requirement is NOT satisfied by some other move', () => {
  assert.equal(requirementSatisfiedBy(7, 9), false);
});

test('a Requirement satisfied earlier in the queue no longer counts', () => {
  // The caller passes only the LAST-queued move, which is what makes this
  // "right after" rather than "at some point after" — B, then something
  // else, then A is not a combo.
  const lastQueued = 9; // ...even though 7 was queued before that.
  assert.equal(requirementSatisfiedBy(7, lastQueued), false);
});

test('ids compare by value, so a string id from the DB still matches', () => {
  assert.equal(requirementSatisfiedBy('7', 7), true);
  assert.equal(requirementSatisfiedBy(7, '7'), true);
});
