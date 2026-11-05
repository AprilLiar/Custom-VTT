import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitGates } from '../../client/src/lib/patd/gates.js';

test("an Action's rules text splits into its base and a list of Gates", () => {
  const r = splitGates('Deal 1 damage to an enemy within range. 3+: Deal 2 damage instead. 5+: Deal 3 damage instead, and Push 1. 10+: Also heal 1.');
  assert.equal(r.base, 'Deal 1 damage to an enemy within range.');
  assert.deepEqual(r.gates.map((g) => g.threshold), ['3+', '5+', '10+']);
  assert.equal(r.gates[1].text, 'Deal 3 damage instead, and Push 1.');
  assert.deepEqual(splitGates('No gates here.\nTwo lines.'), { base: 'No gates here.\nTwo lines.', gates: [] });
});
