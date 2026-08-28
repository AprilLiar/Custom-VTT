// client/src/lib/emojiFavourites.js — the emoji picker's favourites row.
//
// Lives in server/test because that is where `npm test` looks. The module
// touches `localStorage`, which does not exist in node, so each test that needs
// it installs a stub — including one that THROWS on every access, which is what
// a private window actually does and the reason both sides are wrapped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FAVOURITES,
  isFavourite,
  loadFavourites,
  saveFavourites,
  toggleFavourite,
} from '../../client/src/lib/emojiFavourites.js';

const withStorage = (impl, body) => {
  const had = 'localStorage' in globalThis;
  const previous = globalThis.localStorage;
  globalThis.localStorage = impl;
  try {
    body();
  } finally {
    if (had) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
  }
};

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
};

const throwingStorage = () => ({
  getItem() {
    throw new DOMException('denied');
  },
  setItem() {
    throw new DOMException('denied');
  },
});

test('toggling adds to the FRONT, and toggling again removes', () => {
  let list = [];
  list = toggleFavourite(list, '⚔️');
  assert.deepEqual(list, ['⚔️']);
  list = toggleFavourite(list, '❤️');
  // Newest first: the one you just decided you liked is the first one you see
  // next time, rather than being buried behind everything older.
  assert.deepEqual(list, ['❤️', '⚔️']);
  assert.equal(isFavourite(list, '⚔️'), true);

  list = toggleFavourite(list, '⚔️');
  assert.deepEqual(list, ['❤️']);
  assert.equal(isFavourite(list, '⚔️'), false);
});

test('toggling never mutates the list it was given', () => {
  // The caller holds this in React state, where a mutated array does not
  // re-render — the favourites row would simply not update until something
  // else happened to repaint the picker.
  const original = ['❤️'];
  const added = toggleFavourite(original, '⚔️');
  const removed = toggleFavourite(original, '❤️');
  assert.deepEqual(original, ['❤️'], 'the input survived unchanged');
  assert.notEqual(added, original);
  assert.notEqual(removed, original);
});

test('the list is capped, and the oldest falls off the end', () => {
  let list = [];
  for (let i = 0; i < MAX_FAVOURITES + 5; i++) list = toggleFavourite(list, `e${i}`);
  assert.equal(list.length, MAX_FAVOURITES);
  // The five most recent are all still there; the first five are gone.
  assert.equal(list[0], `e${MAX_FAVOURITES + 4}`);
  assert.equal(list.includes('e0'), false);
});

test('an emoji that is not a non-empty string is refused', () => {
  const list = ['❤️'];
  for (const bad of ['', null, undefined, 7, {}, []]) {
    assert.deepEqual(toggleFavourite(list, bad), list, JSON.stringify(bad));
  }
});

test('favourites round-trip through storage', () => {
  const store = memoryStorage();
  withStorage(store, () => {
    assert.deepEqual(loadFavourites(), [], 'nothing stored yet');
    saveFavourites(['⚔️', '❤️']);
    assert.deepEqual(loadFavourites(), ['⚔️', '❤️']);
  });
});

test('a corrupted or hostile stored value never reaches a button', () => {
  // The stored string is editable in any devtools, and every entry is rendered
  // straight into a button's children — so it is filtered on the way OUT, not
  // only on the way in.
  const cases = [
    ['not json at all', []],
    ['{"nope":1}', []],
    ['null', []],
    ['[1, 2, {"x":1}, "⚔️", "", null]', ['⚔️']],
  ];
  for (const [raw, expected] of cases) {
    withStorage(memoryStorage({ 'vtt.emoji.favourites': raw }), () => {
      assert.deepEqual(loadFavourites(), expected, raw);
    });
  }
  // An over-long stored list is trimmed on read too, not just on write.
  const many = JSON.stringify(Array.from({ length: 50 }, (_, i) => `e${i}`));
  withStorage(memoryStorage({ 'vtt.emoji.favourites': many }), () => {
    assert.equal(loadFavourites().length, MAX_FAVOURITES);
  });
});

test('a private window throws on every access and the picker still works', () => {
  withStorage(throwingStorage(), () => {
    assert.deepEqual(loadFavourites(), [], 'reading falls back to empty');
    assert.doesNotThrow(() => saveFavourites(['⚔️']), 'writing swallows the error');
  });
});

test('saving trims to the cap even if handed a longer list', () => {
  const store = memoryStorage();
  withStorage(store, () => {
    saveFavourites(Array.from({ length: 40 }, (_, i) => `e${i}`));
    assert.equal(JSON.parse(store._map.get('vtt.emoji.favourites')).length, MAX_FAVOURITES);
  });
});
