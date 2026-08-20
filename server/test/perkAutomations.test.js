// The pure per-move helper Perks write to, plus the idle-Stamina regen rate.
//
// `idleStaminaRegenRate` used to read its own registry (`IDLE_STAMINA_REGEN_HOOKS`,
// a second name-keyed map living beside `PERK_HOOKS`). Both are gone: a regen
// rate is one FIELD of a Perk, not a separate Perk system, and two parallel maps
// meant one Perk had to be written down twice under the same name. It reads the
// single Perk registry now — see server/perks/index.js — and this file pins the
// behaviour that survived the move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFrames, idleStaminaRegenRate } from '../perkAutomations.js';
import { PERK_REGISTRY } from '../perks/index.js';

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
  assert.equal(idleStaminaRegenRate(undefined), 1);
  assert.equal(idleStaminaRegenRate(['Some Unrelated Perk']), 1);
});

test('idleStaminaRegenRate: a granted Perk that declares the seam overrides the rate', () => {
  PERK_REGISTRY['Test-Only Patient Guard'] = {
    name: 'Test-Only Patient Guard',
    idleStaminaRegen: 2,
  };
  try {
    assert.equal(idleStaminaRegenRate(['Test-Only Patient Guard']), 2);
    assert.equal(idleStaminaRegenRate(['Unrelated', 'Test-Only Patient Guard']), 2);
    // Matched by name the way every Perk lookup is — case-insensitively and
    // whitespace tolerant, so a trailing space cannot silently drop a mechanic.
    assert.equal(idleStaminaRegenRate(['  test-only patient guard ']), 2);
  } finally {
    delete PERK_REGISTRY['Test-Only Patient Guard'];
  }
});

test('idleStaminaRegenRate: two regen Perks take the SLOWEST, never the sum', () => {
  // The one seam that is not additive, and the reason is here: a rate runs the
  // other way from a contribution. Summing 2 and 3 would make a character with
  // two regen Perks regen worse than one with either — more Perks must never be
  // a penalty.
  PERK_REGISTRY['Test-Only Slow'] = { name: 'Test-Only Slow', idleStaminaRegen: 3 };
  PERK_REGISTRY['Test-Only Quick'] = { name: 'Test-Only Quick', idleStaminaRegen: 2 };
  try {
    assert.equal(idleStaminaRegenRate(['Test-Only Slow', 'Test-Only Quick']), 3);
  } finally {
    delete PERK_REGISTRY['Test-Only Slow'];
    delete PERK_REGISTRY['Test-Only Quick'];
  }
});
