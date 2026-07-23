import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STYLES, DEFEATS, COUNTER_BONUS } from '../ruleset.js';

const names = STYLES.map((s) => s.name);

test('7 uniquely named styles, each with an icon', () => {
  assert.equal(STYLES.length, 7);
  assert.equal(new Set(names).size, 7);
  assert.ok(STYLES.every((s) => s.icon.length > 0));
});

test('every style defeats exactly 3 known styles, never itself', () => {
  for (const name of names) {
    const victims = DEFEATS[name];
    assert.equal(victims.length, 3, `${name} defeats ${victims.length}`);
    assert.equal(new Set(victims).size, 3, `${name} has duplicate victims`);
    assert.ok(!victims.includes(name), `${name} defeats itself`);
    for (const v of victims) assert.ok(names.includes(v), `${name} defeats unknown ${v}`);
  }
});

test('every style is defeated by exactly 3 others', () => {
  for (const name of names) {
    const defeatedBy = names.filter((other) => DEFEATS[other].includes(name));
    assert.equal(defeatedBy.length, 3, `${name} defeated by ${defeatedBy.length}`);
  }
});

test('complete tournament: every pair has exactly one winner', () => {
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const aBeatsB = DEFEATS[names[i]].includes(names[j]);
      const bBeatsA = DEFEATS[names[j]].includes(names[i]);
      assert.ok(
        aBeatsB !== bBeatsA,
        `${names[i]} vs ${names[j]}: aBeatsB=${aBeatsB} bBeatsA=${bBeatsA}`
      );
    }
  }
});

test('21 edges total at +2 each', () => {
  const edges = Object.values(DEFEATS).flat().length;
  assert.equal(edges, 21);
  assert.equal(COUNTER_BONUS, 2);
});
