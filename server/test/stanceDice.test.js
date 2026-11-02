// A Stance's dice pool (client/src/lib/stanceDice.js): validation, rolling,
// and the book-style description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDice, normalizeDice, normalizeSlot, rollStance } from '../../client/src/lib/stanceDice.js';

test('a slot is a d4-d12 die or a fixed number 0-12', () => {
  assert.deepEqual(normalizeSlot({ die: 6 }), { die: 6 });
  assert.deepEqual(normalizeSlot({ die: '12' }), { die: 12 });
  assert.deepEqual(normalizeSlot({ fixed: 0 }), { fixed: 0 });
  assert.deepEqual(normalizeSlot({ fixed: 12 }), { fixed: 12 });
  for (const bad of [{ die: 20 }, { die: 3 }, { fixed: 13 }, { fixed: -1 }, { fixed: 2.5 }, {}, null, 'd6']) {
    assert.equal(normalizeSlot(bad), null, JSON.stringify(bad));
  }
});

test('a pool is 1 to 8 valid slots, all or nothing', () => {
  assert.deepEqual(normalizeDice([{ die: 10 }, { fixed: 5 }]), [{ die: 10 }, { fixed: 5 }]);
  assert.equal(normalizeDice([]), null);
  assert.equal(normalizeDice(Array.from({ length: 9 }, () => ({ die: 6 }))), null);
  assert.equal(normalizeDice([{ die: 6 }, { die: 7 }]), null);
  assert.equal(normalizeDice('d6'), null);
  assert.equal(normalizeDice(Array.from({ length: 8 }, () => ({ die: 4 }))).length, 8);
});

test('rolling gives one result per slot, in order, within each die', () => {
  const pool = [{ die: 4 }, { die: 12 }, { fixed: 7 }];
  for (let i = 0; i < 500; i++) {
    const r = rollStance(pool);
    assert.equal(r.length, 3);
    assert.ok(r[0].result >= 1 && r[0].result <= 4);
    assert.ok(r[1].result >= 1 && r[1].result <= 12);
    assert.deepEqual(r[2], { fixed: 7, result: 7 });
  }
  assert.deepEqual(rollStance([{ die: 6 }], () => 0.9999999), [{ die: 6, result: 6 }]);
  assert.deepEqual(rollStance([{ die: 6 }], () => 0), [{ die: 6, result: 1 }]);
});

test('a pool reads the way the book writes Action Dice', () => {
  assert.equal(describeDice([{ die: 10 }, { die: 6 }, { die: 6 }, { fixed: 5 }]), 'd10 d6 d6 5');
});
