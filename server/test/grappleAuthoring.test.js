// Authoring validation for a Grappling move (G3) — the four directions and
// the trigger gate. Pure, like the rest of moveLogic.js, so the rules are
// provable without standing a server up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GRAPPLE_DIRECTIONS,
  GRAPPLE_TRIGGERS,
  normalizeGrappleDirections,
  normalizeInteractions,
} from '../moveLogic.js';

const anyMove = (id) => id;
const LIBRARY = [1, 2, 3, 7, 9];

// ---------- the four directions ----------

test('a direction map becomes one row per assigned direction', () => {
  const rows = normalizeGrappleDirections({ up: 7, right: 9 }, { validMoveIds: LIBRARY });
  assert.deepEqual(rows, [
    { direction: 'up', targetMoveId: 7 },
    { direction: 'right', targetMoveId: 9 },
  ]);
});

test('rows come out in cross order however the payload was keyed', () => {
  // The cross must always read the same way round, whichever direction the
  // GM happened to fill in first.
  const rows = normalizeGrappleDirections(
    { right: 1, up: 2, left: 3, down: 7 },
    { validMoveIds: LIBRARY }
  );
  assert.deepEqual(rows.map((r) => r.direction), GRAPPLE_DIRECTIONS);
  assert.deepEqual(GRAPPLE_DIRECTIONS, ['up', 'down', 'left', 'right']);
});

test('an unassigned direction produces no row at all', () => {
  // Absent is different from "assigned to nothing" — there is no such thing
  // as a direction pointing at no move.
  const rows = normalizeGrappleDirections({ up: 7, down: null, left: undefined }, { validMoveIds: LIBRARY });
  assert.deepEqual(rows, [{ direction: 'up', targetMoveId: 7 }]);
});

test('a direction naming a move that no longer exists is dropped', () => {
  // Deleted between opening the form and saving it. The rest of the move
  // still saves — the same forgiving shape writeMove uses for a missing
  // folder.
  const rows = normalizeGrappleDirections({ up: 7, down: 404 }, { validMoveIds: LIBRARY });
  assert.deepEqual(rows, [{ direction: 'up', targetMoveId: 7 }]);
});

test('a move may never point a direction at itself', () => {
  // Chaining into another grappling move is allowed and resolves normally,
  // but a self-reference is an unbounded loop rather than a design choice.
  const rows = normalizeGrappleDirections({ up: 5, down: 7 }, { moveId: 5, validMoveIds: [...LIBRARY, 5] });
  assert.deepEqual(rows, [{ direction: 'down', targetMoveId: 7 }]);
});

test('self-reference is caught whether the id arrives as a number or a string', () => {
  const rows = normalizeGrappleDirections({ up: '5' }, { moveId: 5, validMoveIds: [5] });
  assert.deepEqual(rows, []);
});

test('an unknown direction key is ignored', () => {
  const rows = normalizeGrappleDirections(
    { up: 7, sideways: 9, '': 1 },
    { validMoveIds: LIBRARY }
  );
  assert.deepEqual(rows, [{ direction: 'up', targetMoveId: 7 }]);
});

test('the array form the client could send is accepted too', () => {
  const rows = normalizeGrappleDirections(
    [
      { direction: 'left', targetMoveId: 3 },
      { direction: 'up', targetMoveId: anyMove(1) },
    ],
    { validMoveIds: LIBRARY }
  );
  assert.deepEqual(rows, [
    { direction: 'up', targetMoveId: 1 },
    { direction: 'left', targetMoveId: 3 },
  ]);
});

test('garbage in gives an empty list, not a throw', () => {
  assert.deepEqual(normalizeGrappleDirections(null), []);
  assert.deepEqual(normalizeGrappleDirections(undefined), []);
  assert.deepEqual(normalizeGrappleDirections('nonsense'), []);
  assert.deepEqual(normalizeGrappleDirections({ up: 'not a number' }), []);
});

test('without a library to check against, ids are taken on trust', () => {
  // writeMove always passes one; this keeps the function usable (and
  // testable) on its own.
  const rows = normalizeGrappleDirections({ up: 999 });
  assert.deepEqual(rows, [{ direction: 'up', targetMoveId: 999 }]);
});

// ---------- the trigger gate ----------

const withGrapple = { grapple_success: { text: 'the hold takes', automations: [] } };

test('On Successful Grapple is only stored on a Grappling move', () => {
  const off = normalizeInteractions(withGrapple, false, false);
  assert.deepEqual(off, [], 'a move that cannot grapple has no grapple outcome');
  const on = normalizeInteractions(withGrapple, false, true);
  assert.deepEqual(on, [{ trigger: 'grapple_success', text: 'the hold takes', automations: [] }]);
});

test('unticking Grappling and re-saving drops the trigger', () => {
  // move:update replaces move_interactions wholesale, so "not normalized in"
  // is the whole mechanism — the same way the two defence triggers already
  // disappear when Defensive goes off.
  const stored = normalizeInteractions({ ...withGrapple, hit: { text: 'ow', automations: [] } }, false, false);
  assert.deepEqual(stored.map((r) => r.trigger), ['hit']);
});

test('the two gates are independent — a move can be both', () => {
  // A guard that turns into a hold is a perfectly ordinary move, and it gets
  // both sets of triggers.
  const rows = normalizeInteractions(
    {
      ...withGrapple,
      defense_success: { text: 'caught it', automations: [] },
    },
    true,
    true
  );
  assert.deepEqual(rows.map((r) => r.trigger), ['defense_success', 'grapple_success']);
});

test('base triggers are unaffected by either gate', () => {
  const rows = normalizeInteractions({ hit: { text: 'ow', automations: [] } }, false, false);
  assert.deepEqual(rows.map((r) => r.trigger), ['hit']);
  assert.deepEqual(GRAPPLE_TRIGGERS, ['grapple_success']);
});
