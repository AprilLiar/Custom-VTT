// HP bar stacks (client/src/lib/hpBars.js): the GM's design on the book's
// rules (p.62) — no carry-over, break + Dizzy, Taken Out on the last bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HP_MAX, addBar, applyHpDelta, barsLeft, isTakenOut, normalizeHp, removeBar, setHp } from '../../client/src/lib/hpBars.js';

test('a fresh fighter has one bar and no Max yet; ± does nothing until Max is set', () => {
  const s = normalizeHp({});
  assert.deepEqual(s, { max: null, current: 0, bars: 1, broken: 0, dizzy: false });
  assert.deepEqual(applyHpDelta(s, -1).state, s);
});

test('setting Max the first time fills the bar; later it keeps current, clamped', () => {
  let { state } = setHp({}, { max: 12 });
  assert.equal(state.current, 12);
  state = applyHpDelta(state, -5).state;
  assert.equal(setHp(state, { max: 20 }).state.current, 7);
  assert.equal(setHp(state, { max: 4 }).state.current, 4);
  assert.equal(setHp(state, { max: 500 }).state.max, HP_MAX);
});

test('healing never goes above Max', () => {
  const { state } = setHp({}, { max: 5 });
  assert.equal(applyHpDelta(state, 3).state.current, 5);
});

test('a bar reaching 0 with another behind it breaks: next bar up, full, Dizzy', () => {
  let state = addBar(setHp({}, { max: 2 }).state);
  state = applyHpDelta(state, -1).state;
  const r = applyHpDelta(state, -1);
  assert.equal(r.broke, true);
  assert.deepEqual(r.state, { max: 2, current: 2, bars: 2, broken: 1, dizzy: true });
  assert.equal(barsLeft(r.state), 1);
});

test('damage does not carry into the next bar', () => {
  const state = addBar(setHp({}, { max: 10 }).state);
  const r = applyHpDelta({ ...state, current: 4 }, -10);
  assert.equal(r.broke, true);
  assert.equal(r.state.current, 10, 'the next bar is untouched');
});

test('on the last bar HP stops at 0 — Taken Out — and any healing revives', () => {
  let state = setHp({}, { max: 3 }).state;
  state = applyHpDelta(state, -9).state;
  assert.equal(state.current, 0);
  assert.equal(isTakenOut(state), true);
  state = applyHpDelta(state, 1).state;
  assert.equal(isTakenOut(state), false);
});

test('healing never repairs a broken bar', () => {
  let state = addBar(setHp({}, { max: 1 }).state);
  state = applyHpDelta(state, -1).state;
  state = applyHpDelta(state, 5).state;
  assert.equal(state.broken, 1);
});

test('setting current to 0 directly breaks the bar the same way', () => {
  const state = addBar(setHp({}, { max: 6 }).state);
  assert.equal(setHp(state, { current: 0 }).broke, true);
});

test('the golden + adds a full bar; removing only ever takes a back bar', () => {
  let state = setHp({}, { max: 8 }).state;
  state = addBar(addBar(state));
  assert.equal(barsLeft(state), 3);
  state = removeBar(state);
  assert.equal(barsLeft(state), 2);
  state = removeBar(removeBar(state));
  assert.equal(barsLeft(state), 1, 'the current bar is never removed');
});

test('stored junk is cleaned', () => {
  assert.deepEqual(normalizeHp({ max: 0, current: -4, bars: 0, broken: 9 }), { max: 1, current: 0, bars: 1, broken: 0, dizzy: false });
});
