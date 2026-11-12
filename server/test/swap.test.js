// Swap Spaces (play feedback 7): the board never shows anyone parked off it
// mid-swap — the steps are quiet and only the last one updates the stage —
// and a Copy is never the one parked (a Copy sent off the board is destroyed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoves } from '../engine/moves.js';

const moves = createMoves({ ask: () => async () => null, emitEvent: async () => null, postCard: async () => null });
const sq = (col, row) => ({ col, row });

function mover() {
  const calls = [];
  const recorded = [];
  return {
    calls,
    recorded,
    m: {
      mode: 'combat',
      setSquare: async (f, s, how, opts = {}) => {
        calls.push({ id: f.id, to: s, quiet: Boolean(opts.quiet) });
        f.square = s;
      },
      recordMove: (f, from, to, how) => recorded.push({ id: f.id, how }),
    },
  };
}

test('a swap: quiet steps, one stage update at the end, one "swap" beat each', async () => {
  const { m, calls, recorded } = mover();
  const a = { id: 1, name: 'A', square: sq(1, 1) };
  const b = { id: 2, name: 'B', square: sq(2, 1) };
  assert.equal(await moves.swap({}, m, a, b), true);
  assert.deepEqual(a.square, sq(2, 1));
  assert.deepEqual(b.square, sq(1, 1));
  assert.deepEqual(calls.map((c) => c.quiet), [true, true, false]);
  assert.deepEqual(recorded, [
    { id: 1, how: 'swap' },
    { id: 2, how: 'swap' },
  ]);
});

test('a swap with a Copy parks the fighter, never the Copy', async () => {
  const { m, calls } = mover();
  const copy = { id: 'c1', isCopy: true, name: 'Copy', square: sq(1, 1) };
  const b = { id: 2, name: 'B', square: sq(2, 1) };
  await moves.swap({}, m, copy, b);
  assert.ok(!calls.some((c) => c.id === 'c1' && c.to == null), JSON.stringify(calls));
  assert.deepEqual(copy.square, sq(2, 1));
  assert.deepEqual(b.square, sq(1, 1));
});
