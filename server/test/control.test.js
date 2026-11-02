// Who controls a character (server/control.js): the GM always, a Player their
// own PC plus NPCs assigned to them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlsCharacter, dropAssignmentsTo, loadAssignments, setAssignment } from '../control.js';

const gm = { role: 'gm' };
const mira = { role: 'player', characterId: 1 };
const bo = { role: 'player', characterId: 2 };

test('by default a Player controls only their own PC; the GM controls all', async () => {
  await loadAssignments(async () => []);
  assert.equal(controlsCharacter(mira, 1), true);
  assert.equal(controlsCharacter(mira, 2), false);
  assert.equal(controlsCharacter(mira, 10), false);
  assert.equal(controlsCharacter(gm, 10), true);
  assert.equal(controlsCharacter(null, 1), false);
  assert.equal(controlsCharacter(mira, null), false);
});

test('an assigned NPC is controlled by that player only, until unassigned', async () => {
  await loadAssignments(async () => [{ id: 10, assigned_to: 1 }]);
  assert.equal(controlsCharacter(mira, 10), true);
  assert.equal(controlsCharacter(mira, '10'), true);
  assert.equal(controlsCharacter(bo, 10), false);
  setAssignment(10, 2);
  assert.equal(controlsCharacter(mira, 10), false);
  assert.equal(controlsCharacter(bo, 10), true);
  setAssignment(10, null);
  assert.equal(controlsCharacter(bo, 10), false);
});

test("deleting a PC frees every NPC assigned to them", async () => {
  await loadAssignments(async () => [{ id: 10, assigned_to: 1 }, { id: 11, assigned_to: 1 }, { id: 12, assigned_to: 2 }]);
  assert.deepEqual(dropAssignmentsTo(1).sort(), [10, 11]);
  assert.equal(controlsCharacter(mira, 10), false);
  assert.equal(controlsCharacter(bo, 12), true);
});
