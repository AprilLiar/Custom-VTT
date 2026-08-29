// server/counterGates.js — a marker on one pip of a Counter.
//
// Two properties carry this file, and neither is visible on screen:
//
//   1. **A secret Gate's words never leave the server** for a viewer who may
//      not read them. Not hidden, not nulled — absent, so there is nothing in
//      the network tab to read.
//   2. **A Gate announces once, on the way up.** Ticking a Counter back down
//      past a Gate is a correction, not an event; ticking up through it again
//      is a second reminder and should say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gateChatLine,
  gatePip,
  gatesCrossed,
  isValidPip,
  visibleGate,
  visibleGates,
} from '../counterGates.js';

const gate = (pip, over = {}) => ({
  id: pip,
  counter_id: 1,
  pip_index: pip,
  name: `Gate ${pip}`,
  description: `Something happens at ${pip}.`,
  secret: 0,
  ...over,
});

const GM = { role: 'gm' };
const PLAYER = { role: 'player', characterId: 7 };

test('a change reaches every Gate it passes, in order, and only going up', () => {
  const gates = [gate(2), gate(4), gate(5)];
  assert.deepEqual(gatesCrossed(gates, 0, 1).map(gatePip), []);
  assert.deepEqual(gatesCrossed(gates, 1, 2).map(gatePip), [2], 'landing ON a Gate reaches it');
  assert.deepEqual(gatesCrossed(gates, 2, 3).map(gatePip), [], 'starting on one does not re-reach it');
  // A single +3 can pass more than one, and they announce in the order passed
  // rather than in whatever order the rows came back.
  assert.deepEqual(gatesCrossed([gate(5), gate(2), gate(4)], 1, 5).map(gatePip), [2, 4, 5]);
});

test('going back down reaches nothing, and coming back up reaches it again', () => {
  const gates = [gate(3)];
  assert.deepEqual(gatesCrossed(gates, 5, 0), [], 'a correction is not an event');
  assert.deepEqual(gatesCrossed(gates, 3, 2), []);
  assert.deepEqual(gatesCrossed(gates, 4, 4), [], 'standing still reaches nothing');
  // The second time through is a second time the table needs reminding.
  assert.deepEqual(gatesCrossed(gates, 0, 3).map(gatePip), [3]);
  assert.deepEqual(gatesCrossed(gates, 2, 3).map(gatePip), [3]);
});

test('a broken row is skipped rather than poisoning the crossing', () => {
  const gates = [gate(2), { ...gate(3), pip_index: null }, { ...gate(4), pip_index: 'x' }];
  assert.deepEqual(gatesCrossed(gates, 0, 9).map(gatePip), [2]);
  assert.deepEqual(gatesCrossed(null, 0, 5), []);
  assert.deepEqual(gatesCrossed([gate(1)], undefined, undefined), []);
});

test('a secret Gate is sent to a Player WITHOUT its words, not with them hidden', () => {
  const secret = gate(4, { secret: 1 });
  const forPlayer = visibleGate(secret, PLAYER);
  // The whole point: there is nothing to read in the payload.
  assert.equal('name' in forPlayer, false, JSON.stringify(forPlayer));
  assert.equal('description' in forPlayer, false, JSON.stringify(forPlayer));
  // But that a Gate is THERE is not secret — the pip is drawn twice the size
  // for everybody, and `secret` rides along so the client draws "???" rather
  // than an empty card.
  assert.equal(forPlayer.pip_index, 4);
  assert.equal(forPlayer.secret, 1);

  // The GM reads it in full.
  assert.equal(visibleGate(secret, GM).name, 'Gate 4');
  assert.equal(visibleGate(secret, GM).description, 'Something happens at 4.');

  // An open Gate is readable by everyone, including a viewer with no identity
  // at all — it is not a secret, so there is nothing to gate on.
  for (const viewer of [PLAYER, GM, null, undefined]) {
    assert.equal(visibleGate(gate(2), viewer).name, 'Gate 2', JSON.stringify(viewer));
  }
  // And a secret one is closed to a viewer with no identity, not opened by the
  // absence of one.
  assert.equal('name' in visibleGate(secret, null), false);
});

test('visibleGate normalises what it does send', () => {
  // The pip comes back from SQLite and goes into an array index and a CSS size;
  // a string would sort wrong and render wrong.
  const g = visibleGate({ id: 1, counter_id: 2, pip_index: '3', name: null, description: null, secret: 0 }, GM);
  assert.equal(g.pip_index, 3);
  assert.equal(g.name, '', 'never null — the client renders it directly');
  assert.equal(g.description, '');
  assert.equal(g.secret, 0, 'a 0/1 integer, not whatever the column held');
  assert.equal(visibleGate({ ...gate(1), secret: true }, GM).secret, 1);
  assert.equal(visibleGates([gate(1), gate(2, { secret: 1 })], PLAYER).length, 2);
  assert.deepEqual(visibleGates(null, GM), []);
});

test('the chat line never carries a secret Gate\'s name', () => {
  // Chat is broadcast to the whole table, so this is the one place a secret
  // could escape by accident.
  assert.match(gateChatLine('Aaron - Rage', gate(4), 4, 6), /Gate 4/);
  assert.match(gateChatLine('Aaron - Rage', gate(4), 4, 6), /4\/6/);
  const hidden = gateChatLine('Aaron - Rage', gate(4, { secret: 1 }), 4, 6);
  assert.equal(hidden.includes('Gate 4'), false, hidden);
  assert.match(hidden, /reached a Gate/);
  assert.match(hidden, /4\/6/);
  // A Gate the GM never named reads the same way as a secret one rather than
  // announcing an empty pair of quotes.
  assert.match(gateChatLine('X', gate(2, { name: '   ' }), 2, 5), /reached a Gate/);
});

test('a pip has to be a real pip on this Counter', () => {
  assert.equal(isValidPip(1, 6), true);
  assert.equal(isValidPip(6, 6), true, 'the last pip can carry one');
  assert.equal(isValidPip(0, 6), false, 'pips are 1-based — a gate at 0 is before the start');
  assert.equal(isValidPip(7, 6), false);
  assert.equal(isValidPip(2.5, 6), false);
  assert.equal(isValidPip('2', 6), false, 'the caller normalises before asking');
  assert.equal(isValidPip(NaN, 6), false);
  assert.equal(isValidPip(1, 0), false);
});
