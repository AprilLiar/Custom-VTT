// The Combat map grid (client/src/lib/combatGrid.js): cleaning stored values,
// the 10% padding cut, cells, fitting the image, and swapping on a move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID_DEFAULTS,
  cellAt,
  cellCenter,
  cellInside,
  cellRect,
  cellTaken,
  fitImage,
  gridLines,
  innerRect,
  moveToken,
  normalizeGrid,
} from '../../client/src/lib/combatGrid.js';

test('a stored grid is cleaned and clamped', () => {
  assert.deepEqual(normalizeGrid({}), GRID_DEFAULTS);
  assert.deepEqual(normalizeGrid({ size: 2, offsetX: 9999, offsetY: -9999, opacity: 4 }), {
    size: 8,
    offsetX: 400,
    offsetY: -400,
    opacity: 1,
  });
  assert.equal(normalizeGrid({ size: 70.6 }).size, 71);
  assert.equal(normalizeGrid({ size: 'junk' }).size, GRID_DEFAULTS.size);
});

test('the board is the whole picture plus 2 squares on every side', () => {
  assert.deepEqual(innerRect(1000, 500, { size: 100 }), { x0: -200, y0: -200, x1: 1200, y1: 700 });
  assert.deepEqual(innerRect(1000, 500), { x0: 0, y0: 0, x1: 1000, y1: 500 }, 'no grid: just the picture');
});

test('lines fall every square from the offset, framed by the board edges, past the picture', () => {
  const { xs, ys } = gridLines(1000, 500, { size: 100, offsetX: 0, offsetY: 0 });
  assert.deepEqual(xs, [-200, -100, 0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
  assert.deepEqual(ys, [-200, -100, 0, 100, 200, 300, 400, 500, 600, 700]);
  const shifted = gridLines(1000, 500, { size: 100, offsetX: 30, offsetY: 0 });
  assert.deepEqual(shifted.xs, [-200, -170, -70, 30, 130, 230, 330, 430, 530, 630, 730, 830, 930, 1030, 1130, 1200]);
});

test('cells and their centres', () => {
  const grid = { size: 50, offsetX: 10, offsetY: -5 };
  assert.deepEqual(cellAt(grid, 10, -5), { col: 0, row: 0 });
  assert.deepEqual(cellAt(grid, 59.9, 44.9), { col: 0, row: 0 });
  assert.deepEqual(cellAt(grid, 60, 45), { col: 1, row: 1 });
  assert.deepEqual(cellCenter(grid, 2, 3), { x: 135, y: 170 });
});

test('a cell holds a token when its centre is on the board — the picture and 2 squares round it', () => {
  const grid = { size: 100, offsetX: 0, offsetY: 0 };
  assert.equal(cellInside(1000, 1000, grid, 0, 0), true, 'the picture\'s corner square');
  assert.equal(cellInside(1000, 1000, grid, -2, -2), true, '2 squares past the picture');
  assert.equal(cellInside(1000, 1000, grid, 11, 11), true);
  assert.equal(cellInside(1000, 1000, grid, -3, 0), false, 'beyond the board');
  assert.equal(cellInside(1000, 1000, grid, 12, 1), false);
  assert.equal(cellInside(1000, 1000, grid, 1.5, 1), false);
});

test('a cut square is clipped to the board for the highlight', () => {
  const grid = { size: 100, offsetX: 50, offsetY: 0 };
  assert.deepEqual(cellRect(1000, 1000, grid, -3, 1), { x: -200, y: 100, width: 50, height: 100 });
});

test('the map fits whole and centred between the drawers', () => {
  const fit = fitImage(1000, 600, 2000, 1000, { left: 100, right: 100 });
  assert.equal(fit.scale, 0.4);
  assert.equal(fit.left, 100);
  assert.equal(fit.top, 100);
  const tall = fitImage(1000, 600, 600, 1200);
  assert.equal(tall.scale, 0.5);
  assert.equal(tall.left, 350);
});

test('moving onto a free cell moves; onto a token swaps the two', () => {
  const tokens = [
    { id: 1, col: 1, row: 1 },
    { id: 2, col: 3, row: 1 },
  ];
  assert.deepEqual(moveToken(tokens, 1, 2, 2), [{ id: 1, col: 2, row: 2 }]);
  assert.deepEqual(moveToken(tokens, 1, 3, 1), [
    { id: 1, col: 3, row: 1 },
    { id: 2, col: 1, row: 1 },
  ]);
  assert.deepEqual(moveToken(tokens, 1, 1, 1), []);
  assert.equal(moveToken(tokens, 9, 0, 0), null);
  assert.equal(cellTaken(tokens, 3, 1), true);
  assert.equal(cellTaken(tokens, 0, 0), false);
});
