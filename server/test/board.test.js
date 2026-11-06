// The board and movement (client/src/lib/patd/engine/board.js, phase D) and
// the map's bounds from its image (server/imageSize.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionMoveDestinations,
  forcedMoves,
  freeMoveReach,
  isEmpty,
  key,
  landingsOf,
  makeBoard,
  pathCost,
  saveYourselfCost,
  saveYourselfSquares,
  teleportDestinations,
} from '../../client/src/lib/patd/engine/board.js';
import { cellBounds, imageSize } from '../imageSize.js';

const sq = (col, row) => ({ col, row });
const keys = (list) => list.map((x) => key(x.square ?? x)).sort();
const bounds = { colMin: 0, colMax: 9, rowMin: 0, rowMax: 9 };

test('empty and full spaces: Walls and units are full; Rubble, Pits, Traps, Fog are not; Outside is not a space', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 1, row: 0, kind: 'wall' }, { col: 2, row: 0, kind: 'pit_trap' }, { col: 3, row: 0, kind: 'rubble' }], units: [{ id: 7, square: sq(4, 0) }] });
  assert.equal(isEmpty(b, sq(1, 0)), false);
  assert.equal(isEmpty(b, sq(2, 0)), true);
  assert.equal(isEmpty(b, sq(3, 0)), true);
  assert.equal(isEmpty(b, sq(4, 0)), false);
  assert.equal(isEmpty(b, sq(4, 0), [7]), true, 'the mover itself');
  assert.equal(isEmpty(b, sq(-1, 0)), false);
});

test('Free Movement: 1 orthogonal, 2 diagonal, +1 out of a Pit; never through full spaces', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 5, row: 5, kind: 'pit' }, { col: 6, row: 4, kind: 'wall' }, { col: 6, row: 5, kind: 'wall' }, { col: 6, row: 6, kind: 'wall' }] });
  const r = freeMoveReach(b, sq(5, 5), 3);
  assert.equal(r.get('5,4').cost, 2, 'out of the Pit: 1 + 1');
  assert.equal(r.get('4,4').cost, 3, 'diagonal out of the Pit: 2 + 1');
  assert.equal(r.has('7,5'), false, 'Walls block');
  assert.equal(r.has('3,3'), false, 'too far');
  const open = freeMoveReach(makeBoard({ bounds }), sq(0, 0), 2);
  assert.equal(open.get('1,1').cost, 2);
  assert.equal(open.get('2,0').cost, 2);
  assert.equal(open.has('-1,0'), false, 'never Outside');
  assert.equal(pathCost(b, sq(5, 5), [sq(4, 5), sq(3, 4)]), 2 + 2);
});

test('Action Movement: exactly X, no repeats, stops on Rubble or a Pit; "up to" may stop early', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 1, row: 0, kind: 'rubble' }] });
  const exact = actionMoveDestinations(b, sq(0, 0), 2);
  assert.ok(exact.some((d) => key(d.square) === '1,0' && d.path.length === 1), 'Rubble ends the move at once');
  assert.ok(exact.some((d) => key(d.square) === '2,2'));
  assert.ok(exact.some((d) => key(d.square) === '0,1' && d.path.length === 2), 'two spaces can wiggle back next to the start');
  assert.ok(!exact.some((d) => key(d.square) === '0,0'), 'never back onto the start (no repeats)');
  const up = actionMoveDestinations(b, sq(0, 0), 2, true);
  assert.ok(up.some((d) => key(d.square) === '0,1'));
  // Boxed in: only as far as possible.
  const box = makeBoard({ bounds: { colMin: 0, colMax: 1, rowMin: 0, rowMax: 0 } });
  assert.deepEqual(keys(actionMoveDestinations(box, sq(0, 0), 3)), ['1,0']);
});

test('Teleport X: any empty space within Range 1-X, through anything', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 1, row: 0, kind: 'wall' }], units: [{ id: 2, square: sq(2, 0) }] });
  const t = keys(teleportDestinations(b, sq(0, 0), 2));
  assert.ok(t.includes('2,1') && t.includes('0,2'));
  assert.ok(!t.includes('1,0') && !t.includes('2,0') && !t.includes('0,0'));
});

test('Push: each space farther; Rubble and Pits stop it; Traps on the way trigger', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 4, row: 5, kind: 'trap' }, { col: 5, row: 5, kind: 'pit' }] });
  const m = forcedMoves(b, sq(3, 5), sq(2, 5), 3);
  const intoPit = m.find((x) => key(x.square) === '5,5');
  assert.equal(intoPit.ends, 'pit');
  assert.deepEqual(intoPit.traps.map(key), ['4,5']);
  assert.ok(m.every((x) => x.path.every((s, i, p) => Math.max(Math.abs(s.col - 2), Math.abs(s.row - 5)) === i + 2 || x.ends !== 'full' || p)), 'monotonic');
  assert.ok(m.some((x) => x.ends === 'full' && x.path.length === 3));
});

test('World of Cardboard: a push into a Wall smashes it into Rubble and ends there', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 4, row: 5, kind: 'wall' }, { col: 4, row: 4, kind: 'wall' }, { col: 4, row: 6, kind: 'wall' }] });
  const m = forcedMoves(b, sq(3, 5), sq(2, 5), 3);
  assert.ok(m.length && m.every((x) => x.ends === 'wall' && x.path.length === 1), JSON.stringify(m));
  assert.deepEqual(keys(m.map((x) => x.smashed)), ['4,4', '4,5', '4,6']);
});

test('the Outside: off the edge only from where they started; otherwise they stop at the edge', () => {
  const b = makeBoard({ bounds });
  const off = forcedMoves(b, sq(9, 5), sq(8, 5), 2);
  assert.ok(off.some((x) => x.ends === 'outside' && key(x.from) === '9,5'));
  const stop = forcedMoves(makeBoard({ bounds: { colMin: 0, colMax: 4, rowMin: 0, rowMax: 9 } }), sq(3, 5), sq(2, 5), 3);
  assert.ok(stop.length && stop.every((x) => x.square && x.square.col === 4 && x.ends === 'blocked'), JSON.stringify(stop));
});

test('lanes: only the ends lead Outside, never the front or back of a lane', () => {
  const lanes = makeBoard({ bounds: { colMin: 0, colMax: 9, rowMin: 0, rowMax: 1 }, exits: 'cols' });
  // Straight off the front of the lane: no legal space, so they stay put.
  const side = forcedMoves(lanes, sq(4, 0), sq(4, 1), 1);
  assert.ok(!side.some((x) => x.ends === 'outside'), JSON.stringify(side));
  const onMap = forcedMoves(makeBoard({ bounds: { colMin: 0, colMax: 9, rowMin: 0, rowMax: 1 } }), sq(4, 0), sq(4, 1), 1);
  assert.ok(onMap.some((x) => x.ends === 'outside'), 'on the map that edge is the Outside');
  const end = forcedMoves(lanes, sq(9, 0), sq(8, 0), 1);
  assert.ok(end.some((x) => x.ends === 'outside'));
});

test('Pull: each space closer; an adjacent target spins around the puller; units block', () => {
  const b = makeBoard({ bounds, units: [{ id: 1, square: sq(5, 5) }] });
  const m = forcedMoves(b, sq(8, 5), sq(5, 5), 2, { pull: true });
  assert.ok(m.some((x) => key(x.square) === '6,5'));
  const spin = forcedMoves(b, sq(6, 5), sq(5, 5), 1, { pull: true });
  assert.deepEqual(keys(spin), ['5,4', '5,6', '6,4', '6,6'], 'a space adjacent to both');
  const around = forcedMoves(b, sq(6, 5), sq(5, 5), 4, { pull: true });
  assert.ok(around.some((x) => key(x.square) === '4,5'), 'spun all the way round');
  assert.ok(landingsOf(m).every((l) => l.routes.length >= 1));
});

test('Save Yourself: 1 Speed (2 out of a Pit) for one space; from the Outside next to the edge left', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 5, row: 5, kind: 'pit' }] });
  assert.equal(saveYourselfCost(b, sq(5, 5)), 2);
  assert.equal(saveYourselfSquares(b, sq(5, 5)).length, 8);
  const fromOut = saveYourselfSquares(b, null, { from: sq(9, 5) });
  assert.ok(fromOut.some((s) => key(s) === '9,5') && fromOut.some((s) => key(s) === '8,5'));
});

test('map bounds from the image: cells whose centre is inside the 10% padding', () => {
  assert.deepEqual(cellBounds(1000, 700, { size: 100, offsetX: 0, offsetY: 0 }), { colMin: 1, colMax: 8, rowMin: 1, rowMax: 5 });
  assert.equal(cellBounds(0, 0, { size: 70 }), null);
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47], 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 640, height: 480 });
});
