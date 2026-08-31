import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DICE_TEMPLATE,
  clampModifier,
  computeMaxStamina,
  stepDie,
  rankOf,
  applyRankPenalty,
  applyHalfDamage, healHalfDamage,
} from '../gameLogic.js';

const die = (current_size, bonus = 0, status = 'active') => ({ current_size, bonus, status });

test('dice template is 2 head + 4 core + 2 legs', () => {
  assert.equal(DICE_TEMPLATE.length, 8);
  const byPool = Object.groupBy(DICE_TEMPLATE, (d) => d.pool);
  assert.equal(byPool.head.length, 2);
  assert.equal(byPool.core.length, 4);
  assert.equal(byPool.legs.length, 2);
  assert.ok(DICE_TEMPLATE.some((d) => d.slot_name === 'Stamina' && d.pool === 'core'));
});

test('step up walks d4 -> d6 -> d8 -> d10 -> d12', () => {
  let d = die(4);
  for (const expected of [6, 8, 10, 12]) {
    d = { ...d, ...stepDie(d, 'up') };
    assert.equal(d.current_size, expected);
    assert.equal(d.bonus, 0);
  }
});

test('step up past d12 stacks bonus instead of size', () => {
  let d = die(12);
  d = { ...d, ...stepDie(d, 'up') };
  assert.deepEqual(d, die(12, 1));
  d = { ...d, ...stepDie(d, 'up') };
  assert.deepEqual(d, die(12, 2));
});

test('step down unwinds bonus before size', () => {
  let d = die(12, 2);
  d = { ...d, ...stepDie(d, 'down') };
  assert.deepEqual(d, die(12, 1));
  d = { ...d, ...stepDie(d, 'down') };
  assert.deepEqual(d, die(12, 0));
  d = { ...d, ...stepDie(d, 'down') };
  assert.deepEqual(d, die(10, 0));
});

test('step down from bare d4 incapacitates', () => {
  assert.deepEqual(stepDie(die(4), 'down'), die(4, 0, 'incapacitated'));
});

test('incapacitated die cannot step further down', () => {
  const incap = die(4, 0, 'incapacitated');
  assert.deepEqual(stepDie(incap, 'down'), incap);
});

test('step up revives an incapacitated die to a fresh d4', () => {
  assert.deepEqual(stepDie(die(10, 3, 'incapacitated'), 'up'), die(4, 0, 'active'));
});

test('full ladder down: d12+1 to incapacitated takes 6 steps', () => {
  let d = die(12, 1);
  let steps = 0;
  while (d.status === 'active') {
    d = { ...d, ...stepDie(d, 'down') };
    steps++;
  }
  assert.equal(steps, 6); // +1 -> 12 -> 10 -> 8 -> 6 -> 4 -> incapacitated
});

test('modifier clamps to +/-20 and coerces junk to 0', () => {
  assert.equal(clampModifier(5), 5);
  assert.equal(clampModifier(-5), -5);
  assert.equal(clampModifier(200), 20);
  assert.equal(clampModifier(-200), -20);
  assert.equal(clampModifier('7'), 7);
  assert.equal(clampModifier('junk'), 0);
  assert.equal(clampModifier(undefined), 0);
  assert.equal(clampModifier(3.9), 3);
});

test('max stamina = multiplier x (locked size + locked bonus)', () => {
  assert.equal(computeMaxStamina(4, 8, 0), 32); // fresh character
  assert.equal(computeMaxStamina(4, 12, 2), 56);
  assert.equal(computeMaxStamina(5, 10, 0), 50); // future Perk-adjusted multiplier
});

test('rankOf: d4 is 0, d12 is 4, bonus stacks past that', () => {
  assert.equal(rankOf(4, 0), 0);
  assert.equal(rankOf(6, 0), 1);
  assert.equal(rankOf(12, 0), 4);
  assert.equal(rankOf(12, 2), 6);
});

test('applyRankPenalty: zero penalty or already-incapacitated is a no-op', () => {
  assert.deepEqual(applyRankPenalty({ size: 8, bonus: 0, status: 'active' }, 0), {
    size: 8,
    bonus: 0,
    status: 'active',
  });
  assert.deepEqual(applyRankPenalty({ size: 4, bonus: 0, status: 'incapacitated' }, 2), {
    size: 4,
    bonus: 0,
    status: 'incapacitated',
  });
});

test('applyRankPenalty: steps the size down by however many ranks the penalty is', () => {
  assert.deepEqual(applyRankPenalty({ size: 10, bonus: 0, status: 'active' }, 2), {
    size: 6,
    bonus: 0,
    status: 'active',
  });
});

test('applyRankPenalty: eats into stacked bonus before dropping below d12', () => {
  assert.deepEqual(applyRankPenalty({ size: 12, bonus: 2, status: 'active' }, 1), {
    size: 12,
    bonus: 1,
    status: 'active',
  });
});

test('applyRankPenalty: a penalty deep enough to push rank below d4 incapacitates instead of going negative', () => {
  assert.deepEqual(applyRankPenalty({ size: 4, bonus: 0, status: 'active' }, 1), {
    size: 4,
    bonus: 0,
    status: 'incapacitated',
  });
  assert.deepEqual(applyRankPenalty({ size: 8, bonus: 0, status: 'active' }, 10), {
    size: 4,
    bonus: 0,
    status: 'incapacitated',
  });
});

test('applyHalfDamage: not yet half-damaged just sets the flag, no size change', () => {
  assert.deepEqual(
    applyHalfDamage({ current_size: 8, bonus: 0, status: 'active', half_damage: false }),
    { current_size: 8, bonus: 0, status: 'active', half_damage: true }
  );
});

test('applyHalfDamage: already half-damaged clears the flag and steps the die down one rank', () => {
  assert.deepEqual(
    applyHalfDamage({ current_size: 10, bonus: 0, status: 'active', half_damage: true }),
    { current_size: 8, bonus: 0, status: 'active', half_damage: false }
  );
  // bonus unwinds before size, same as a manual step down
  assert.deepEqual(
    applyHalfDamage({ current_size: 12, bonus: 2, status: 'active', half_damage: true }),
    { current_size: 12, bonus: 1, status: 'active', half_damage: false }
  );
});

test('applyHalfDamage: stepping down from a bare d4 while half-damaged incapacitates', () => {
  assert.deepEqual(
    applyHalfDamage({ current_size: 4, bonus: 0, status: 'active', half_damage: true }),
    { current_size: 4, bonus: 0, status: 'incapacitated', half_damage: false }
  );
});

// --- healHalfDamage: the exact inverse -------------------------------------

test('healHalfDamage undoes exactly what applyHalfDamage did, from anywhere', () => {
  // The Temporary Damage Tag gives back precisely what it took, so this has to
  // be a true mirror rather than "step it up a bit". Swept across every die
  // size, both bonus and no bonus, both half states.
  const states = [];
  for (const size of [4, 6, 8, 10, 12]) {
    for (const bonus of [0, 1, 3]) {
      for (const half of [false, true]) {
        if (size < 12 && bonus > 0) continue; // a bonus only exists past d12
        states.push({ current_size: size, bonus, status: 'active', half_damage: half });
      }
    }
  }
  states.push({ current_size: 4, bonus: 0, status: 'incapacitated', half_damage: false });
  for (const start of states) {
    const hurt = applyHalfDamage(start);
    assert.deepEqual(healHalfDamage(hurt), start, JSON.stringify(start));
  }
});

test('healHalfDamage walks a Stat back out of being destroyed', () => {
  // The whole reason the Tag can destroy a Stat and still be temporary.
  const bareD4 = { current_size: 4, bonus: 0, status: 'active', half_damage: true };
  const out = applyHalfDamage(bareD4);
  assert.equal(out.status, 'incapacitated', 'the fixture has to actually break it');
  assert.deepEqual(healHalfDamage(out), bareD4, 'and it comes back exactly as it went');
});

test('healHalfDamage is a HALF step, not a whole rank', () => {
  // Two heals climb one die size, the same way two hits drop one.
  const once = healHalfDamage({ current_size: 6, bonus: 0, status: 'active', half_damage: false });
  assert.equal(once.current_size, 8);
  assert.equal(once.half_damage, true, 'the other half of the step is still owed');
  const twice = healHalfDamage(once);
  assert.equal(twice.current_size, 8);
  assert.equal(twice.half_damage, false);
});
