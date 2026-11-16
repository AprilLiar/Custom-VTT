// Fight Setup's Complications and Battle Parameters: the stored shape and the
// pure rules (client/src/lib/battleParams.js), and Chained Down's leash on the
// movement planner (engine/board.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDisarmed, keepEmComing, leashOf, normalizeBattle, parseBattleColumn, partnerOf, tiltOn, toggleArena } from '../../client/src/lib/battleParams.js';
import { forcedMoves, freeMoveReach, isFull, makeBoard } from '../../client/src/lib/patd/engine/board.js';

test('normalize keeps only known keys, one Tilt per side, Last One Standing by default', () => {
  const b = normalizeBattle({ tilts: { allies: 'too_slow', enemies: 'bogus', renegades: 'cage_match' }, arena: ['icy_floor', 'too_slow', 'icy_floor'], victory: 'nope', cuffs: [[1, 2], [3, 3], ['x', 1]], chains: { 5: { col: 2, row: 3 }, 6: { col: 'a' } } });
  assert.deepEqual(b.tilts, { allies: 'too_slow', enemies: null, renegades: null });
  assert.deepEqual(b.arena, ['icy_floor']);
  assert.equal(b.victory, 'last_one_standing');
  assert.deepEqual(b.cuffs, [[1, 2]]);
  assert.deepEqual(b.chains, { 5: { col: 2, row: 3 } });
  assert.deepEqual(parseBattleColumn('not json').combat.tilts, { allies: null, enemies: null, renegades: null });
});

test('only one Arena Parameter that replaces the Outside at a time', () => {
  let a = toggleArena([], 'cage_match');
  a = toggleArena(a, 'icy_floor');
  a = toggleArena(a, 'trick_room');
  assert.deepEqual(a.sort(), ['icy_floor', 'trick_room']);
  assert.deepEqual(toggleArena(a, 'icy_floor'), ['trick_room']);
});

test('Disarmed: by Tilt on one side, or as an Arena Parameter on everyone', () => {
  const b = normalizeBattle({ tilts: { enemies: 'disarmed' } });
  assert.equal(isDisarmed(b, 'enemies'), true);
  assert.equal(isDisarmed(b, 'allies'), false);
  assert.equal(isDisarmed(normalizeBattle({ arena: ['disarmed_all'] }), 'allies'), true);
  assert.equal(tiltOn(b, 'enemies'), 'disarmed');
});

test("Keep 'Em Coming halves the current bar's HP and Burning/Fatigue/Weakness, rounding up", () => {
  const r = keepEmComing({ max: 20, current: 15, bars: 2, broken: 0 }, { burning: 3, fatigue: 1, weakness: 4, power: 2 });
  assert.equal(r.hp.current, 8);
  assert.deepEqual(r.tokens, { burning: 2, fatigue: 1, weakness: 2, power: 2 });
});

test('Handcuffs partner, both ways', () => {
  const b = normalizeBattle({ cuffs: [[4, 9]] });
  assert.equal(partnerOf(b, 4), 9);
  assert.equal(partnerOf(b, 9), 4);
  assert.equal(partnerOf(b, 5), null);
});

test('Chained Down: 3 from the Wall, 5 from its Rubble, free once it is gone', () => {
  const b = normalizeBattle({ chains: { 7: { col: 5, row: 5 } } });
  assert.deepEqual(leashOf(b, 7, () => ['wall']), { at: { col: 5, row: 5 }, max: 3 });
  assert.deepEqual(leashOf(b, 7, () => ['rubble']), { at: { col: 5, row: 5 }, max: 5 });
  assert.equal(leashOf(b, 7, () => []), null);
  assert.equal(leashOf(b, 8, () => ['wall']), null);
});

test('the leash on the board: Free Movement never ends past it, and no Outside', () => {
  const board = makeBoard({ bounds: { colMin: 0, colMax: 12, rowMin: 0, rowMax: 12 }, tiles: [{ col: 5, row: 5, kind: 'wall' }], units: [{ id: 1, square: { col: 6, row: 5 } }] });
  board.leash = { at: { col: 5, row: 5 }, max: 3 };
  board.exits = 'none';
  const reach = [...freeMoveReach(board, { col: 6, row: 5 }, 10, 1).values()].map((r) => r.square);
  assert.ok(reach.length > 0);
  assert.ok(reach.every((sq) => Math.abs(sq.col - 5) + Math.abs(sq.row - 5) <= 3), JSON.stringify(reach));
  assert.equal(isFull(board, { col: 9, row: 5 }), true);
  // A push away from the Wall stops at the leash.
  const pushes = forcedMoves(board, { col: 7, row: 5 }, { col: 4, row: 5 }, 5, { targetId: 1 });
  assert.ok(pushes.every((m) => m.square && Math.abs(m.square.col - 5) + Math.abs(m.square.row - 5) <= 3), JSON.stringify(pushes));
});
