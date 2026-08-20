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
  resolveRollSlotNames,
  expandRollSlotRows,
  collapseRollSlots,
  MAX_AMBIGUOUS_ROLL_SLOT_COUNT,
  sanitizeDefensePositions,
  AMBIGUOUS_ROLL_SLOTS,
  TRIGGERS,
  DEFENSE_TRIGGERS,
  ALL_TRIGGERS,
  sanitizeRollType,
  sanitizeCustomRollSize,
  ATTACK_TARGET_NAMES,
  CONCRETE_ATTACK_TARGET_NAMES,
  sanitizeAttackTargets,
  expandAttackTargets,
  parseConcreteAttackTargets,
  effectiveStaminaCost,
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
  // ALL_TRIGGERS is every trigger that exists, gated or not — the DB's CHECK
  // constraint has to accept all of them. Which ones a given move may
  // actually store is decided per-move by normalizeInteractions' two gates,
  // not by this list.
  assert.deepEqual(ALL_TRIGGERS, [
    'hit',
    'block',
    'miss',
    'defense_success',
    'defense_failure',
    'grapple_success',
  ]);
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

test('roll slots: caps each slot at its own ceiling, drops unknown names, empty = no Roll', () => {
  assert.deepEqual(sanitizeRollSlots(['Body', 'Body', 'Hand']), ['Body', 'Hand']);
  assert.deepEqual(sanitizeRollSlots(['Body', 'Wing', 'Leg']), ['Body', 'Leg']);
  assert.deepEqual(sanitizeRollSlots([]), []);
  assert.deepEqual(sanitizeRollSlots(null), []);
});

test('roll slots: an appendage may be taken twice (= both sides), never more', () => {
  assert.deepEqual(sanitizeRollSlots(['Hand', 'Hand']), ['Hand', 'Hand']);
  assert.deepEqual(sanitizeRollSlots(['Leg', 'Leg', 'Leg']), ['Leg', 'Leg']);
  assert.deepEqual(sanitizeRollSlots(['Hand', 'Hand', 'Leg', 'Leg']), ['Hand', 'Hand', 'Leg', 'Leg']);
  // A concrete Stat stays one-of-a-kind — a character has one Skull.
  assert.deepEqual(sanitizeRollSlots(['Skull', 'Skull']), ['Skull']);
  assert.equal(MAX_AMBIGUOUS_ROLL_SLOT_COUNT, 2);
});

test('roll slots: concrete Left/Right Hand and Leg names are no longer valid — only the ambiguous choice is', () => {
  assert.deepEqual(sanitizeRollSlots(['Left Hand', 'Right Hand', 'Left Leg', 'Right Leg']), []);
});

test('hasAmbiguousRollSlot: true only when Hand or Leg is taken exactly once', () => {
  assert.ok(hasAmbiguousRollSlot(['Body', 'Hand']));
  assert.ok(hasAmbiguousRollSlot(['Leg']));
  assert.ok(!hasAmbiguousRollSlot(['Body', 'Skull', 'Stamina', 'Brain']));
  assert.ok(!hasAmbiguousRollSlot([]));
  // Taking it twice *is* the answer — both sides are used, so there is no
  // Left/Right question left and the move needs only one Tell.
  assert.ok(!hasAmbiguousRollSlot(['Hand', 'Hand']));
  assert.ok(!hasAmbiguousRollSlot(['Hand', 'Hand', 'Leg', 'Leg']));
  // ...but a doubled Hand alongside a single Leg still leaves the Leg open.
  assert.ok(hasAmbiguousRollSlot(['Hand', 'Hand', 'Leg']));
});

test('resolveRollSlotNames: a doubled appendage is both sides, a single one follows the choice', () => {
  assert.deepEqual(resolveRollSlotNames(['Hand', 'Hand']), ['Left Hand', 'Right Hand']);
  assert.deepEqual(resolveRollSlotNames(['Leg', 'Leg']), ['Left Leg', 'Right Leg']);
  // A doubled slot ignores appendage_choice entirely — both sides regardless.
  assert.deepEqual(resolveRollSlotNames(['Hand', 'Hand'], 'right'), ['Left Hand', 'Right Hand']);
  assert.deepEqual(resolveRollSlotNames(['Hand'], 'right'), ['Right Hand']);
  assert.deepEqual(resolveRollSlotNames(['Hand'], 'left'), ['Left Hand']);
  // No choice recorded falls back to Left, the canonical first side.
  assert.deepEqual(resolveRollSlotNames(['Hand']), ['Left Hand']);
  // Concrete slots pass straight through, order preserved.
  assert.deepEqual(resolveRollSlotNames(['Body', 'Hand', 'Hand', 'Skull']), [
    'Body',
    'Left Hand',
    'Right Hand',
    'Skull',
  ]);
});

test('roll slot rows round-trip through the stored one-row-per-slot shape', () => {
  const slots = ['Body', 'Hand', 'Hand'];
  const rows = collapseRollSlots(slots);
  assert.deepEqual(rows, [
    { slot_name: 'Body', count: 1 },
    { slot_name: 'Hand', count: 2 },
  ]);
  assert.deepEqual(expandRollSlotRows(rows), slots);
});

test('expandRollSlotRows: a row written before the count column reads back as one', () => {
  assert.deepEqual(expandRollSlotRows([{ slot_name: 'Hand' }, { slot_name: 'Body', count: null }]), [
    'Hand',
    'Body',
  ]);
  // Never trust a stored count past the slot's own ceiling.
  assert.deepEqual(expandRollSlotRows([{ slot_name: 'Hand', count: 9 }]), ['Hand', 'Hand']);
  assert.deepEqual(expandRollSlotRows([{ slot_name: 'Skull', count: 3 }]), ['Skull']);
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

test('sanitizeRollType: only "custom" survives, anything else falls back to "stat"', () => {
  assert.equal(sanitizeRollType('custom'), 'custom');
  assert.equal(sanitizeRollType('stat'), 'stat');
  assert.equal(sanitizeRollType('junk'), 'stat');
  assert.equal(sanitizeRollType(undefined), 'stat');
});

test('sanitizeCustomRollSize: only a valid die size survives, everything else is null', () => {
  assert.equal(sanitizeCustomRollSize(8), 8);
  assert.equal(sanitizeCustomRollSize('10'), 10);
  assert.equal(sanitizeCustomRollSize(7), null);
  assert.equal(sanitizeCustomRollSize('junk'), null);
  assert.equal(sanitizeCustomRollSize(undefined), null);
});

test('sanitizeAttackTargets: accepts all six values, always in canonical order', () => {
  assert.deepEqual(
    sanitizeAttackTargets(['Leg', 'Skull', 'Hand', 'Brain', 'Body', 'Stamina']),
    ATTACK_TARGET_NAMES
  );
});

test('sanitizeAttackTargets: dedupes', () => {
  assert.deepEqual(sanitizeAttackTargets(['Skull', 'Skull', 'Hand']), ['Skull', 'Hand']);
});

test('sanitizeAttackTargets: drops unknown and non-array input', () => {
  assert.deepEqual(sanitizeAttackTargets(['Skull', 'Left Hand', 'Wing']), ['Skull']);
  assert.deepEqual(sanitizeAttackTargets(null), []);
  assert.deepEqual(sanitizeAttackTargets(undefined), []);
});

test('sanitizeAttackTargets: empty array stays empty (a valid Attack Target value)', () => {
  assert.deepEqual(sanitizeAttackTargets([]), []);
});

test('expandAttackTargets: Hand + Leg with no appendage choice expands to both sides', () => {
  assert.deepEqual(expandAttackTargets(['Hand', 'Leg']), [
    'Left Hand',
    'Right Hand',
    'Left Leg',
    'Right Leg',
  ]);
});

test("expandAttackTargets: appendageChoice = 'left' narrows to Left Hand/Left Leg only", () => {
  assert.deepEqual(expandAttackTargets(['Hand', 'Leg'], 'left'), ['Left Hand', 'Left Leg']);
});

test("expandAttackTargets: appendageChoice = 'right' narrows to Right Hand/Right Leg only", () => {
  assert.deepEqual(expandAttackTargets(['Hand', 'Leg'], 'right'), ['Right Hand', 'Right Leg']);
});

test('expandAttackTargets: plain slots pass through alongside a resolved appendage', () => {
  // sanitizeAttackTargets normalizes to canonical ATTACK_TARGET_NAMES order
  // first (Hand before Body), so the expansion reflects that order too.
  assert.deepEqual(expandAttackTargets(['Body', 'Hand'], 'right'), ['Right Hand', 'Body']);
});

test('expandAttackTargets: empty input yields empty', () => {
  assert.deepEqual(expandAttackTargets([]), []);
});

test('parseConcreteAttackTargets: parses valid JSON array of concrete names', () => {
  assert.deepEqual(
    parseConcreteAttackTargets('["Skull","Right Hand"]'),
    ['Skull', 'Right Hand']
  );
});

test('parseConcreteAttackTargets: drops abstract/unknown names and non-array/malformed JSON', () => {
  assert.deepEqual(parseConcreteAttackTargets('["Skull","Hand","Wing"]'), ['Skull']);
  assert.deepEqual(parseConcreteAttackTargets('not json'), []);
  assert.deepEqual(parseConcreteAttackTargets('{}'), []);
});

test('CONCRETE_ATTACK_TARGET_NAMES has exactly the 8 concrete Stats', () => {
  assert.deepEqual(CONCRETE_ATTACK_TARGET_NAMES, [
    'Skull',
    'Brain',
    'Left Hand',
    'Stamina',
    'Body',
    'Right Hand',
    'Left Leg',
    'Right Leg',
  ]);
});

// ---------- Perk-adjusted Stamina Cost (Perfect Player) ----------

test('a move with no Perk touching it costs exactly what it says', () => {
  assert.equal(effectiveStaminaCost(3, 0), 3);
  assert.equal(effectiveStaminaCost(0, 0), 0);
  // No delta at all is the same as a zero one — the resolver calls it both ways.
  assert.equal(effectiveStaminaCost(4), 4);
});

test('a discount comes off, and stops at free', () => {
  assert.equal(effectiveStaminaCost(3, -2), 1);
  assert.equal(effectiveStaminaCost(2, -2), 0);
  // **The floor is the point.** A Perk can make a move free; it can never pay
  // you to throw one, which is what stacking two discounts would otherwise do.
  assert.equal(effectiveStaminaCost(1, -2), 0);
  assert.equal(effectiveStaminaCost(1, -20), 0);
});

test('a surcharge adds on, and rubbish is treated as no delta', () => {
  assert.equal(effectiveStaminaCost(3, 2), 5);
  assert.equal(effectiveStaminaCost(3, undefined), 3);
  assert.equal(effectiveStaminaCost(3, NaN), 3);
  assert.equal(effectiveStaminaCost(null, -2), 0);
  // Truncated, not rounded — a cost is a whole number of Stamina.
  assert.equal(effectiveStaminaCost(3, -1.9), 2);
});
