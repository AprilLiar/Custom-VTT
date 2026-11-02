// The turn-order algorithm (client/src/lib/initiative.js), shared by client and
// server. These pin the GM's own rules: one turn per HP bar, the opener, 1:1
// alternation while both sides have turns, the uneven tail, no back-to-back
// turns where avoidable, and the opposite-side opener for the next round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRound, nextFirstSide, otherSide } from '../../client/src/lib/initiative.js';

// A seeded generator so a failure reproduces.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const ids = (order) => order.map((t) => t.id);
const sides = (order) => order.map((t) => t.side[0]).join('');
const countOf = (order, id) => order.filter((t) => t.id === id).length;
const adjacentRepeats = (order) => order.filter((t, i) => i > 0 && order[i - 1].id === t.id).length;

test('every HP bar is exactly one turn', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const order = buildRound({
      allies: [{ id: 'a', turns: 1 }, { id: 'b', turns: 2 }],
      enemies: [{ id: 'x', turns: 3 }, { id: 'y', turns: 1 }],
      firstSide: 'allies',
      rng: seeded(seed),
    });
    assert.equal(order.length, 7);
    assert.deepEqual([countOf(order, 'a'), countOf(order, 'b'), countOf(order, 'x'), countOf(order, 'y')], [1, 2, 3, 1]);
  }
});

test("the GM's opener takes the first turn, on the chosen side", () => {
  const order = buildRound({
    allies: [{ id: 'a', turns: 1 }, { id: 'b', turns: 1 }],
    enemies: [{ id: 'x', turns: 1 }, { id: 'y', turns: 1 }],
    firstSide: 'enemies',
    openerId: 'y',
    rng: seeded(3),
  });
  assert.deepEqual(order[0], { side: 'enemies', id: 'y' });
});

test('an opener that is not on the first side is ignored, not trusted', () => {
  const order = buildRound({
    allies: [{ id: 'a', turns: 1 }],
    enemies: [{ id: 'x', turns: 1 }],
    firstSide: 'allies',
    openerId: 'x',
    rng: seeded(1),
  });
  assert.deepEqual(order[0], { side: 'allies', id: 'a' });
});

test('even sides alternate one for one all the way down', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const order = buildRound({
      allies: [{ id: 'a', turns: 1 }, { id: 'b', turns: 1 }, { id: 'c', turns: 1 }],
      enemies: [{ id: 'x', turns: 1 }, { id: 'y', turns: 1 }, { id: 'z', turns: 1 }],
      firstSide: 'allies',
      rng: seeded(seed),
    });
    assert.equal(sides(order), 'aeaeae');
  }
});

test('uneven sides alternate while they can, then the leftovers follow', () => {
  const order = buildRound({
    allies: [{ id: 'a', turns: 1 }, { id: 'b', turns: 1 }],
    enemies: [{ id: 'x', turns: 1 }, { id: 'y', turns: 1 }, { id: 'z', turns: 1 }, { id: 'w', turns: 1 }],
    firstSide: 'enemies',
    rng: seeded(9),
  });
  assert.equal(sides(order), 'eaeaee');
});

test('the bigger side opening still alternates first', () => {
  const order = buildRound({
    allies: [{ id: 'a', turns: 1 }],
    enemies: [{ id: 'x', turns: 1 }, { id: 'y', turns: 1 }, { id: 'z', turns: 1 }],
    firstSide: 'allies',
    rng: seeded(2),
  });
  assert.equal(sides(order), 'aeee');
});

test('nobody takes two turns in a row when the order can avoid it', () => {
  for (let seed = 1; seed <= 200; seed++) {
    // A 3-bar boss and two minions against three heroes: the tail is all
    // enemies, and the boss must not go twice back to back.
    const order = buildRound({
      allies: [{ id: 'a', turns: 1 }],
      enemies: [{ id: 'boss', turns: 3 }, { id: 'm1', turns: 1 }, { id: 'm2', turns: 1 }],
      firstSide: 'allies',
      rng: seeded(seed),
    });
    assert.equal(adjacentRepeats(order), 0, `seed ${seed}: ${ids(order).join(' ')}`);
  }
});

test('when repeats are unavoidable they still happen — every turn is kept', () => {
  const order = buildRound({
    allies: [{ id: 'a', turns: 1 }],
    enemies: [{ id: 'boss', turns: 4 }],
    firstSide: 'enemies',
    rng: seeded(1),
  });
  assert.deepEqual(ids(order), ['boss', 'a', 'boss', 'boss', 'boss']);
});

test("a side's turns are spread across its fighters", () => {
  // Two 2-bar heroes against four 1-bar enemies: the ally slots should not be
  // one hero twice and then the other twice.
  for (let seed = 1; seed <= 50; seed++) {
    const order = buildRound({
      allies: [{ id: 'a', turns: 2 }, { id: 'b', turns: 2 }],
      enemies: [{ id: 'w', turns: 1 }, { id: 'x', turns: 1 }, { id: 'y', turns: 1 }, { id: 'z', turns: 1 }],
      firstSide: 'allies',
      rng: seeded(seed),
    });
    const allyTurns = order.filter((t) => t.side === 'allies').map((t) => t.id);
    for (let i = 1; i < allyTurns.length; i++) assert.notEqual(allyTurns[i], allyTurns[i - 1], `seed ${seed}`);
  }
});

test('different seeds give different orders (it is actually random)', () => {
  const orders = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    orders.add(
      ids(
        buildRound({
          allies: [{ id: 'a', turns: 1 }, { id: 'b', turns: 1 }, { id: 'c', turns: 1 }],
          enemies: [{ id: 'x', turns: 1 }, { id: 'y', turns: 1 }, { id: 'z', turns: 1 }],
          firstSide: 'allies',
          rng: seeded(seed),
        })
      ).join(' ')
    );
  }
  assert.ok(orders.size > 5, `only ${orders.size} distinct orders`);
});

test('the next round opens with the side opposite the last turn', () => {
  assert.equal(nextFirstSide([{ side: 'allies', id: 'a' }, { side: 'enemies', id: 'x' }]), 'allies');
  assert.equal(nextFirstSide([{ side: 'enemies', id: 'x' }, { side: 'enemies', id: 'y' }]), 'allies');
  assert.equal(nextFirstSide([{ side: 'enemies', id: 'x' }, { side: 'allies', id: 'a' }]), 'enemies');
  assert.equal(nextFirstSide([], 'enemies'), 'enemies');
  assert.equal(otherSide('allies'), 'enemies');
});

test('a side with no turns cannot open; an empty fight is an empty round', () => {
  const order = buildRound({ allies: [], enemies: [{ id: 'x', turns: 2 }], firstSide: 'allies', rng: seeded(1) });
  assert.deepEqual(ids(order), ['x', 'x']);
  assert.deepEqual(buildRound({ allies: [], enemies: [], firstSide: 'allies' }), []);
  assert.deepEqual(
    buildRound({ allies: [{ id: 'a', turns: 0 }], enemies: [{ id: 'x', turns: -2 }], firstSide: 'allies' }),
    []
  );
});
