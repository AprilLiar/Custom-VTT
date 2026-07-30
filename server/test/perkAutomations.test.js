import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFrames, idleStaminaRegenRate, IDLE_STAMINA_REGEN_HOOKS } from '../perkAutomations.js';

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

test('idleStaminaRegenRate: base rate is 1 idle Tic per Stamina point with no matching Perk', () => {
  assert.equal(idleStaminaRegenRate([]), 1);
  assert.equal(idleStaminaRegenRate(['Some Unrelated Perk']), 1);
});

test('idleStaminaRegenRate: a granted Perk registered in IDLE_STAMINA_REGEN_HOOKS overrides the rate', () => {
  IDLE_STAMINA_REGEN_HOOKS['Test-Only Patient Guard'] = { ticsRequired: 2 };
  try {
    assert.equal(idleStaminaRegenRate(['Test-Only Patient Guard']), 2);
    assert.equal(idleStaminaRegenRate(['Unrelated', 'Test-Only Patient Guard']), 2);
  } finally {
    delete IDLE_STAMINA_REGEN_HOOKS['Test-Only Patient Guard'];
  }
});
