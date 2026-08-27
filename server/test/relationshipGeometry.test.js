// client/src/lib/relationshipGeometry.js — where a relationship line starts,
// ends, and bends.
//
// The property worth pinning here is the one that is invisible with one line
// and obvious with three: **two lines between the same pair must not overlap.**
// A screenshot of a single relationship proves nothing about it, and by the
// time a real board has three lines between two people, a regression here reads
// as "the app lost one of my relationships".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEND_SPACING,
  NODE_H,
  NODE_W,
  SIDES,
  anchorPoint,
  assignBends,
  bendOffsets,
  edgeEnds,
  edgePath,
  DROP_PAD,
  dropTarget,
  hitNode,
  hitNodeArea,
  nearestSide,
  nodeCenter,
  pairKey,
} from '../../client/src/lib/relationshipGeometry.js';

const node = (id, x, y) => ({ id, x, y });

test('the four dots sit on the midpoints of the portrait edges', () => {
  const n = node(1, 100, 200);
  const c = nodeCenter(n);
  assert.deepEqual(c, { x: 100 + NODE_W / 2, y: 200 + NODE_H / 2 });

  // Each dot is centred on its side and pushed just outside the edge.
  assert.equal(anchorPoint(n, 'top').x, c.x);
  assert.ok(anchorPoint(n, 'top').y < n.y);
  assert.equal(anchorPoint(n, 'bottom').x, c.x);
  assert.ok(anchorPoint(n, 'bottom').y > n.y + NODE_H);
  assert.equal(anchorPoint(n, 'left').y, c.y);
  assert.ok(anchorPoint(n, 'left').x < n.x);
  assert.equal(anchorPoint(n, 'right').y, c.y);
  assert.ok(anchorPoint(n, 'right').x > n.x + NODE_W);
});

test('an unknown side falls back to right rather than throwing', () => {
  // Side comes out of the database as text. A row with a value nobody expected
  // must still draw somewhere rather than taking the whole board down.
  const n = node(1, 0, 0);
  assert.deepEqual(anchorPoint(n, 'sideways'), anchorPoint(n, 'right'));
});

test('hitNode covers the portrait and nothing beyond it', () => {
  const n = node(1, 0, 0);
  assert.equal(hitNode(n, { x: 1, y: 1 }), true);
  assert.equal(hitNode(n, { x: NODE_W / 2, y: NODE_H / 2 }), true);
  assert.equal(hitNode(n, { x: NODE_W, y: NODE_H }), true);
  assert.equal(hitNode(n, { x: -1, y: 5 }), false);
  assert.equal(hitNode(n, { x: NODE_W + 1, y: 5 }), false);
  assert.equal(hitNode(n, { x: 5, y: NODE_H + 1 }), false);
});

test('nearestSide splits the node into four quadrants with no dead zone', () => {
  const n = node(1, 0, 0);
  assert.equal(nearestSide(n, { x: NODE_W / 2, y: 4 }), 'top');
  assert.equal(nearestSide(n, { x: NODE_W / 2, y: NODE_H - 4 }), 'bottom');
  assert.equal(nearestSide(n, { x: 4, y: NODE_H / 2 }), 'left');
  assert.equal(nearestSide(n, { x: NODE_W - 4, y: NODE_H / 2 }), 'right');
  // Every corner and the exact centre answer *something* — the caller always
  // gets a side it can store.
  for (const p of [
    { x: 0, y: 0 },
    { x: NODE_W, y: 0 },
    { x: 0, y: NODE_H },
    { x: NODE_W, y: NODE_H },
    { x: NODE_W / 2, y: NODE_H / 2 },
  ]) {
    assert.ok(SIDES.includes(nearestSide(n, p)), JSON.stringify(p));
  }
});

test('one line is straight; two bow apart symmetrically', () => {
  assert.deepEqual(bendOffsets(1), [0]);
  assert.deepEqual(bendOffsets(2), [-BEND_SPACING / 2, BEND_SPACING / 2]);
  assert.deepEqual(bendOffsets(3), [-BEND_SPACING, 0, BEND_SPACING]);
  assert.deepEqual(bendOffsets(0), []);
  // Always centred on zero, however many there are — the fan stays balanced
  // around the straight line rather than drifting to one side as it grows.
  for (const n of [1, 2, 3, 4, 7, 10]) {
    const sum = bendOffsets(n).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum) < 1e-9, `${n} offsets summed to ${sum}`);
  }
});

test('a bent line really does leave the straight one', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 200, y: 0 };
  const straight = edgePath(from, to, 0);
  const bent = edgePath(from, to, BEND_SPACING);
  // The label point is the curve's own midpoint, so it moves with the bend.
  assert.deepEqual(straight.mid, { x: 100, y: 0 });
  assert.notDeepEqual(bent.mid, straight.mid);
  assert.equal(bent.mid.x, 100);
  assert.ok(Math.abs(bent.mid.y) > 1, JSON.stringify(bent.mid));
  // And the two directions separate rather than landing on each other.
  const other = edgePath(from, to, -BEND_SPACING);
  assert.ok(bent.mid.y * other.mid.y < 0, 'opposite offsets must bow opposite ways');
});

test('a curve between identical points does not divide by zero', () => {
  // Reachable: two nodes dropped exactly on top of each other, or a loose end
  // released on its own anchor.
  const p = { x: 40, y: 40 };
  const path = edgePath(p, p, BEND_SPACING);
  assert.ok(!path.d.includes('NaN'), path.d);
  assert.ok(Number.isFinite(path.mid.x) && Number.isFinite(path.mid.y));
});

test('a pair is unordered — drawn either way round, it is the same fan', () => {
  assert.equal(pairKey({ from_node_id: 3, to_node_id: 9 }), pairKey({ from_node_id: 9, to_node_id: 3 }));
  // A loose end belongs to no fan: it is pinned to a point in space, so there
  // is nothing for it to systematically collide with.
  assert.equal(pairKey({ from_node_id: 3, to_node_id: null }), null);
  assert.equal(pairKey({ from_node_id: null, to_node_id: null }), null);
});

test('assignBends fans a pair and leaves a lone line straight', () => {
  const edges = [
    { id: 1, from_node_id: 1, to_node_id: 2 },
    { id: 2, from_node_id: 2, to_node_id: 1 }, // same pair, drawn the other way
    { id: 3, from_node_id: 1, to_node_id: 3 }, // a different pair
    { id: 4, from_node_id: 1, to_node_id: null }, // loose
  ];
  const bends = assignBends(edges);
  assert.equal(bends.get(3), 0, 'the only line between 1 and 3 stays straight');
  assert.equal(bends.get(4), undefined, 'a loose end gets no fan');
  assert.notEqual(bends.get(1), bends.get(2));
  assert.ok(Math.abs(bends.get(1) + bends.get(2)) < 1e-9, 'the pair bows symmetrically');
});

test('bends are stable in id order, so adding a line does not reshuffle the rest', () => {
  const two = assignBends([
    { id: 5, from_node_id: 1, to_node_id: 2 },
    { id: 9, from_node_id: 1, to_node_id: 2 },
  ]);
  // Same edges handed over in the other order must produce the same answer —
  // otherwise a re-fetch that changes row order visibly rearranges the board.
  const twoReversed = assignBends([
    { id: 9, from_node_id: 1, to_node_id: 2 },
    { id: 5, from_node_id: 1, to_node_id: 2 },
  ]);
  assert.equal(two.get(5), twoReversed.get(5));
  assert.equal(two.get(9), twoReversed.get(9));
  assert.ok(two.get(5) < two.get(9), 'the lower id takes the lower offset');
});

test('edgeEnds resolves node anchors and loose points alike', () => {
  const nodes = new Map([
    [1, node(1, 0, 0)],
    [2, node(2, 400, 0)],
  ]);
  const attached = edgeEnds(
    { from_node_id: 1, from_side: 'right', to_node_id: 2, to_side: 'left' },
    nodes
  );
  assert.deepEqual(attached.from, anchorPoint(nodes.get(1), 'right'));
  assert.deepEqual(attached.to, anchorPoint(nodes.get(2), 'left'));

  const half = edgeEnds(
    { from_node_id: 1, from_side: 'right', to_node_id: null, to_x: 250, to_y: 90 },
    nodes
  );
  assert.deepEqual(half.to, { x: 250, y: 90 });
});

test('an edge pointing at a node that is gone is not drawable', () => {
  // The board drops it rather than drawing a line to the origin, which is what
  // a missing anchor would otherwise look like.
  assert.equal(edgeEnds({ from_node_id: 99, from_side: 'right', to_node_id: null }, new Map()), null);
  assert.equal(
    edgeEnds({ from_node_id: null, from_x: null, from_y: null, to_node_id: null }, new Map()),
    null
  );
});

test('the server\'s node-centre constant matches this module', () => {
  // server/index.js writes a loose end at (node.x + 56, node.y + 56) when a node
  // is deleted with its relationships kept. It cannot import this module — the
  // server has no business importing client code — so the literal is pinned
  // here instead. If the portrait size ever changes, this is what fails.
  assert.equal(NODE_W / 2, 56);
  assert.equal(NODE_H / 2, 56);
});

test('a connector released ON a dot attaches, not just one released on the picture', () => {
  // The bug this pins: the four dots protrude beyond the portrait, so aiming at
  // one — the natural thing to do — landed outside the strict rect and
  // connected to nothing.
  const n = node(1, 0, 0);
  for (const side of SIDES) {
    const dot = anchorPoint(n, side);
    assert.equal(hitNode(n, dot), false, `${side} dot is outside the picture, as drawn`);
    assert.equal(hitNodeArea(n, dot), true, `${side} dot must still accept a drop`);
    // And the side it snaps to is the one you aimed at.
    assert.equal(nearestSide(n, dot), side);
  }
});

test('the padded region has a limit, and the nearest centre wins inside it', () => {
  const a = node(1, 0, 0);
  const far = { x: NODE_W + DROP_PAD + 5, y: NODE_H / 2 };
  assert.equal(hitNodeArea(a, far), false, 'the pad is generous, not unbounded');

  // Two nodes close enough that one point sits in both pads: the one you are
  // actually nearer to takes the connection.
  const b = node(2, NODE_W + 10, 0);
  const between = { x: NODE_W + 4, y: NODE_H / 2 };
  assert.equal(dropTarget([a, b], between)?.id, a.id);
  const nearerB = { x: NODE_W + 8, y: NODE_H / 2 };
  assert.equal(dropTarget([a, b], nearerB)?.id, b.id);

  // The node a new line is being drawn FROM never accepts its own drop.
  assert.equal(dropTarget([a], { x: 10, y: 10 }, { exceptId: 1 }), null);
  assert.equal(dropTarget([a, b], { x: -500, y: -500 }), null);
});
