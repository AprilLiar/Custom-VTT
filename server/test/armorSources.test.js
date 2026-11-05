// Armor sources (client/src/lib/panicTokens.js): lasting Armor, Always or per Stance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { innateArmor, normalizeArmorSources } from '../../client/src/lib/panicTokens.js';

test('sources are cleaned: "always" or a stance id, at most 9', () => {
  assert.deepEqual(normalizeArmorSources(['always', 3, 'x', -1, 2.5, null, 7]), ['always', 3, 7]);
  assert.deepEqual(normalizeArmorSources('always'), []);
  assert.equal(normalizeArmorSources(Array(20).fill('always')).length, 9);
});

test('each source that holds adds 1: Always, plus those of the current Stance', () => {
  const src = ['always', 4, 4, 9];
  assert.equal(innateArmor(src, 4), 3);
  assert.equal(innateArmor(src, 9), 2);
  assert.equal(innateArmor(src, 1), 1);
  assert.equal(innateArmor(src, null), 1);
  assert.equal(innateArmor([], 4), 0);
});

test('a derived Stance key is a source too (builder phase 2)', () => {
  const k = 'form.iron+style.halcyon';
  assert.deepEqual(normalizeArmorSources(['always', k, 'not a key']), ['always', k]);
  assert.equal(innateArmor(['always', k, k], k), 3);
  assert.equal(innateArmor(['always', k], 'form.power+style.halcyon'), 1);
});
