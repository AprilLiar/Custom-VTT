import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DICE_TEMPLATE,
  clampModifier,
  computeMaxStamina,
  stepDie,
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
