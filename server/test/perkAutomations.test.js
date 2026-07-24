import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIE_SLOT_NAMES,
  normalizeAutomationPayload,
  normalizeAutomations,
  invertAutomationPayload,
  effectiveFrames,
} from '../perkAutomations.js';

test('die_step: valid payload passes through with defaulted scope', () => {
  const payload = normalizeAutomationPayload('die_step', { slotName: 'Body', steps: 2 });
  assert.deepEqual(payload, { slotName: 'Body', steps: 2, scope: 'permanent' });
});

test('die_step: scope can be explicitly current', () => {
  const payload = normalizeAutomationPayload('die_step', {
    slotName: 'Body',
    steps: -1,
    scope: 'current',
  });
  assert.deepEqual(payload, { slotName: 'Body', steps: -1, scope: 'current' });
});

test('die_step: unknown slot name rejected', () => {
  assert.equal(normalizeAutomationPayload('die_step', { slotName: 'Tail', steps: 1 }), null);
});

test('die_step: zero steps rejected (no-op automation)', () => {
  assert.equal(normalizeAutomationPayload('die_step', { slotName: 'Body', steps: 0 }), null);
});

test('die_step: steps clamp to +/-20', () => {
  assert.equal(normalizeAutomationPayload('die_step', { slotName: 'Body', steps: 99 }).steps, 20);
  assert.equal(normalizeAutomationPayload('die_step', { slotName: 'Body', steps: -99 }).steps, -20);
});

test('die_step: covers all 8 dice slots', () => {
  assert.deepEqual(DIE_SLOT_NAMES.sort(), [
    'Body', 'Brain', 'Left Hand', 'Left Leg', 'Right Hand', 'Right Leg', 'Skull', 'Stamina',
  ].sort());
});

test('stamina_multiplier: valid delta kept, zero rejected', () => {
  assert.deepEqual(normalizeAutomationPayload('stamina_multiplier', { delta: 2 }), { delta: 2 });
  assert.equal(normalizeAutomationPayload('stamina_multiplier', { delta: 0 }), null);
});

test('move_tag: defaults action to add, accepts remove', () => {
  assert.deepEqual(normalizeAutomationPayload('move_tag', { moveId: 5, tagId: 9 }), {
    moveId: 5, tagId: 9, action: 'add',
  });
  assert.deepEqual(normalizeAutomationPayload('move_tag', { moveId: 5, tagId: 9, action: 'remove' }), {
    moveId: 5, tagId: 9, action: 'remove',
  });
});

test('move_tag: non-integer ids rejected', () => {
  assert.equal(normalizeAutomationPayload('move_tag', { moveId: 'x', tagId: 9 }), null);
});

test('move_frame_override: at least one nonzero delta required', () => {
  assert.equal(
    normalizeAutomationPayload('move_frame_override', { moveId: 1, startupDelta: 0, activeDelta: 0, recoveryDelta: 0 }),
    null
  );
  assert.deepEqual(
    normalizeAutomationPayload('move_frame_override', { moveId: 1, startupDelta: 1, activeDelta: 0, recoveryDelta: 0 }),
    { moveId: 1, startupDelta: 1, activeDelta: 0, recoveryDelta: 0 }
  );
});

test('move_frame_override: deltas clamp to +/-10 (FRAME_MAX)', () => {
  const payload = normalizeAutomationPayload('move_frame_override', {
    moveId: 1, startupDelta: 50, activeDelta: -50, recoveryDelta: 0,
  });
  assert.equal(payload.startupDelta, 10);
  assert.equal(payload.activeDelta, -10);
});

test('move_roll_bonus: zero amount rejected', () => {
  assert.equal(normalizeAutomationPayload('move_roll_bonus', { moveId: 1, amount: 0 }), null);
  assert.deepEqual(normalizeAutomationPayload('move_roll_bonus', { moveId: 1, amount: 3 }), {
    moveId: 1, amount: 3,
  });
});

test('unknown automation type rejected', () => {
  assert.equal(normalizeAutomationPayload('teleport', { moveId: 1 }), null);
});

test('normalizeAutomations: drops invalid entries, keeps valid ones', () => {
  const rows = normalizeAutomations([
    { type: 'die_step', payload: { slotName: 'Body', steps: 1 } },
    { type: 'die_step', payload: { slotName: 'Tail', steps: 1 } }, // bad slot
    { type: 'stamina_multiplier', payload: { delta: 0 } }, // no-op
    { type: 'move_roll_bonus', payload: { moveId: 4, amount: 2 } },
    { type: 'nonsense' },
    null,
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].automation_type, 'die_step');
  assert.equal(rows[1].automation_type, 'move_roll_bonus');
});

test('invertAutomationPayload: negates die_step and stamina_multiplier only', () => {
  assert.deepEqual(
    invertAutomationPayload('die_step', { slotName: 'Body', steps: 2, scope: 'permanent' }),
    { slotName: 'Body', steps: -2, scope: 'permanent' }
  );
  assert.deepEqual(invertAutomationPayload('stamina_multiplier', { delta: 3 }), { delta: -3 });
  const tagPayload = { moveId: 1, tagId: 2, action: 'add' };
  assert.deepEqual(invertAutomationPayload('move_tag', tagPayload), tagPayload); // pass-through
});

test('effectiveFrames: applies and clamps deltas to 0-10', () => {
  const base = { startup_tics: 3, active_tics: 2, recovery_tics: 1 };
  assert.deepEqual(
    effectiveFrames(base, { startup: 1, active: -1, recovery: 0 }),
    { startup_tics: 4, active_tics: 1, recovery_tics: 1 }
  );
  // clamps at the floor and ceiling
  assert.deepEqual(
    effectiveFrames(base, { startup: -10, active: 20, recovery: 0 }),
    { startup_tics: 0, active_tics: 10, recovery_tics: 1 }
  );
});
