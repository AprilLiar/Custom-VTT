// Map borders (client/src/lib/patd/engine/borders.js): red and purple lines on
// square edges — walking, teleports, swaps, pushes and range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgeBetween, edgeMap, rangeBlocked, stepWalled, teleportSteps } from '../../client/src/lib/patd/engine/borders.js';
import {
  actionMoveDestinations,
  forcedMoves,
  freeMoveReach,
  key,
  makeBoard,
  saveYourselfSquares,
  swapAllowed,
  teleportDestinations,
} from '../../client/src/lib/patd/engine/board.js';
import { targetable } from '../../client/src/lib/patd/interpreter.js';

const sq = (col, row) => ({ col, row });
const bounds = { colMin: 0, colMax: 9, rowMin: 0, rowMax: 9 };
// A whole vertical line of borders on x = 5 (between columns 4 and 5).
const fence = (color, blocksRange = true) => Array.from({ length: 10 }, (_, row) => ({ side: 'v', col: 5, row, color, blocksRange }));

test('edges are named by the square they start: left (v) and top (h)', () => {
  assert.equal(edgeBetween(sq(4, 2), sq(5, 2)), 'v:5,2');
  assert.equal(edgeBetween(sq(5, 2), sq(4, 2)), 'v:5,2');
  assert.equal(edgeBetween(sq(3, 3), sq(3, 4)), 'h:3,4');
  assert.equal(edgeBetween(sq(3, 4), sq(3, 3)), 'h:3,4');
  assert.equal(edgeBetween(sq(0, 0), sq(1, 1)), null);
});

test('a red or purple border stops every walking step across it; a diagonal only when both ways round are shut', () => {
  const red = edgeMap([{ side: 'v', col: 5, row: 2, color: 'red' }]);
  assert.ok(stepWalled(red, sq(4, 2), sq(5, 2)));
  assert.ok(!stepWalled(red, sq(4, 3), sq(5, 3)));
  assert.ok(!stepWalled(red, sq(4, 2), sq(5, 3)), 'round the bottom is open');
  const corner = edgeMap([{ side: 'v', col: 5, row: 2, color: 'red' }, { side: 'h', col: 4, row: 3, color: 'red' }]);
  assert.ok(stepWalled(corner, sq(4, 2), sq(5, 3)), 'both routes shut');
  assert.ok(!stepWalled(red, sq(4, 2), sq(5, 2), { teleport: true }), 'a red border lets a teleport by');
});

test('Free Movement and Action Movement go round a border, never through', () => {
  const b = makeBoard({ bounds, borders: [{ side: 'v', col: 5, row: 5, color: 'red' }] });
  const reach = freeMoveReach(b, sq(4, 5), 3);
  assert.equal(reach.get('5,5').cost, 3, 'round the border: 3 Speed, not 1');
  const walls = makeBoard({ bounds, borders: fence('red') });
  assert.ok(![...freeMoveReach(walls, sq(4, 5), 9).keys()].some((k) => Number(k.split(',')[0]) >= 5), 'a full fence: nothing beyond');
  assert.ok(!actionMoveDestinations(walls, sq(4, 5), 2, true).some((d) => d.square.col >= 5));
});

test('Teleport: through red, never through purple (no route within X, no teleport)', () => {
  const red = makeBoard({ bounds, borders: fence('red') });
  assert.ok(teleportDestinations(red, sq(4, 5), 2).some((d) => key(d.square) === '5,5'), 'red: teleports pass');
  const purple = makeBoard({ bounds, borders: fence('purple') });
  assert.ok(!teleportDestinations(purple, sq(4, 5), 3).some((d) => d.square.col >= 5), 'a full purple fence: nothing beyond');
  // A short purple stretch: around it within X is fine, beyond X is not.
  const stub = makeBoard({ bounds, borders: [{ side: 'v', col: 5, row: 5, color: 'purple' }] });
  const t2 = teleportDestinations(stub, sq(4, 5), 2).map((d) => key(d.square));
  assert.ok(!t2.includes('5,5'), 'the route round is 3 steps, more than 2');
  assert.ok(teleportDestinations(stub, sq(4, 5), 3).some((d) => key(d.square) === '5,5'));
  assert.equal(teleportSteps(edgeMap([{ side: 'v', col: 5, row: 5, color: 'purple' }]), sq(4, 5), sq(5, 5), 1), null);
});

test('Swap: two teleports — purple between them forbids it, red does not', () => {
  assert.ok(swapAllowed(makeBoard({ bounds, borders: fence('red') }), sq(4, 5), sq(5, 5)));
  assert.ok(!swapAllowed(makeBoard({ bounds, borders: fence('purple') }), sq(4, 5), sq(5, 5)));
  assert.ok(swapAllowed(makeBoard({ bounds }), sq(4, 5), sq(5, 5)));
});

test('Push, pull and Save Yourself stop at a border; it also keeps them from the Outside', () => {
  const b = makeBoard({ bounds, borders: fence('red') });
  const m = forcedMoves(b, sq(3, 5), sq(2, 5), 3);
  assert.ok(m.every((x) => x.square && x.square.col <= 4), JSON.stringify(m));
  assert.ok(!saveYourselfSquares(b, sq(4, 5)).some((s) => s.col === 5));
  const edge = makeBoard({ bounds, borders: Array.from({ length: 10 }, (_, row) => ({ side: 'v', col: 10, row, color: 'red' })) });
  assert.ok(!forcedMoves(edge, sq(9, 5), sq(8, 5), 2).some((x) => x.ends === 'outside'), 'a border on the map edge holds');
});

test('range: a blocking border stops a straight line across it, a dashed one does not', () => {
  const blocks = edgeMap(fence('red', true));
  assert.ok(rangeBlocked(blocks, sq(4, 5), sq(6, 5)));
  assert.ok(rangeBlocked(blocks, sq(3, 2), sq(6, 7)), 'any line across the fence');
  assert.ok(!rangeBlocked(blocks, sq(1, 5), sq(4, 1)), 'lines on one side are free');
  assert.ok(!rangeBlocked(edgeMap(fence('purple', false)), sq(4, 5), sq(6, 5)), 'dashed: range passes');
  // A corner: a lone border touching it lets the diagonal through; two closing it do not.
  const one = edgeMap([{ side: 'v', col: 5, row: 4, color: 'red' }]);
  assert.ok(!rangeBlocked(one, sq(4, 4), sq(5, 5)), 'only touches the corner');
  const closed = edgeMap([{ side: 'v', col: 5, row: 4, color: 'red' }, { side: 'h', col: 4, row: 5, color: 'red' }]);
  assert.ok(rangeBlocked(closed, sq(4, 4), sq(5, 5)), 'the two edges hugging the start close it');
  const across = edgeMap([{ side: 'v', col: 5, row: 4, color: 'red' }, { side: 'v', col: 5, row: 5, color: 'red' }]);
  assert.ok(rangeBlocked(across, sq(4, 4), sq(5, 5)), 'a straight line of border through the corner');
});

test('targetable: a blocking border stops allies and enemies alike, never the whole-map modes', () => {
  const edges = edgeMap(fence('purple'));
  const base = { from: sq(4, 5), to: sq(5, 5), stanceRange: { minimum: 1, maximum: 3 }, walls: new Set(), fogged: () => false, edges };
  assert.equal(targetable({ ...base, enemy: true }), false);
  assert.equal(targetable({ ...base, enemy: false }), false);
  assert.equal(targetable({ ...base, range: { mode: 'map' }, enemy: true }), true);
  assert.equal(targetable({ ...base, edges: edgeMap(fence('purple', false)), enemy: true }), true);
});
