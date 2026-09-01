// client/src/lib/quirkStyles.js — the two sides of a Quirk.
//
// Lives in server/test because that is where `npm test` looks; the module is
// pure ES with no DOM imports, so it loads cleanly here.
//
// What is worth pinning is small but load-bearing in three places at once (the
// Compendium's shelf, the sheet's tab, the Creator's step): **an unrecognised
// `kind` must land on a side rather than on neither.** A Quirk that answers
// `undefined` here renders in no column and with no colour, which looks exactly
// like a Quirk that failed to save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUIRK_KINDS, quirkKind, quirkStyle, splitQuirks } from '../../client/src/lib/quirkStyles.js';

test('anything that is not exactly "negative" is a positive', () => {
  assert.equal(quirkKind('negative'), 'negative');
  for (const value of ['positive', 'Negative', 'NEGATIVE', '', null, undefined, 0, 'bad']) {
    assert.equal(quirkKind(value), 'positive', `${JSON.stringify(value)} should fall to positive`);
  }
});

test('every kind has a complete style, and the two do not share one', () => {
  const keys = ['label', 'card', 'heading', 'chip', 'toggleOn', 'column'];
  for (const kind of QUIRK_KINDS) {
    const style = quirkStyle(kind);
    for (const key of keys) {
      assert.equal(typeof style[key], 'string', `${kind}.${key}`);
      assert.ok(style[key].length, `${kind}.${key} is empty`);
    }
  }
  // The one thing a reader actually decodes: the two sides must not look alike.
  for (const key of keys) {
    assert.notEqual(
      quirkStyle('positive')[key],
      quirkStyle('negative')[key],
      `positive and negative share a ${key}`
    );
  }
  // ...and neither may reach for the runtime-themeable brand hue, which a world
  // themed green would repaint every negative Quirk with.
  for (const kind of QUIRK_KINDS) {
    for (const key of keys) {
      assert.ok(!quirkStyle(kind)[key].includes('brand-'), `${kind}.${key} uses a brand token`);
    }
  }
});

test('splitQuirks puts every Quirk in exactly one column', () => {
  const list = [
    { name: 'a', kind: 'positive' },
    { name: 'b', kind: 'negative' },
    { name: 'c' }, // no kind at all — must still land somewhere
    { name: 'd', kind: 'NEGATIVE' }, // mis-cased — a positive, per the rule above
  ];
  const split = splitQuirks(list);
  assert.deepEqual(split.positive.map((q) => q.name), ['a', 'c', 'd']);
  assert.deepEqual(split.negative.map((q) => q.name), ['b']);
  assert.equal(split.positive.length + split.negative.length, list.length, 'nothing may be dropped');
});

test('splitQuirks survives an absent list', () => {
  // The sheet renders before its first fetch lands, and a column that throws
  // there takes the whole tab with it.
  for (const empty of [undefined, null, []]) {
    const split = splitQuirks(empty);
    assert.deepEqual(split.positive, []);
    assert.deepEqual(split.negative, []);
  }
});
