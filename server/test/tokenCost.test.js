// Paying an Action's token cost on the dice board (client/src/lib/patd/tokenCost.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { affordableOptions, planPayment, tokenOptions } from '../../client/src/lib/patd/tokenCost.js';
import { splitGates } from '../../client/src/lib/patd/gates.js';

const idx = patdContent();
const A = (id) => idx.get(id);
const st = (over = {}) => ({ tokens: {}, hp: 10, shield: 0, challengeHolders: [], ...over });

test('only the options you can afford are offered', () => {
  const youStay = A('action.style-armored.you-stay'); // 2 Iron or 5 Iron
  assert.deepEqual(affordableOptions(youStay, st({ tokens: { iron: 1 } })), []);
  assert.deepEqual(affordableOptions(youStay, st({ tokens: { iron: 3 } })).map((o) => o.label), ['2 Iron tokens']);
  assert.equal(affordableOptions(youStay, st({ tokens: { iron: 6 } })).length, 2);
});

test('a single fixed way to pay needs no questions', () => {
  const dance = A('action.form-dance.dance-together'); // 3 Speed
  const [o] = affordableOptions(dance, st({ tokens: { speed: 4 } }));
  assert.deepEqual(o.choices, []);
  assert.deepEqual(planPayment(dance, o.index, {}, st({ tokens: { speed: 4 } })), { tokens: { speed: 3 }, hp: 0, shield: 0, holderId: null, rating: 3 });
});

test('Basic tokens: a split is asked only when there is more than one way, and must add up', () => {
  const swift = A('action.style-swift.swift-strike'); // 2 Basic
  assert.deepEqual(affordableOptions(swift, st({ tokens: { iron: 1, power: 1 } }))[0].choices, [], 'exactly 2 held: only one way');
  const [o] = affordableOptions(swift, st({ tokens: { iron: 2, speed: 3 } }));
  assert.deepEqual(o.choices, [{ kind: 'split', amount: 2, keys: ['iron', 'speed'] }], 'only the kinds held are offered');
  const s = st({ tokens: { iron: 2, speed: 3 } });
  assert.ok(planPayment(swift, o.index, { split: { iron: 1 } }, s).error);
  assert.deepEqual(planPayment(swift, o.index, { split: { iron: 1, speed: 1 } }, s).tokens, { iron: 1, speed: 1 });
  assert.ok(planPayment(swift, o.index, { split: { iron: 3 } }, s).error, 'not more than held');
});

test('HP X, the Shield and your Challenge', () => {
  const badLuck = A('action.style-misfortunes.bad-luck'); // X HP, 1-4
  const [o] = affordableOptions(badLuck, st({ hp: 3 }));
  assert.deepEqual(o.choices, [{ kind: 'hp', minimum: 1, maximum: 3 }]);
  assert.equal(planPayment(badLuck, o.index, { hp: 2 }, st({ hp: 3 })).rating, 2);
  const brambles = A('action.form-thorns.brambles'); // destroy your Shield
  assert.deepEqual(affordableOptions(brambles, st()), []);
  assert.deepEqual(planPayment(brambles, tokenOptions(brambles)[0].index, {}, st({ shield: 4 })), { tokens: {}, hp: 0, shield: 4, holderId: null, rating: 4 });
  const taunt = A('action.style-taunting.not-good-enough'); // your Challenge token
  const two = st({ challengeHolders: [{ id: 5, name: 'A' }, { id: 6, name: 'B' }] });
  assert.equal(affordableOptions(taunt, two)[0].choices[0].kind, 'holder');
  assert.equal(planPayment(taunt, tokenOptions(taunt)[0].index, { holderId: 6 }, two).holderId, 6);
  assert.equal(affordableOptions(taunt, st({ challengeHolders: [{ id: 5, name: 'A' }] }))[0].choices.length, 0);
});

test('a dice-or-tokens Action offers only its token way here; cost Gates are split out', () => {
  const surge = A('action.style-aura.aura-surge'); // 4+ or 1 Poltergeist
  assert.deepEqual(tokenOptions(surge).map((o) => o.index), [1]);
  const g = splitGates(A('action.style-armored.you-stay').rulesText).gates;
  assert.deepEqual(g.map((x) => [x.threshold, x.kind, x.n]), [['5 Iron', 'cost', 5]]);
});
