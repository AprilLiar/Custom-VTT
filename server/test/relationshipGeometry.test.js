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
  BEND_LIMIT,
  BEND_SNAP,
  BEND_SPACING,
  BEND_U_LIMIT,
  NODE_H,
  NODE_W,
  SIDES,
  STRAIGHT,
  anchorPoint,
  assignBends,
  bendFields,
  bendFromControl,
  bendFromDrag,
  bendOf,
  bendOffsets,
  bendWeight,
  chordParam,
  clampBend,
  controlPoint,
  edgeEnds,
  edgePath,
  DROP_PAD,
  dropTarget,
  hitNode,
  hitNodeArea,
  nearestSide,
  nodeCenter,
  pairKey,
  snapBend,
} from '../../client/src/lib/relationshipGeometry.js';

const node = (id, x, y) => ({ id, x, y });

const near = (a, b, epsilon = 1e-9) =>
  assert.ok(Math.abs(a - b) < epsilon, `${a} !== ${b} (within ${epsilon})`);

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
  const straight = edgePath(from, to, STRAIGHT);
  const bent = edgePath(from, to, { u: 0.5, v: BEND_SPACING });
  // The label point is the curve's own midpoint, so it moves with the bend.
  assert.deepEqual(straight.mid, { x: 100, y: 0 });
  assert.notDeepEqual(bent.mid, straight.mid);
  assert.equal(bent.mid.x, 100);
  assert.ok(Math.abs(bent.mid.y) > 1, JSON.stringify(bent.mid));
  // And the two directions separate rather than landing on each other.
  const other = edgePath(from, to, { u: 0.5, v: -BEND_SPACING });
  assert.ok(bent.mid.y * other.mid.y < 0, 'opposite offsets must bow opposite ways');
  // No bend at all is the straight line, and so is an unusable one.
  assert.equal(edgePath(from, to).d, straight.d);
  assert.equal(edgePath(from, to, { u: NaN, v: NaN }).d, straight.d);
});

test('u slides the arc along the line, which is what "not at the centre" means', () => {
  // The whole of item 3. With `u` pinned at 0.5 — all the first version had —
  // every arc peaked in the middle however near an end it was pulled.
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 };
  const near = edgePath(from, to, { u: 0.15, v: 60 });
  const far = edgePath(from, to, { u: 0.85, v: 60 });
  assert.ok(near.c.x < 100, `control point should sit early: ${near.c.x}`);
  assert.ok(far.c.x > 300, `control point should sit late: ${far.c.x}`);
  // Both still bow the same way; only where they bulge differs.
  assert.ok(near.mid.y > 0 && far.mid.y > 0);
  assert.notEqual(near.d, far.d);
});

test('the control point round-trips through the chord frame', () => {
  // The pair IS the control point, expressed against the line's own two ends —
  // which is what lets an arc survive both portraits being moved.
  for (const [from, to] of [
    [{ x: 0, y: 0 }, { x: 300, y: 0 }],
    [{ x: 120, y: 40 }, { x: -60, y: 260 }],
  ]) {
    for (const bend of [STRAIGHT, { u: 0.2, v: -75 }, { u: 1.4, v: 12.5 }]) {
      const back = bendFromControl(from, to, controlPoint(from, to, bend));
      near(back.u, bend.u, 1e-9);
      near(back.v, bend.v, 1e-9);
    }
  }
});

test('a curve between identical points does not divide by zero', () => {
  // Reachable: two nodes dropped exactly on top of each other, or a loose end
  // released on its own anchor.
  const p = { x: 40, y: 40 };
  const path = edgePath(p, p, { u: 0.5, v: BEND_SPACING });
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
  assert.deepEqual(bends.get(3), STRAIGHT, 'the only line between 1 and 3 stays straight');
  assert.equal(bends.get(4), undefined, 'a loose end gets no fan');
  // The fan only ever moves a line ACROSS its chord, so every automatic bend
  // sits at the middle. `u` is the hand-drag's alone.
  for (const id of [1, 2, 3]) assert.equal(bends.get(id).u, 0.5);
});

// **The bug the old version of this file could not see.**
//
// It asserted that a reversed pair's two offsets were unequal and summed to
// zero. Both were true, of two curves that lay exactly on top of each other —
// because `edgePath` takes its perpendicular from the edge's OWN direction, so
// a B→A edge has its direction negated as well as its offset, and the two
// negations cancel. Connect A to B and then B to A and you saw one line.
//
// So the assertion is on the DRAWN CURVES, not on the numbers behind them. That
// is the property anybody actually cares about, and it is the one that failed.
test('A→B and B→A draw two different curves, not one on top of the other', () => {
  const a = node(1, 0, 0);
  const b = node(2, 400, 0);
  const nodes = new Map([[1, a], [2, b]]);
  const forward = { id: 1, from_node_id: 1, from_side: 'right', to_node_id: 2, to_side: 'left' };
  const backward = { id: 2, from_node_id: 2, from_side: 'left', to_node_id: 1, to_side: 'right' };
  const bends = assignBends([forward, backward]);

  // How far the drawn curve bows off the straight line between the same two
  // dots, signed. Measured rather than assumed, because the anchors sit at the
  // portraits' vertical centre and not at y = 0.
  const bow = (edge, table = bends) => {
    const ends = edgeEnds(edge, nodes);
    const curve = edgePath(ends.from, ends.to, table.get(edge.id));
    const straight = edgePath(ends.from, ends.to, 0);
    return curve.mid.y - straight.mid.y;
  };
  const one = bow(forward);
  const two = bow(backward);

  // The two lines run between the same two dots and bow to OPPOSITE sides of
  // the straight one. That is the whole test.
  assert.ok(one * two < 0, `both curves bowed the same way: ${one} and ${two}`);
  assert.ok(Math.abs(one - two) > BEND_SPACING / 4, 'and by a visible amount');

  // And a third line between the same pair, whichever way round it is drawn,
  // finds a lane of its own rather than landing on one of the first two.
  const third = { id: 3, from_node_id: 2, from_side: 'left', to_node_id: 1, to_side: 'right' };
  const three = assignBends([forward, backward, third]);
  const bows = [forward, backward, third].map((e) => bow(e, three).toFixed(6));
  assert.equal(new Set(bows).size, 3, `three distinct curves, got ${bows}`);
});

test('a hand-drawn arc overrides the fan without disturbing its neighbours', () => {
  const pair = [
    { id: 1, from_node_id: 1, to_node_id: 2 },
    { id: 2, from_node_id: 1, to_node_id: 2 },
    { id: 3, from_node_id: 1, to_node_id: 2 },
  ];
  const before = assignBends(pair);
  const after = assignBends([{ ...pair[0], bend: 137, bend_u: 0.3 }, pair[1], pair[2]]);

  assert.deepEqual(after.get(1), { u: 0.3, v: 137 }, 'the bent line keeps exactly what it was given');
  // The other two must not slide sideways because a third line was bent. A
  // hand-bent edge still occupies its slot in the fan; it just does not sit in
  // it. Re-fanning the remainder would move lines nobody touched.
  assert.deepEqual(after.get(2), before.get(2));
  assert.deepEqual(after.get(3), before.get(3));

  // A hand bend of zero is a real value — "I straightened this myself" — and
  // must not be mistaken for the absence of one.
  assert.deepEqual(assignBends([{ id: 1, from_node_id: 1, to_node_id: 2, bend: 0 }]).get(1), STRAIGHT);
  // **A row stored before `bend_u` existed reads as the middle**, which is
  // exactly what the single-number version always drew — so every arc already
  // on a board survives the upgrade unchanged.
  assert.deepEqual(bendOf({ bend: 40 }), { u: 0.5, v: 40 });
  assert.deepEqual(bendOf({ bend: 40, bend_u: null }), { u: 0.5, v: 40 });
  assert.deepEqual(bendOf({ bend: 40, bend_u: 0.2 }), { u: 0.2, v: 40 });
  // Null, undefined and garbage all mean "no hand bend": fall back to the fan.
  for (const bend of [null, undefined, NaN, 'wobbly']) {
    assert.equal(bendOf({ bend }), null, `bend ${String(bend)} is not a hand bend`);
    const fanned = assignBends([
      { id: 1, from_node_id: 1, to_node_id: 2, bend },
      { id: 2, from_node_id: 1, to_node_id: 2, bend },
    ]);
    assert.deepEqual(fanned.get(1), { u: 0.5, v: -BEND_SPACING / 2 }, `bend ${String(bend)} should fall back to the fan`);
  }
});

// ---------------------------------------------------------------------------
// Bending a line by hand
// ---------------------------------------------------------------------------

test('the point you grabbed follows the pointer exactly, in BOTH directions', () => {
  // The whole of "omni-directional". The first version projected the drag onto
  // the chord's normal and threw the along-chord half away, so dragging a line
  // sideways did nothing at all.
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 };
  const at = (bend, t) => {
    const c = controlPoint(from, to, bend);
    return {
      x: (1 - t) ** 2 * from.x + 2 * t * (1 - t) * c.x + t ** 2 * to.x,
      y: (1 - t) ** 2 * from.y + 2 * t * (1 - t) * c.y + t ** 2 * to.y,
    };
  };
  for (const t of [0.3, 0.5, 0.7]) {
    const before = at(STRAIGHT, t);
    for (const [dx, dy] of [[0, 60], [0, -60], [70, 0], [-45, 25]]) {
      const bend = bendFromDrag(from, to, STRAIGHT, t, dx, dy);
      const after = at(bend, t);
      near(after.x - before.x, dx, 1e-9);
      near(after.y - before.y, dy, 1e-9);
    }
  }
});

test('a drag starting from an existing arc adds to it rather than replacing it', () => {
  // The delta rule. Grabbing a bent line and not moving must leave it exactly
  // where it was — otherwise the first frame of every re-bend is a jump.
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 };
  const base = { u: 0.25, v: -90 };
  for (const t of [0.1, 0.5, 0.9]) {
    const still = bendFromDrag(from, to, base, t, 0, 0);
    near(still.u, base.u, 1e-9);
    near(still.v, base.v, 1e-9);
  }
});

test('grabbing right at an anchor does not throw the line off the board', () => {
  // The ends of a quadratic do not move however hard its control point is
  // pulled, so the honest divisor there is zero. `bendWeight`'s floor is what
  // stops that from being a division by nearly zero and a line several thousand
  // units long on the first frame.
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 0 };
  assert.equal(bendWeight(0.5), 0.5);
  assert.equal(bendWeight(0), 0.25);
  assert.equal(bendWeight(1), 0.25);
  for (const t of [0, 0.001, 0.999, 1]) {
    const bend = bendFromDrag(from, to, STRAIGHT, t, 40, 40);
    assert.ok(Number.isFinite(bend.u) && Number.isFinite(bend.v), `t=${t} gave ${JSON.stringify(bend)}`);
    assert.ok(Math.abs(bend.v) <= 200, `t=${t} gave a wild ${bend.v}`);
  }
  // A zero-length line — two portraits dropped on top of each other — must not
  // divide by zero either.
  const degenerate = bendFromDrag(from, from, STRAIGHT, 0.5, 3, 3);
  assert.ok(Number.isFinite(degenerate.u) && Number.isFinite(degenerate.v));
});

test('the bend is measured in the line\'s own frame, so it survives a move', () => {
  // The reason a bend is a pair of fractions and not a control point. Bend a
  // line, then move both of its ends somewhere else entirely: the arc comes.
  const bend = { u: 0.5, v: 80 };
  const near1 = edgePath({ x: 0, y: 0 }, { x: 200, y: 0 }, bend);
  const far = edgePath({ x: 1000, y: 500 }, { x: 1200, y: 500 }, bend);
  // Same span, same bend, same shape — just translated.
  near(near1.mid.y - 0, far.mid.y - 500, 1e-9);
  // Rotating the span rotates the arc with it rather than flattening it.
  const turned = edgePath({ x: 0, y: 0 }, { x: 0, y: 200 }, bend);
  const bow = Math.hypot(turned.mid.x - 0, turned.mid.y - 100);
  near(bow, Math.abs(near1.mid.y), 1e-9);
  // And so does an off-centre one: `u` is a fraction of the chord, not a length.
  const off = { u: 0.2, v: 80 };
  const short = edgePath({ x: 0, y: 0 }, { x: 100, y: 0 }, off);
  const long = edgePath({ x: 0, y: 0 }, { x: 800, y: 0 }, off);
  near(short.c.x / 100, long.c.x / 800, 1e-9);
});

test('chordParam reads 0 at one end and 1 at the other, and never leaves that range', () => {
  const from = { x: 100, y: 100 };
  const to = { x: 300, y: 100 };
  assert.equal(chordParam(from, to, from), 0);
  assert.equal(chordParam(from, to, to), 1);
  assert.equal(chordParam(from, to, { x: 200, y: 100 }), 0.5);
  // Off the ends and off to the side — a grab is still somewhere on the line.
  assert.equal(chordParam(from, to, { x: -900, y: 4000 }), 0);
  assert.equal(chordParam(from, to, { x: 9000, y: -4000 }), 1);
  assert.equal(chordParam(from, from, { x: 5, y: 5 }), 0.5, 'a zero-length chord answers its middle');
});

test('a bend dragged back to nearly straight snaps to straight, and is bounded', () => {
  // Only `v` is snapped. `u` is where along the line the arc sits, and on a
  // straight line that makes no difference at all — so a snap resets it to the
  // middle rather than leaving a meaningless number behind.
  assert.deepEqual(snapBend({ u: 0.2, v: 0 }), STRAIGHT);
  assert.deepEqual(snapBend({ u: 0.2, v: BEND_SNAP - 0.01 }), STRAIGHT);
  assert.deepEqual(snapBend({ u: 0.2, v: -BEND_SNAP + 0.01 }), STRAIGHT);
  assert.deepEqual(snapBend({ u: 0.2, v: BEND_SNAP + 1 }), { u: 0.2, v: BEND_SNAP + 1 });
  assert.deepEqual(snapBend({ u: 0.9, v: -40 }), { u: 0.9, v: -40 });

  assert.deepEqual(clampBend({ u: 0.5, v: 1e9 }), { u: 0.5, v: BEND_LIMIT });
  assert.deepEqual(clampBend({ u: 0.5, v: -1e9 }), { u: 0.5, v: -BEND_LIMIT });
  // `u` is bounded far more tightly: a control point a chord-length past either
  // end is already a hairpin, and past that the curve stops being a line
  // between two people at all.
  assert.deepEqual(clampBend({ u: 50, v: 0 }), { u: BEND_U_LIMIT, v: 0 });
  assert.deepEqual(clampBend({ u: -50, v: 0 }), { u: -BEND_U_LIMIT, v: 0 });
  assert.deepEqual(clampBend({ u: 0.7, v: 12.5 }), { u: 0.7, v: 12.5 });
  // Garbage draws a straight line rather than no line at all.
  for (const bad of [{ u: NaN, v: NaN }, {}, null, undefined, { u: 'a', v: 'b' }]) {
    assert.deepEqual(clampBend(bad), STRAIGHT, JSON.stringify(bad));
  }
});

test('bendFields sends both halves, or two nulls to clear the whole arc', () => {
  // The two have to travel together: clearing `bend` without `bend_u` would
  // leave a later re-bend inheriting a stale position from an arc nobody can
  // see any more.
  assert.deepEqual(bendFields(null), { bend: null, bendU: null });
  assert.deepEqual(bendFields({ u: 1 / 3, v: 40.5 }), { bend: 40.5, bendU: 0.333333 });
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
  assert.deepEqual(two.get(5), twoReversed.get(5));
  assert.deepEqual(two.get(9), twoReversed.get(9));
  assert.ok(two.get(5).v < two.get(9).v, 'the lower id takes the lower offset');
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
