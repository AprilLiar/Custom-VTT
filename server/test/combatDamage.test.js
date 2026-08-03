import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHitDamage,
  resolveDefenseRoll,
  phaseAtTic,
  classifyDefenseCoverage,
  computeInterruptBonus,
  clampRecoveryExtension,
} from '../combatDamage.js';

test('computeHitDamage: every 5 points is 1 Half-Damage step (0.5 damage)', () => {
  assert.deepEqual(computeHitDamage(0), { halfDamageSteps: 0, damage: 0 });
  assert.deepEqual(computeHitDamage(4), { halfDamageSteps: 0, damage: 0 });
  assert.deepEqual(computeHitDamage(5), { halfDamageSteps: 1, damage: 0.5 });
  assert.deepEqual(computeHitDamage(9), { halfDamageSteps: 1, damage: 0.5 });
  assert.deepEqual(computeHitDamage(10), { halfDamageSteps: 2, damage: 1 });
});

test('computeHitDamage: 25-29 is 2.5 damage, matching the spec\'s own example', () => {
  assert.deepEqual(computeHitDamage(25), { halfDamageSteps: 5, damage: 2.5 });
  assert.deepEqual(computeHitDamage(29), { halfDamageSteps: 5, damage: 2.5 });
});

test('computeHitDamage: never goes negative', () => {
  assert.deepEqual(computeHitDamage(-5), { halfDamageSteps: 0, damage: 0 });
});

test('resolveDefenseRoll: defender roll at or above attacker is a Full Block/Dodge — no damage', () => {
  assert.deepEqual(resolveDefenseRoll({ attackerResult: 20, defenderResult: 25 }), {
    netResult: 0,
    halfDamageSteps: 0,
    damage: 0,
    outcome: 'full',
  });
  assert.deepEqual(resolveDefenseRoll({ attackerResult: 20, defenderResult: 20 }), {
    netResult: 0,
    halfDamageSteps: 0,
    damage: 0,
    outcome: 'full',
  });
});

test('resolveDefenseRoll: a net result under 5 is still Full — no damage even though the attacker edged ahead', () => {
  assert.deepEqual(resolveDefenseRoll({ attackerResult: 20, defenderResult: 16 }), {
    netResult: 4,
    halfDamageSteps: 0,
    damage: 0,
    outcome: 'full',
  });
});

test('resolveDefenseRoll: net result of exactly 5 is the Partial Block/Dodge boundary', () => {
  assert.deepEqual(resolveDefenseRoll({ attackerResult: 20, defenderResult: 15 }), {
    netResult: 5,
    halfDamageSteps: 1,
    damage: 0.5,
    outcome: 'partial',
  });
});

test('resolveDefenseRoll: Partial Block/Dodge applies the reduced damage formula to the net result', () => {
  assert.deepEqual(resolveDefenseRoll({ attackerResult: 20, defenderResult: 5 }), {
    netResult: 15,
    halfDamageSteps: 3,
    damage: 1.5,
    outcome: 'partial',
  });
});

const footprint = (overrides = {}) => ({
  placementTic: 10,
  revealTic: 13, // 3 Startup Tics: 10, 11, 12
  activeEndTic: 15, // 2 Active Tics: 13, 14
  recoveryEndTic: 17, // 2 Recovery Tics: 15, 16
  defenseFramePositions: [],
  ...overrides,
});

test('phaseAtTic: outside the footprint entirely is null', () => {
  const f = footprint();
  assert.equal(phaseAtTic(f, 9), null);
  assert.equal(phaseAtTic(f, 17), null); // recoveryEndTic is exclusive
});

test('phaseAtTic: classifies Startup/Active/Recovery correctly', () => {
  const f = footprint();
  assert.equal(phaseAtTic(f, 10), 'startup');
  assert.equal(phaseAtTic(f, 12), 'startup');
  assert.equal(phaseAtTic(f, 13), 'active');
  assert.equal(phaseAtTic(f, 14), 'active');
  assert.equal(phaseAtTic(f, 15), 'recovery');
  assert.equal(phaseAtTic(f, 16), 'recovery');
});

test('phaseAtTic: a Defense-tagged square overrides whichever phase it would otherwise be', () => {
  const startupDefense = footprint({ defenseFramePositions: [1] }); // offset 1 = Tic 11 (Startup)
  assert.equal(phaseAtTic(startupDefense, 11), 'defense');
  assert.equal(phaseAtTic(startupDefense, 10), 'startup'); // untouched neighbor

  const activeDefense = footprint({ defenseFramePositions: [4] }); // offset 4 = Tic 14 (Active)
  assert.equal(phaseAtTic(activeDefense, 14), 'defense');
});

test('classifyDefenseCoverage: every Active Tic covered is full coverage', () => {
  assert.deepEqual(
    classifyDefenseCoverage({ attackActiveStart: 13, attackActiveEnd: 15, defenseTics: [13, 14] }),
    { coverage: 'full', extensionTicsNeeded: 0 }
  );
});

test('classifyDefenseCoverage: extra unrelated defense Tics outside the window don\'t change full coverage', () => {
  assert.deepEqual(
    classifyDefenseCoverage({ attackActiveStart: 13, attackActiveEnd: 15, defenseTics: [13, 14, 99] }),
    { coverage: 'full', extensionTicsNeeded: 0 }
  );
});

test('classifyDefenseCoverage: the very first Active Tic uncovered is too-early (auto-fail)', () => {
  assert.deepEqual(
    classifyDefenseCoverage({ attackActiveStart: 13, attackActiveEnd: 15, defenseTics: [14] }),
    { coverage: 'too-early', extensionTicsNeeded: 0 }
  );
});

test('classifyDefenseCoverage: no overlap at all is too-early, same as auto-fail', () => {
  assert.deepEqual(
    classifyDefenseCoverage({ attackActiveStart: 13, attackActiveEnd: 15, defenseTics: [] }),
    { coverage: 'too-early', extensionTicsNeeded: 0 }
  );
});

test('classifyDefenseCoverage: coverage starts in time but runs out is too-late, counting the uncovered Tics', () => {
  assert.deepEqual(
    classifyDefenseCoverage({ attackActiveStart: 13, attackActiveEnd: 16, defenseTics: [13] }),
    { coverage: 'too-late', extensionTicsNeeded: 2 }
  );
});

test('computeInterruptBonus: landing on the reveal Tic itself is the minimum +1', () => {
  assert.equal(computeInterruptBonus({ revealTic: 13, currentTic: 13 }), 1);
});

test('computeInterruptBonus: grows by 1 per elapsed Active Tic including the current one', () => {
  assert.equal(computeInterruptBonus({ revealTic: 13, currentTic: 14 }), 2);
  assert.equal(computeInterruptBonus({ revealTic: 13, currentTic: 20 }), 8);
});

test('computeInterruptBonus: never drops below the +1 floor', () => {
  assert.equal(computeInterruptBonus({ revealTic: 13, currentTic: 5 }), 1);
});

test('clampRecoveryExtension: a positive delta simply adds on', () => {
  assert.equal(clampRecoveryExtension({ currentExtensionTics: 0, recoveryTics: 3, delta: 2 }), 2);
  assert.equal(clampRecoveryExtension({ currentExtensionTics: 1, recoveryTics: 3, delta: 2 }), 3);
});

test('clampRecoveryExtension: a negative delta can shrink the window, floored at -recoveryTics', () => {
  assert.equal(clampRecoveryExtension({ currentExtensionTics: 0, recoveryTics: 3, delta: -1 }), -1);
  assert.equal(clampRecoveryExtension({ currentExtensionTics: 0, recoveryTics: 3, delta: -3 }), -3);
});

test('clampRecoveryExtension: never lets the Recovery window shrink past 0 length', () => {
  assert.equal(clampRecoveryExtension({ currentExtensionTics: 0, recoveryTics: 3, delta: -10 }), -3);
  assert.equal(clampRecoveryExtension({ currentExtensionTics: -2, recoveryTics: 3, delta: -5 }), -3);
});

test('clampRecoveryExtension: stacks on top of an existing extension (e.g. a prior Block-too-late)', () => {
  assert.equal(clampRecoveryExtension({ currentExtensionTics: 4, recoveryTics: 2, delta: -1 }), 3);
});
