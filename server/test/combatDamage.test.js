import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_DAMAGE_THRESHOLD,
  computeHitDamage,
  selectRiposteTargets,
  resolveDefenseRoll,
  phaseAtTic,
  classifyDefenseCoverage,
  computeInterruptBonus,
  clampRecoveryExtension,
  selectAutoDamageTargets,
  selectUnevenCombatTarget,
  selectDefenseMove,
  activeFramePositions,
  defenseFramesWithinActive,
  canExtendDefense,
  cascadeShift,
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

test('classifyDefenseCoverage: coverage starts in time but runs out is too-short, counting the uncovered Tics', () => {
  assert.deepEqual(
    classifyDefenseCoverage({ attackActiveStart: 13, attackActiveEnd: 16, defenseTics: [13] }),
    { coverage: 'too-short', extensionTicsNeeded: 2 }
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

test('clampRecoveryExtension: stacks on top of an existing extension (e.g. a prior Block extension)', () => {
  assert.equal(clampRecoveryExtension({ currentExtensionTics: 4, recoveryTics: 2, delta: -1 }), 3);
});

const die = (slot_name, status = 'active') => ({ slot_name, status });

// **Every named Stat, not just the first (revised).** A move listing two Stats
// used to hit exactly one of them, which made the second Stat decoration.
test('selectAutoDamageTargets: every named Stat is hit, in the move\'s own listed order', () => {
  const dice = [die('Skull'), die('Body')];
  const result = selectAutoDamageTargets({ effectiveAttackTargets: ['Skull', 'Body'], dice });
  assert.deepEqual(result.map((d) => d.slot_name), ['Skull', 'Body']);
});

test('selectAutoDamageTargets: an incapacitated Stat drops out, the rest still land', () => {
  const dice = [die('Skull', 'incapacitated'), die('Body')];
  const result = selectAutoDamageTargets({ effectiveAttackTargets: ['Skull', 'Body'], dice });
  assert.deepEqual(result.map((d) => d.slot_name), ['Body']);
});

test('selectAutoDamageTargets: Left before Right, matching CONCRETE_ATTACK_TARGET_NAMES canonical order', () => {
  const dice = [die('Right Hand'), die('Left Hand')];
  const result = selectAutoDamageTargets({
    effectiveAttackTargets: ['Left Hand', 'Right Hand'],
    dice,
  });
  assert.deepEqual(result.map((d) => d.slot_name), ['Left Hand', 'Right Hand']);
});

test('selectAutoDamageTargets: a Stat named twice is still hit once', () => {
  const dice = [die('Skull')];
  const result = selectAutoDamageTargets({ effectiveAttackTargets: ['Skull', 'Skull'], dice });
  assert.equal(result.length, 1);
});

test('selectAutoDamageTargets: empty when every allowed Stat is incapacitated or missing', () => {
  const dice = [die('Skull', 'incapacitated')];
  assert.deepEqual(selectAutoDamageTargets({ effectiveAttackTargets: ['Skull', 'Brain'], dice }), []);
});

const candidate = (characterId, slotStatuses) => ({
  characterId,
  dice: Object.entries(slotStatuses).map(([slot_name, status]) => ({ slot_name, status })),
});

test('selectUnevenCombatTarget: lowest characterId among eligible candidates wins', () => {
  const candidates = [
    candidate(5, { Skull: 'active' }),
    candidate(2, { Skull: 'active' }),
    candidate(9, { Skull: 'active' }),
  ];
  assert.equal(
    selectUnevenCombatTarget({ candidates, allowedConcreteTargets: ['Skull'] }),
    2
  );
});

test('selectUnevenCombatTarget: a candidate with only an incapacitated die in the target set is skipped', () => {
  const candidates = [
    candidate(1, { Skull: 'incapacitated' }),
    candidate(3, { Skull: 'active' }),
  ];
  assert.equal(
    selectUnevenCombatTarget({ candidates, allowedConcreteTargets: ['Skull'] }),
    3
  );
});

test('selectUnevenCombatTarget: null when nobody on that side has an eligible die', () => {
  const candidates = [candidate(1, { Skull: 'incapacitated' })];
  assert.equal(selectUnevenCombatTarget({ candidates, allowedConcreteTargets: ['Skull'] }), null);
});

const declaredMove = (declaredMoveId, placementTic, defenseFramePositions) => ({
  declaredMoveId,
  placementTic,
  defenseFramePositions,
});

test('selectDefenseMove: the first declared move whose Defense Frames touch the attack\'s Active window wins', () => {
  const defenderMoves = [
    declaredMove(1, 10, []), // no Defense Frames at all
    declaredMove(2, 10, [3]), // offset 3 = Tic 13, inside [13, 15)
  ];
  const result = selectDefenseMove({
    defenderMoves,
    attackActiveStart: 13,
    attackActiveEnd: 15,
  });
  assert.deepEqual(result, { declaredMoveId: 2, defenseTics: [13] });
});

test('selectDefenseMove: a Defense Frame entirely outside the Active window doesn\'t count as overlap', () => {
  const defenderMoves = [declaredMove(1, 10, [0])]; // offset 0 = Tic 10, before the window
  const result = selectDefenseMove({
    defenderMoves,
    attackActiveStart: 13,
    attackActiveEnd: 15,
  });
  assert.equal(result, null);
});

test('selectDefenseMove: null (plain Hit) when no declared move overlaps at all', () => {
  const result = selectDefenseMove({
    defenderMoves: [declaredMove(1, 10, [])],
    attackActiveStart: 13,
    attackActiveEnd: 15,
  });
  assert.equal(result, null);
});

// ---------------------------------------------------------------------
// Defence rework: random defender pick, the Active-frames-only rule, the
// no-extending-a-defensive-attack rule, and the cascade shift.
// ---------------------------------------------------------------------

test('selectDefenseMove picks at random among every eligible move', () => {
  const defenderMoves = [
    { declaredMoveId: 1, placementTic: 0, defenseFramePositions: [1] },
    { declaredMoveId: 2, placementTic: 0, defenseFramePositions: [1, 2] },
    { declaredMoveId: 3, placementTic: 9, defenseFramePositions: [0] }, // nowhere near
  ];
  const args = { defenderMoves, attackActiveStart: 1, attackActiveEnd: 3 };
  // The out-of-range move is never eligible whatever the roll says.
  assert.equal(selectDefenseMove({ ...args, random: () => 0 }).declaredMoveId, 1);
  assert.equal(selectDefenseMove({ ...args, random: () => 0.99 }).declaredMoveId, 2);
  // Previously this always returned the first in declaration order; both
  // eligible moves must now be reachable.
  const seen = new Set([0, 0.5, 0.99].map((r) => selectDefenseMove({ ...args, random: () => r }).declaredMoveId));
  assert.deepEqual([...seen].sort(), [1, 2]);
});

test('selectDefenseMove still returns null when nothing overlaps', () => {
  assert.equal(
    selectDefenseMove({
      defenderMoves: [{ declaredMoveId: 1, placementTic: 0, defenseFramePositions: [0] }],
      attackActiveStart: 5,
      attackActiveEnd: 7,
    }),
    null
  );
});

test('defenseFramesWithinActive accepts only Active-phase positions', () => {
  // startup 2, active 3 -> Active frames are positions 2,3,4.
  const shape = { startupTics: 2, activeTics: 3 };
  assert.equal(defenseFramesWithinActive({ ...shape, defenseFramePositions: [2, 3, 4] }), true);
  assert.equal(defenseFramesWithinActive({ ...shape, defenseFramePositions: [3] }), true);
  assert.equal(defenseFramesWithinActive({ ...shape, defenseFramePositions: [1] }), false, 'Startup frame');
  assert.equal(defenseFramesWithinActive({ ...shape, defenseFramePositions: [5] }), false, 'Recovery frame');
  assert.equal(defenseFramesWithinActive({ ...shape, defenseFramePositions: [] }), true, 'no frames is vacuously fine');
});

test('canExtendDefense refuses a move that still has Active frames to come', () => {
  // A pure guard: startup 1, active 2, both Active frames are Defense.
  assert.equal(canExtendDefense({ defenseFramePositions: [1, 2], startupTics: 1, activeTics: 2 }), true);
  // A defensive attack: guards on its first Active frame, then strikes on
  // the second. Extending its Recovery would stretch a move that is going
  // somewhere.
  assert.equal(canExtendDefense({ defenseFramePositions: [1], startupTics: 1, activeTics: 2 }), false);
  assert.equal(canExtendDefense({ defenseFramePositions: [], startupTics: 1, activeTics: 2 }), false);
});

test('cascadeShift pushes every later move forward, recursively', () => {
  // The guard is busy until Tic 5. Two later moves sit at 3 and 4.
  const shifted = cascadeShift({
    blockedUntil: 5,
    moves: [
      { declaredMoveId: 10, placementTic: 3, footprintTics: 2 },
      { declaredMoveId: 11, placementTic: 4, footprintTics: 3 },
    ],
  });
  // The first slides to 5 and occupies 5-6, so the second can't just take 5
  // either — it lands at 7. That knock-on is the whole point.
  assert.deepEqual(shifted, [
    { declaredMoveId: 10, from: 3, to: 5 },
    { declaredMoveId: 11, from: 4, to: 7 },
  ]);
});

test('cascadeShift leaves moves that already sit clear alone', () => {
  const shifted = cascadeShift({
    blockedUntil: 5,
    moves: [
      { declaredMoveId: 10, placementTic: 6, footprintTics: 2 },
      { declaredMoveId: 11, placementTic: 9, footprintTics: 1 },
    ],
  });
  assert.deepEqual(shifted, []);
});

test('cascadeShift only pushes the moves it has to', () => {
  const shifted = cascadeShift({
    blockedUntil: 5,
    moves: [
      { declaredMoveId: 10, placementTic: 4, footprintTics: 1 }, // collides -> 5, ends 6
      { declaredMoveId: 11, placementTic: 8, footprintTics: 1 }, // already clear of 6
    ],
  });
  assert.deepEqual(shifted, [{ declaredMoveId: 10, from: 4, to: 5 }]);
});

// ---------- The movable Minimum Damage Threshold (Iron Skin / Not Just a Scratch) ----------

test('the default threshold is the game rule it has always been', () => {
  assert.equal(MIN_DAMAGE_THRESHOLD, 5);
  // Every existing caller passes no threshold at all, so the default is what
  // keeps this change arithmetically invisible until a Perk moves it.
  assert.equal(computeHitDamage(4).halfDamageSteps, 0);
  assert.equal(computeHitDamage(5).halfDamageSteps, 1);
  assert.equal(computeHitDamage(9).halfDamageSteps, 1);
  assert.equal(computeHitDamage(10).halfDamageSteps, 2);
  assert.equal(computeHitDamage(27).halfDamageSteps, 5);
  // Defensive: a negative result still floors at nothing.
  assert.equal(computeHitDamage(-3).halfDamageSteps, 0);
});

test('lowering the threshold moves the FIRST gate and nothing else', () => {
  // Not Just a Scratch: 5 → 3, so the ladder reads 3-10-15-20.
  const at = (n) => computeHitDamage(n, { minimumThreshold: 3 }).halfDamageSteps;
  assert.equal(at(2), 0, 'still under the bar');
  assert.equal(at(3), 1, 'the new bar deals half a point');
  assert.equal(at(4), 1);
  assert.equal(at(5), 1, 'the old bar is worth the same as the new one — no double step');
  assert.equal(at(9), 1);
  // The gates above the first are untouched: 10 is still exactly where 2 steps
  // begin, not 8.
  assert.equal(at(8), 1);
  assert.equal(at(10), 2);
  assert.equal(at(15), 3);
});

test('raising the threshold moves the FIRST gate and nothing else', () => {
  // Iron Skin: 5 → 7, so the ladder reads 7-10-15-20.
  const at = (n) => computeHitDamage(n, { minimumThreshold: 7 }).halfDamageSteps;
  assert.equal(at(5), 0, 'what used to be half a point is now nothing');
  assert.equal(at(6), 0);
  assert.equal(at(7), 1);
  assert.equal(at(9), 1);
  assert.equal(at(10), 2, 'and the second gate has not moved with it');
  assert.equal(at(20), 4);
});

test('the threshold moves the Full/Partial line too, which is the same rule', () => {
  // A leftover of 6 is a Partial Block normally...
  assert.equal(resolveDefenseRoll({ attackerResult: 16, defenderResult: 10 }).outcome, 'partial');
  // ...and a Full one against Iron Skin, because Partial just means "what got
  // through was enough to deal damage".
  assert.equal(
    resolveDefenseRoll({ attackerResult: 16, defenderResult: 10, minimumThreshold: 7 }).outcome,
    'full'
  );
});

// ---------- Spiked Shell's limb rule ----------

test('a matched pair of limbs both take the riposte', () => {
  // "2 Hands" arrives already resolved to two concrete dice, because a slot
  // listed twice means both sides — nothing extra to do here.
  assert.deepEqual(selectRiposteTargets(['Left Hand', 'Right Hand']), ['Left Hand', 'Right Hand']);
  assert.deepEqual(selectRiposteTargets(['Left Leg', 'Right Leg']), ['Left Leg', 'Right Leg']);
  // One limb on its own is trivially "all of one kind".
  assert.deepEqual(selectRiposteTargets(['Right Hand']), ['Right Hand']);
});

test('a hand and a leg is one of them, at random', () => {
  const slots = ['Left Hand', 'Right Leg'];
  assert.deepEqual(selectRiposteTargets(slots, () => 0), ['Left Hand']);
  assert.deepEqual(selectRiposteTargets(slots, () => 0.99), ['Right Leg']);
});

test('a Roll with no limb in it falls back to whatever Stat did attack', () => {
  // A headbutt still hits the spikes with something.
  assert.deepEqual(selectRiposteTargets(['Skull']), ['Skull']);
  // Two different Stats are a mix of kinds, so one at random — the same rule.
  assert.deepEqual(selectRiposteTargets(['Skull', 'Body'], () => 0), ['Skull']);
  assert.deepEqual(selectRiposteTargets(['Skull', 'Body'], () => 0.99), ['Body']);
});

test('a limb in the Roll outranks a non-limb in it', () => {
  // Punching with a hand while the move also rolls Body: the spikes catch the
  // hand, and Body never enters the draw.
  assert.deepEqual(selectRiposteTargets(['Body', 'Right Hand'], () => 0), ['Right Hand']);
  assert.deepEqual(selectRiposteTargets(['Body', 'Right Hand'], () => 0.99), ['Right Hand']);
});

test('a Roll that names no Stat at all catches on nothing', () => {
  // A Custom Roll — the one attack Spiked Shell cannot reach.
  assert.deepEqual(selectRiposteTargets([]), []);
  assert.deepEqual(selectRiposteTargets(undefined), []);
});
