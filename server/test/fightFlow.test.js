// Which Reminders fire when (client/src/lib/fightFlow.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticReminders, remindersToFire } from '../../client/src/lib/fightFlow.js';

const f = (combatantId, ownerKey, side, extra = {}) => ({ combatantId, ownerKey, side, name: ownerKey, ...extra });
const r = (id, scope, timing, extra = {}) => ({ id, scope, timing, target: 'any', stance_id: null, ...extra });
const ids = (fired) => fired.map((x) => x.reminder.id).sort((a, b) => a - b);

const mira = f(1, 'character:1', 'allies');
const bo = f(2, 'character:2', 'allies');
const goonA = f(3, 'temp_npc:9', 'enemies');
const goonB = f(4, 'temp_npc:9', 'enemies');
const fighters = [mira, bo, goonA, goonB];

test("self reminders fire on the owner's own turn, at the right end of it", () => {
  const remindersByOwner = { 'character:1': [r(1, 'self', 'start'), r(2, 'self', 'end')] };
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_start', active: mira, fighters, remindersByOwner })), [1]);
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_end', active: mira, fighters, remindersByOwner })), [2]);
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_start', active: bo, fighters, remindersByOwner })), []);
});

test("others reminders: any, allies, enemies, one — and never on the owner's own turn", () => {
  const remindersByOwner = {
    'character:1': [
      r(1, 'others', 'start'),
      r(2, 'others', 'start', { target: 'allies' }),
      r(3, 'others', 'start', { target: 'enemies' }),
      r(4, 'others', 'start', { target: 'one', target_type: 'temp_npc', target_id: 9 }),
    ],
  };
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_start', active: bo, fighters, remindersByOwner })), [1, 2]);
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_start', active: goonB, fighters, remindersByOwner })), [1, 3, 4]);
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_start', active: mira, fighters, remindersByOwner })), []);
});

test("a copy's turn is not 'someone else's' to another copy of the same owner", () => {
  const remindersByOwner = { 'temp_npc:9': [r(7, 'others', 'start'), r(8, 'self', 'start')] };
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_start', active: goonA, fighters, remindersByOwner })), [8]);
});

test('round reminders fire once per owner, however many copies', () => {
  const remindersByOwner = { 'temp_npc:9': [r(5, 'round', 'start'), r(6, 'round', 'end')], 'character:2': [r(9, 'round', 'start')] };
  assert.deepEqual(ids(remindersToFire({ moment: 'round_start', fighters, remindersByOwner })), [5, 9]);
  assert.deepEqual(ids(remindersToFire({ moment: 'round_end', fighters, remindersByOwner })), [6]);
});

test('owners not in the fight are never reminded', () => {
  const remindersByOwner = { 'character:99': [r(1, 'round', 'start'), r(2, 'others', 'start')] };
  assert.deepEqual(remindersToFire({ moment: 'round_start', fighters, remindersByOwner }), []);
  assert.deepEqual(remindersToFire({ moment: 'turn_start', active: mira, fighters, remindersByOwner }), []);
});

test('a stance-bound reminder fires only while that stance is active, with the default as the fallback', () => {
  const remindersByOwner = { 'character:1': [r(1, 'self', 'start', { stance_id: 20 }), r(2, 'self', 'start', { stance_id: 21 })] };
  const defaults = { 'character:1': 20 };
  assert.deepEqual(ids(remindersToFire({ moment: 'turn_start', active: mira, fighters, remindersByOwner, defaultStanceByOwner: defaults })), [1]);
  const inFury = { ...mira, activeStanceId: 21 };
  assert.deepEqual(
    ids(remindersToFire({ moment: 'turn_start', active: inFury, fighters: [inFury, bo], remindersByOwner, defaultStanceByOwner: defaults })),
    [2]
  );
});

test('automatic End Phase reminders: Burning, Speed (everyone), Fatigue, Challenge', () => {
  const active = { ...mira, tokens: { burning: 5, fatigue: 1, speed: 2 }, challengeId: 3 };
  const others = [active, { ...bo, tokens: { speed: 4 } }, { ...goonA, tokens: {}, name: 'Goon' }];
  const out = automaticReminders({ active, fighters: others });
  assert.deepEqual(out.map((x) => x.rule), ['burning', 'speed', 'fatigue', 'challenge']);
  assert.match(out[0].text, /take 5 damage.*discard 3 Burning/);
  assert.deepEqual(out[1].fighters.map((x) => x.combatantId), [1, 2]);
  assert.match(out[3].text, /damage Goon/);
  assert.deepEqual(automaticReminders({ active: { ...bo, tokens: {} }, fighters: [bo] }), []);
});
