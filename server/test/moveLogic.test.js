import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampFrame,
  validFrames,
  sanitizeAutomations,
  normalizeInteractions,
  clampRollBonus,
  clampStaminaCost,
  sanitizeRollSlots,
  hasAmbiguousRollSlot,
  sanitizeDefensePositions,
  AMBIGUOUS_ROLL_SLOTS,
  TRIGGERS,
  DEFENSE_TRIGGERS,
  ALL_TRIGGERS,
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

test('TRIGGERS/DEFENSE_TRIGGERS/ALL_TRIGGERS shape', () => {
  assert.deepEqual(TRIGGERS, ['hit', 'block', 'miss']);
  assert.deepEqual(DEFENSE_TRIGGERS, ['defense_success', 'defense_failure']);
  assert.deepEqual(ALL_TRIGGERS, ['hit', 'block', 'miss', 'defense_success', 'defense_failure']);
});

test('normalizeInteractions: defense triggers dropped for a non-Defensive move even with content', () => {
  const rows = normalizeInteractions(
    {
      hit: { text: 'Clean hit', automations: [] },
      defense_success: { text: 'Counter!', automations: [] },
      defense_failure: { text: 'Overwhelmed', automations: [{ type: 'self_stamina', amount: 2 }] },
    },
    false
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows.map((r) => r.trigger), ['hit']);
});

test('normalizeInteractions: defense triggers accepted for a Defensive move', () => {
  const rows = normalizeInteractions(
    {
      hit: { text: 'Clean hit', automations: [] },
      defense_success: { text: 'Counter!', automations: [] },
      defense_failure: { text: '', automations: [{ type: 'self_stamina', amount: 2 }] },
    },
    true
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.trigger).sort(),
    ['defense_failure', 'defense_success', 'hit']
  );
  const failure = rows.find((r) => r.trigger === 'defense_failure');
  assert.equal(failure.automations[0].amount, 2);
});

test('normalizeInteractions: empty defense rows on a Defensive move are still dropped', () => {
  const rows = normalizeInteractions(
    {
      defense_success: { text: '', automations: [] },
      defense_failure: { text: '   ', automations: [] },
    },
    true
  );
  assert.equal(rows.length, 0);
});

test('normalizeInteractions: isDefensive defaults to false when omitted', () => {
  const rows = normalizeInteractions({
    defense_success: { text: 'Should not be stored', automations: [] },
  });
  assert.equal(rows.length, 0);
});

test('roll bonus clamps to +/-20 and coerces junk', () => {
  assert.equal(clampRollBonus(5), 5);
  assert.equal(clampRollBonus(99), 20);
  assert.equal(clampRollBonus(-99), -20);
  assert.equal(clampRollBonus('junk'), 0);
});

test('stamina cost clamps to +/-20, allows 0 and negative, coerces junk', () => {
  assert.equal(clampStaminaCost(3), 3);
  assert.equal(clampStaminaCost(0), 0);
  assert.equal(clampStaminaCost(-5), -5);
  assert.equal(clampStaminaCost(99), 20);
  assert.equal(clampStaminaCost(-99), -20);
  assert.equal(clampStaminaCost('junk'), 0);
});

test('roll slots: dedupes and drops unknown slot names, empty = no Roll', () => {
  assert.deepEqual(sanitizeRollSlots(['Body', 'Body', 'Hand']), ['Body', 'Hand']);
  assert.deepEqual(sanitizeRollSlots(['Body', 'Wing', 'Leg']), ['Body', 'Leg']);
  assert.deepEqual(sanitizeRollSlots([]), []);
  assert.deepEqual(sanitizeRollSlots(null), []);
});

test('roll slots: concrete Left/Right Hand and Leg names are no longer valid — only the ambiguous choice is', () => {
  assert.deepEqual(sanitizeRollSlots(['Left Hand', 'Right Hand', 'Left Leg', 'Right Leg']), []);
});

test('hasAmbiguousRollSlot: true only when Hand or Leg is present', () => {
  assert.ok(hasAmbiguousRollSlot(['Body', 'Hand']));
  assert.ok(hasAmbiguousRollSlot(['Leg']));
  assert.ok(!hasAmbiguousRollSlot(['Body', 'Skull', 'Stamina', 'Brain']));
  assert.ok(!hasAmbiguousRollSlot([]));
});

test('AMBIGUOUS_ROLL_SLOTS resolves Hand/Leg to [left, right] die slot names', () => {
  assert.deepEqual(AMBIGUOUS_ROLL_SLOTS.Hand, ['Left Hand', 'Right Hand']);
  assert.deepEqual(AMBIGUOUS_ROLL_SLOTS.Leg, ['Left Leg', 'Right Leg']);
});

test('sanitizeDefensePositions: keeps in-range integers, dedupes, sorts', () => {
  assert.deepEqual(sanitizeDefensePositions([2, 0, 2, 4], 5), [0, 2, 4]);
});

test('sanitizeDefensePositions: drops out-of-range and junk entries, truncates fractional/string numbers', () => {
  assert.deepEqual(sanitizeDefensePositions([-1, 5, 1.9, '2', 3, 'junk'], 5), [1, 2, 3]);
});

test('sanitizeDefensePositions: non-array input yields empty', () => {
  assert.deepEqual(sanitizeDefensePositions(null, 5), []);
  assert.deepEqual(sanitizeDefensePositions(undefined, 5), []);
});
