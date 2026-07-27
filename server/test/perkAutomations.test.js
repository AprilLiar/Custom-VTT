import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFrames } from '../perkAutomations.js';

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
