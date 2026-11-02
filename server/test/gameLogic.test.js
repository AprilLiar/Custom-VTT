// The Dice Tray's dice math (see server/gameLogic.js). The dice-pool system this
// file used to test — stepping Stat dice, Half-Damage, Injury penalties, max
// Stamina — went with the old system in the pivot. rollTotal is pinned in
// rollDisplay.test.js, beside the client code that decomposes its result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DIE_SIZES, MODIFIER_LIMIT, clampModifier, rollDie } from '../gameLogic.js';

test('modifier clamps to +/-20 and coerces junk to 0', () => {
  assert.equal(MODIFIER_LIMIT, 20);
  assert.equal(clampModifier(5), 5);
  assert.equal(clampModifier(-5), -5);
  assert.equal(clampModifier(200), 20);
  assert.equal(clampModifier(-200), -20);
  assert.equal(clampModifier('7'), 7);
  assert.equal(clampModifier('junk'), 0);
  assert.equal(clampModifier(undefined), 0);
  assert.equal(clampModifier(3.9), 3);
});

test('the Dice Tray offers d4 through d12', () => {
  assert.deepEqual(DIE_SIZES, [4, 6, 8, 10, 12]);
});

test('rollDie lands on every face from 1 to size, and nothing else', () => {
  for (const size of DIE_SIZES) {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const face = rollDie(size);
      assert.ok(Number.isInteger(face) && face >= 1 && face <= size, `d${size} rolled ${face}`);
      seen.add(face);
    }
    assert.equal(seen.size, size, `d${size} never rolled some face in 2000 tries`);
  }
});
