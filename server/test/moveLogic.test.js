import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFrame,
  validFrames,
  sanitizeAutomations,
  normalizeInteractions,
  clampRollBonus,
  sanitizeRollSlots,
} from '../moveLogic.js';

test('frames clamp to 0-10 and coerce junk', () => {
  assert.equal(clampFrame(3), 3);
  assert.equal(clampFrame(15), 10);
  assert.equal(clampFrame(-2), 0);
  assert.equal(clampFrame('4'), 4);
  assert.equal(clampFrame('junk'), 0);
});

test('at least one total square required', () => {
  assert.ok(validFrames(3, 2, 1));
  assert.ok(validFrames(0, 1, 0));
  assert.ok(!validFrames(0, 0, 0));
});

test('automations: valid types kept, junk dropped, zero dropped', () => {
  const clean = sanitizeAutomations([
    { type: 'self_recovery', amount: -2 },
    { type: 'opponent_recovery', amount: 3 },
    { type: 'self_stamina', amount: 4 },
    { type: 'opponent_stamina', amount: 1 },
    { type: 'teleport', amount: 5 },
    { type: 'self_stamina', amount: 0 },
    null,
  ]);
  assert.deepEqual(clean, [
    { type: 'self_recovery', amount: -2 },
    { type: 'opponent_recovery', amount: 3 },
    { type: 'self_stamina', amount: 4 },
    { type: 'opponent_stamina', amount: 1 },
  ]);
});

test('only self_recovery keeps a negative sign', () => {
  const clean = sanitizeAutomations([
    { type: 'opponent_recovery', amount: -3 },
    { type: 'self_stamina', amount: -5 },
  ]);
  assert.deepEqual(clean, [
    { type: 'opponent_recovery', amount: 3 },
    { type: 'self_stamina', amount: 5 },
  ]);
});

test('amounts clamp to +/-20', () => {
  assert.deepEqual(sanitizeAutomations([{ type: 'self_recovery', amount: 99 }]), [
    { type: 'self_recovery', amount: 20 },
  ]);
});

test('interactions: empty triggers dropped, unknown triggers ignored', () => {
  const rows = normalizeInteractions({
    hit: { text: 'Staggered', automations: [{ type: 'opponent_stamina', amount: 2 }] },
    block: { text: '', automations: [] },
    miss: { text: 'Whiff — wide open', automations: [] },
    explode: { text: 'nope' },
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.trigger), ['hit', 'miss']);
  assert.equal(rows[0].automations[0].amount, 2);
});

test('automation-only interaction (no text) is kept', () => {
  const rows = normalizeInteractions({
    block: { text: '', automations: [{ type: 'self_recovery', amount: 1 }] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trigger, 'block');
});

test('roll bonus clamps to +/-20 and coerces junk', () => {
  assert.equal(clampRollBonus(5), 5);
  assert.equal(clampRollBonus(99), 20);
  assert.equal(clampRollBonus(-99), -20);
  assert.equal(clampRollBonus('junk'), 0);
});

test('roll slots: dedupes and drops unknown slot names, empty = no Roll', () => {
  assert.deepEqual(sanitizeRollSlots(['Body', 'Body', 'Right Hand']), ['Body', 'Right Hand']);
  assert.deepEqual(sanitizeRollSlots(['Body', 'Wing', 'Left Leg']), ['Body', 'Left Leg']);
  assert.deepEqual(sanitizeRollSlots([]), []);
  assert.deepEqual(sanitizeRollSlots(null), []);
});
