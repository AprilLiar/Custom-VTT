// client/src/lib/sceneLayout.js — the stage's cramming/overlap layout.
//
// Lives in server/test because that is where `npm test` looks; the module
// under test is pure ES with no DOM imports at the top level, so it
// imports cleanly here — the same reason boardViewport.test.js does.
//
// What's pinned is the four properties the Scene tab plan calls out
// explicitly, because none of them are things a glance at the UI reliably
// catches: room-to-spare gives exact natural spacing; rank 0 on each side
// is always flush against its own edge, at any crowd size; consecutive
// ranks never collide, even fully crammed; and adding a member never
// reorders anyone already on stage, only shrinks everyone's shared factor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLOT_WIDTH, SLOT_GAP, MIN_STEP_FACTOR, layoutStage } from '../../client/src/lib/sceneLayout.js';

const entry = (id) => ({ id });

test('room to spare: factor is exactly 1, spacing is exactly natural', () => {
  const { left, right, factor } = layoutStage({
    left: [entry('a'), entry('b')],
    right: [entry('c')],
    stageWidth: 2000,
  });
  assert.equal(factor, 1);
  assert.equal(left[0].x, 0);
  assert.equal(left[1].x, SLOT_WIDTH + SLOT_GAP);
  // A distance from the RIGHT edge, not an absolute left-based coordinate
  // — see sceneLayout.js's own comment on why the caller applies this as
  // CSS `right`, not `left`.
  assert.equal(right[0].x, 0);
});

test('a single character on stage always gets factor 1, regardless of stage width', () => {
  const { left, factor } = layoutStage({ left: [entry('solo')], right: [], stageWidth: 50 });
  assert.equal(factor, 1);
  assert.equal(left[0].x, 0);
});

test('rank 0 on each side is always exactly at its own screen edge, at any crowd size', () => {
  const left = Array.from({ length: 12 }, (_, i) => entry(`l${i}`));
  const right = Array.from({ length: 9 }, (_, i) => entry(`r${i}`));
  const { left: placedLeft, right: placedRight } = layoutStage({ left, right, stageWidth: 900 });
  assert.equal(placedLeft[0].x, 0);
  assert.equal(placedRight[0].x, 0); // distance from ITS OWN (the right) edge
});

test('consecutive ranks on the same side never collide, even heavily crammed', () => {
  const left = Array.from({ length: 30 }, (_, i) => entry(`l${i}`));
  const { left: placed, factor } = layoutStage({ left, right: [], stageWidth: 800 });
  // The floor guarantees a strictly positive step, so a rank is always
  // further from the edge than the rank before it — nobody is placed on
  // top of, or before, an earlier rank.
  assert.ok(factor >= MIN_STEP_FACTOR - 1e-9);
  for (let i = 1; i < placed.length; i++) {
    assert.ok(placed[i].x > placed[i - 1].x, `rank ${i} (${placed[i].x}) did not advance past rank ${i - 1} (${placed[i - 1].x})`);
  }
});

test('adding a member never reorders anyone already on stage, only shrinks the shared factor', () => {
  const before = layoutStage({
    left: [entry('a'), entry('b'), entry('c')],
    right: [],
    stageWidth: 500,
  });
  const after = layoutStage({
    left: [entry('new'), entry('a'), entry('b'), entry('c')],
    right: [],
    stageWidth: 500,
  });
  // Same people, same relative order (by id), just possibly compressed —
  // 'new' takes rank 0, and everyone else keeps their own relative order.
  assert.deepEqual(
    after.left.slice(1).map((e) => e.id),
    before.left.map((e) => e.id)
  );
  assert.ok(after.factor <= before.factor);
});

test("'equally, amongst the whole roster': one shared factor covers both sides combined, not per-side", () => {
  const lopsided = layoutStage({
    left: Array.from({ length: 8 }, (_, i) => entry(`l${i}`)),
    right: [entry('r0')],
    stageWidth: 700,
  });
  const balanced = layoutStage({
    left: Array.from({ length: 4 }, (_, i) => entry(`l${i}`)),
    right: Array.from({ length: 5 }, (_, i) => entry(`r${i}`)),
    stageWidth: 700,
  });
  // Same total headcount (9) and same stageWidth -> the same factor,
  // whichever side most of the crowd happens to be standing on.
  assert.equal(lopsided.factor, balanced.factor);
});

test('the compression floor: factor never drops below MIN_STEP_FACTOR, however crowded', () => {
  const left = Array.from({ length: 200 }, (_, i) => entry(`l${i}`));
  const { factor } = layoutStage({ left, right: [], stageWidth: 400 });
  assert.equal(factor, MIN_STEP_FACTOR);
});

test('z-order ranks each side back-to-front, rank 0 (the newest, at the edge) on top', () => {
  const { left } = layoutStage({
    left: [entry('newest'), entry('middle'), entry('oldest')],
    right: [],
    stageWidth: 2000,
  });
  assert.equal(left[0].z, 3);
  assert.equal(left[1].z, 2);
  assert.equal(left[2].z, 1);
});

// Regression: the right side's `x` used to be an absolute left-based
// coordinate (`stageWidth - SLOT_WIDTH`), which only actually landed a
// figure flush against the screen's own right edge when it rendered at
// exactly SLOT_WIDTH wide — anything wider (StageRoster.jsx no longer
// clips to that width) spilled past the true right edge of the screen
// entirely, not just behind a drawer. `x` is now a distance from the
// entry's OWN edge for both sides — identical to the left side's own
// values — so the caller can apply it as CSS `right` and let the browser
// anchor flush regardless of a figure's actual rendered width.
test("a right-side entry's x is a distance from ITS OWN edge, not an absolute left-based coordinate", () => {
  const right = [entry('newest'), entry('older')];
  // Rank 0 is flush against its own edge — distance 0 — at any stage
  // width, unlike the old `stageWidth - SLOT_WIDTH` formula this replaced.
  assert.equal(layoutStage({ left: [], right, stageWidth: 400 }).right[0].x, 0);
  assert.equal(layoutStage({ left: [], right, stageWidth: 4000 }).right[0].x, 0);
  // And at a SHARED stage width, it matches the left side's own values
  // exactly, rank for rank — both sides are symmetric distances from
  // their own edge now, so the same compression factor produces the same
  // steps on both sides.
  const { left, right: mirroredRight } = layoutStage({
    left: [entry('a'), entry('b')],
    right: [entry('c'), entry('d')],
    stageWidth: 900,
  });
  assert.equal(mirroredRight[0].x, left[0].x);
  assert.equal(mirroredRight[1].x, left[1].x);
});
