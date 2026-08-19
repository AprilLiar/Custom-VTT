// The roll-display decomposition shared by the chat roll card and the round
// cutscene's log (client/src/lib/dice.js), and the total it is paired with.
//
// Two bugs live behind this file. The first: a logged roll stores only summed
// results, and the cutscene printed one as though it were the die face, then
// appended the modifier separately — a d4 came out as "Skull 14 (+11) — total
// 14", which is why the engine's automatic move rolls looked like they ignored
// every modifier. The second, and the reason the split changed shape: the
// modifier used to be added to EVERY die, so a move rolling three Stats at +3
// collected +9. It is applied once to the total now (rollTotal in
// server/gameLogic.js), which is what a modifier on a roll has always meant.
//
// The dice module is plain ESM with no React in it precisely so this can be
// checked here rather than only in a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeRoll, formatRollPart, formatRollTotal } from '../../client/src/lib/dice.js';
import { rollTotal } from '../gameLogic.js';

test('decomposeRoll recovers the die face from the summed result', () => {
  // Face 3 on a d4 with no bonus of its own.
  const die = { slot_name: 'Skull', size: 4, bonus: 0, result: 3 };
  assert.deepEqual(decomposeRoll(die), { flat: 0, raw: 3, result: 3 });
});

test("decomposeRoll subtracts the die's OWN bonus, and only that", () => {
  const die = { slot_name: 'Body', size: 8, bonus: 2, result: 9 };
  assert.deepEqual(decomposeRoll(die), { flat: 2, raw: 7, result: 9 });
});

test('decomposeRoll ignores the roll modifier entirely — it is not in the die', () => {
  // The whole point of the change: a shared modifier no longer rides each
  // die, so nothing about it belongs in this decomposition.
  const die = { slot_name: 'Skull', size: 4, bonus: 0, result: 3 };
  assert.equal(decomposeRoll(die).raw, 3);
});

test('decomposeRoll treats a missing bonus as zero', () => {
  assert.deepEqual(decomposeRoll({ result: 6 }), { flat: 0, raw: 6, result: 6 });
});

test('the recovered face is always a real face of the die', () => {
  for (const size of [4, 6, 8, 10, 12]) {
    for (const face of [1, size]) {
      for (const bonus of [0, 2]) {
        const { raw } = decomposeRoll({ size, bonus, result: face + bonus });
        assert.equal(raw, face, `d${size} face ${face} bonus ${bonus}`);
      }
    }
  }
});

test('formatRollPart shows the addition instead of implying a dropped one', () => {
  assert.equal(formatRollPart({ slot_name: 'Skull', size: 4, bonus: 2, result: 5 }), 'Skull 3 + 2 = 5');
});

test('formatRollPart renders a negative bonus with a real minus sign', () => {
  assert.equal(formatRollPart({ slot_name: 'Skull', bonus: -2, result: 1 }), 'Skull 3 − 2 = 1');
});

test('formatRollPart stays terse when there is nothing to add', () => {
  assert.equal(formatRollPart({ slot_name: 'Body', bonus: 0, result: 5 }), 'Body 5');
});

test('formatRollPart accepts the camelCase slot key some payloads carry', () => {
  assert.equal(formatRollPart({ slotName: 'Left Hand', bonus: 1, result: 9 }), 'Left Hand 8 + 1 = 9');
});

// ---------- the total ----------

test('rollTotal: the modifier is added ONCE, not once per die', () => {
  const dice = [{ result: 4 }, { result: 5 }, { result: 6 }];
  // The bug this replaces: 3 dice at +3 used to come out as 15 + 9 = 24.
  assert.equal(rollTotal(dice, 3), 18);
});

test('rollTotal: a single die is unchanged by the rule', () => {
  assert.equal(rollTotal([{ result: 7 }], 3), 10);
});

test('rollTotal: no modifier is just the sum, and no dice is just the modifier', () => {
  assert.equal(rollTotal([{ result: 7 }, { result: 2 }]), 9);
  assert.equal(rollTotal([], 4), 4);
  assert.equal(rollTotal(undefined, 4), 4);
});

test('rollTotal: a negative modifier subtracts once', () => {
  assert.equal(rollTotal([{ result: 4 }, { result: 4 }], -5), 3);
});

test('rollTotal: a non-numeric modifier is ignored rather than poisoning the sum', () => {
  for (const bad of [undefined, null, NaN, Infinity, 'three']) {
    assert.equal(rollTotal([{ result: 4 }], bad), 4, String(bad));
  }
});

test('formatRollTotal spells the modifier out, and stays quiet without one', () => {
  const dice = [{ result: 4 }, { result: 5 }];
  assert.equal(formatRollTotal(dice, 3, 12), '9 + 3 = 12');
  assert.equal(formatRollTotal(dice, -3, 6), '9 − 3 = 6');
  assert.equal(formatRollTotal(dice, 0, 9), '9');
});

test('the printed parts and the printed total describe the same arithmetic', () => {
  // The property that actually matters on screen: whatever the per-die lines
  // add up to, plus the modifier shown on the total line, is the total.
  const dice = [
    { slot_name: 'Skull', size: 8, bonus: 1, result: 6 },
    { slot_name: 'Body', size: 6, bonus: 0, result: 3 },
  ];
  const modifier = 4;
  const shownFaces = dice.map((d) => decomposeRoll(d));
  const rebuilt = shownFaces.reduce((sum, f) => sum + f.raw + f.flat, 0) + modifier;
  assert.equal(rebuilt, rollTotal(dice, modifier));
});
