// Cinematic Weight and level bonuses (client/src/lib/cinematicWeight.js),
// pinned against the book's tables (p.38-40, 102, 107, 110, 272).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEIGHT_BY_KEY, barHp, bonusDie, bonusHp, crossesBleed } from '../../client/src/lib/cinematicWeight.js';

// HP and Heal from the 1e patch (decided, patch review); Bleed 20% of a bar.
test('the five weight classes: HP per bar, Heal, Bleed, Super Moves', () => {
  const row = (k) => { const w = WEIGHT_BY_KEY[k]; return [w.hp, w.heal, w.bleed, w.supers]; };
  assert.deepEqual(row('feather'), [8, 1, 2, 0]);
  assert.deepEqual(row('light'), [12, 2, 2, 1]);
  assert.deepEqual(row('middle'), [16, 2, 3, 1]);
  assert.deepEqual(row('heavy'), [20, 3, 4, 1]);
  assert.deepEqual(row('world'), [25, 4, 5, 2]);
});

test('Hero bonus HP follows the table, not level - 1 (the jump at 6)', () => {
  assert.deepEqual([1, 2, 5, 6, 10].map((l) => bonusHp('hero', l)), [0, 1, 4, 6, 10]);
});

test('Warriors level faster', () => {
  assert.deepEqual([1, 2, 4, 6, 10].map((l) => bonusHp('warrior', l)), [0, 2, 5, 8, 15]);
});

test('levels are clamped to 1-10', () => {
  assert.equal(bonusHp('hero', 0), 0);
  assert.equal(bonusHp('hero', 99), 10);
});

test('bar HP = weight HP + bonus', () => {
  assert.equal(barHp('middle', 'hero', 6), 22);
  assert.equal(barHp('world', 'warrior', 10), 40);
});

test('the Bonus Die from level 2, a size up every even level', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(bonusDie), [null, 4, 4, 6, 6, 8, 8, 10, 10, 12]);
});

test('Bleeding is crossing into the Bleed range, not being in it', () => {
  assert.equal(crossesBleed(10, 4, 4), true);
  assert.equal(crossesBleed(5, 0, 4), true);
  assert.equal(crossesBleed(4, 2, 4), false, 'already Bleeding');
  assert.equal(crossesBleed(10, 5, 4), false);
  assert.equal(crossesBleed(10, 0, null), false, 'no weight set');
});
