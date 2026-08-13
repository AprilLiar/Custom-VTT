// The roll-display decomposition shared by the chat roll card and the round
// cutscene's log (client/src/lib/dice.js).
//
// This exists because the cutscene got it wrong for its whole life: a logged
// roll stores only the summed result, and the cutscene printed that result
// as though it were the die face, then appended the modifier separately. A
// d4 came out as "Skull 14 (+11) — total 14", which is why the engine's
// automatic move rolls looked like they ignored every modifier. The dice
// module is plain ESM with no React in it precisely so this can be checked
// here rather than only in a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeRoll, formatRollPart } from '../../client/src/lib/dice.js';

test('decomposeRoll recovers the die face from the summed result', () => {
  // The exact payload the engine emitted in the reproduction: a d4 with a
  // +11 modifier (move Roll Modifier 9 + Reasons to Fight 2) reading 14.
  const die = { slot_name: 'Skull', size: 4, bonus: 0, result: 14 };
  assert.deepEqual(decomposeRoll(die, 11), { flat: 11, raw: 3, result: 14 });
});

test('decomposeRoll folds the die\'s own bonus in with the roll modifier', () => {
  const die = { slot_name: 'Body', size: 8, bonus: 2, result: 15 };
  assert.deepEqual(decomposeRoll(die, 6), { flat: 8, raw: 7, result: 15 });
});

test('decomposeRoll handles a negative modifier', () => {
  // "WeakC rolls Skull -17 (-20) — total -17" was the other face of the bug.
  const die = { slot_name: 'Skull', size: 4, bonus: 0, result: -17 };
  assert.deepEqual(decomposeRoll(die, -20), { flat: -20, raw: 3, result: -17 });
});

test('decomposeRoll with nothing added leaves the face equal to the result', () => {
  assert.deepEqual(decomposeRoll({ bonus: 0, result: 5 }, 0), { flat: 0, raw: 5, result: 5 });
});

test('decomposeRoll treats missing bonus/modifier as zero', () => {
  assert.deepEqual(decomposeRoll({ result: 6 }), { flat: 0, raw: 6, result: 6 });
});

test('the recovered face is always a real face of the die', () => {
  for (const size of [4, 6, 8, 10, 12]) {
    for (const face of [1, size]) {
      for (const modifier of [-20, -3, 0, 5, 11]) {
        for (const bonus of [0, 2]) {
          const { raw } = decomposeRoll({ size, bonus, result: face + bonus + modifier }, modifier);
          assert.equal(raw, face, `d${size} face ${face} bonus ${bonus} mod ${modifier}`);
        }
      }
    }
  }
});

test('formatRollPart shows the addition instead of implying a dropped one', () => {
  assert.equal(formatRollPart({ slot_name: 'Skull', size: 4, bonus: 0, result: 14 }, 11), 'Skull 3 + 11 = 14');
});

test('formatRollPart renders a negative addition with a real minus sign', () => {
  assert.equal(formatRollPart({ slot_name: 'Skull', bonus: 0, result: -17 }, -20), 'Skull 3 − 20 = -17');
});

test('formatRollPart stays terse when there is nothing to add', () => {
  assert.equal(formatRollPart({ slot_name: 'Body', bonus: 0, result: 5 }, 0), 'Body 5');
});

test('formatRollPart accepts the camelCase slot key some payloads carry', () => {
  assert.equal(formatRollPart({ slotName: 'Left Hand', bonus: 1, result: 9 }, 3), 'Left Hand 5 + 4 = 9');
});
