// client/src/lib/boardViewport.js — the Relationships board's camera.
//
// Lives in server/test because that is where `npm test` looks; the module under
// test is pure ES with no DOM imports at the top level, so it imports cleanly
// here. What is pinned is the property that matters and that no amount of
// clicking around reliably reveals: **the two conversions are exact inverses**.
// A board where screen→world and world→screen disagree by a fraction still
// looks right at 100% and puts every dropped node in the wrong place at 40%.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
  DOT_MAX_PX,
  DOT_MIN_PX,
  boundsOf,
  anyNodeVisible,
  centerOn,
  fitTo,
  clampZoom,
  dotSpacing,
  panBy,
  toScreen,
  toWorld,
  zoomAt,
} from '../../client/src/lib/boardViewport.js';

const near = (a, b, epsilon = 1e-9) =>
  assert.ok(Math.abs(a - b) < epsilon, `${a} !== ${b} (within ${epsilon})`);

test('toWorld and toScreen are exact inverses, at every zoom', () => {
  for (const view of [
    DEFAULT_VIEW,
    { x: 0, y: 0, zoom: 0.25 },
    { x: -420, y: 137, zoom: 2.5 },
    { x: 13.5, y: -7.25, zoom: 0.83 },
  ]) {
    for (const [sx, sy] of [[0, 0], [640, 360], [-19, 1024]]) {
      const w = toWorld(view, sx, sy);
      const back = toScreen(view, w.x, w.y);
      near(back.x, sx);
      near(back.y, sy);
    }
  }
});

test('at rest, world and screen coordinates are the same thing', () => {
  assert.deepEqual(toWorld(DEFAULT_VIEW, 40, 90), { x: 40, y: 90 });
  assert.deepEqual(toScreen(DEFAULT_VIEW, 40, 90), { x: 40, y: 90 });
});

test('zoomAt holds the point under the cursor perfectly still', () => {
  // This is the entire feel of wheel-zoom: whatever is under the pointer must
  // still be under the pointer afterwards. Anything else reads as the board
  // sliding away from you.
  const view = { x: -300, y: 120, zoom: 0.9 };
  const [cx, cy] = [512, 288];
  const before = toWorld(view, cx, cy);
  for (const factor of [1.25, 1 / 1.25, 2, 0.5]) {
    const next = zoomAt(view, factor, cx, cy);
    const after = toWorld(next, cx, cy);
    near(after.x, before.x, 1e-9);
    near(after.y, before.y, 1e-9);
  }
});

test('zoomAt clamps, and answers the SAME object when it is already at a limit', () => {
  const zoomedOut = { x: 5, y: 5, zoom: MIN_ZOOM };
  // Identity, not a copy — the caller skips a state write on a no-op scroll,
  // and a fresh object would defeat that.
  assert.equal(zoomAt(zoomedOut, 0.5, 0, 0), zoomedOut);
  const zoomedIn = { x: 5, y: 5, zoom: MAX_ZOOM };
  assert.equal(zoomAt(zoomedIn, 2, 0, 0), zoomedIn);
  // Partway to the limit still moves, and lands exactly on it.
  assert.equal(zoomAt({ x: 0, y: 0, zoom: 0.3 }, 0.1, 0, 0).zoom, MIN_ZOOM);
  assert.equal(zoomAt({ x: 0, y: 0, zoom: 2 }, 10, 0, 0).zoom, MAX_ZOOM);
});

test('clampZoom holds the documented range', () => {
  assert.equal(clampZoom(0.0001), MIN_ZOOM);
  assert.equal(clampZoom(1000), MAX_ZOOM);
  assert.equal(clampZoom(1), 1);
});

test('panBy moves the camera in screen pixels and never touches zoom', () => {
  const view = { x: 10, y: -10, zoom: 1.75 };
  assert.deepEqual(panBy(view, 5, 5), { x: 15, y: -5, zoom: 1.75 });
  // Panning is a screen-space nudge: the same drag covers less world at high
  // zoom, which falls out of the maths rather than being special-cased.
  const world = toWorld(panBy(view, 175, 0), 0, 0).x - toWorld(view, 0, 0).x;
  near(world, -100);
});

test('centerOn puts a world point in the middle of the viewport', () => {
  const view = { x: 0, y: 0, zoom: 0.5 };
  const centred = centerOn(view, 200, 400, 800, 600);
  const screen = toScreen(centred, 200, 400);
  near(screen.x, 400);
  near(screen.y, 300);
  assert.equal(centred.zoom, 0.5);
});

// ---------------------------------------------------------------------------
// The void's dot field
// ---------------------------------------------------------------------------

test('dot spacing keeps a constant on-screen density at every zoom', () => {
  // The first version scaled a fixed tile with the camera, so zooming out
  // packed the dots tighter until the field was a grey mess. The grid steps to
  // a coarser or finer one instead, and the property that matters is that the
  // on-screen spacing never leaves its band however far you zoom.
  for (let zoom = 0.25; zoom <= 2.5; zoom += 0.01) {
    const spacing = dotSpacing(zoom);
    assert.ok(spacing >= DOT_MIN_PX && spacing <= DOT_MAX_PX, `zoom ${zoom.toFixed(2)} gave ${spacing}`);
  }
  // A garbage zoom must not loop forever or return something unusable.
  assert.ok(Number.isFinite(dotSpacing(0)));
  assert.ok(Number.isFinite(dotSpacing(NaN)));
});

// ---------------------------------------------------------------------------
// Framing the cast
// ---------------------------------------------------------------------------

test('boundsOf measures the whole cast, portraits included', () => {
  assert.equal(boundsOf([]), null);
  assert.equal(boundsOf(null), null);
  // A node's stored x/y is its top-left, so the box has to reach a portrait's
  // width and height past the last one or the right edge is clipped.
  assert.deepEqual(boundsOf([{ x: 0, y: 0 }], 112, 112), { minX: 0, minY: 0, maxX: 112, maxY: 112 });
  assert.deepEqual(boundsOf([{ x: -50, y: 20 }, { x: 300, y: -10 }], 112, 112), {
    minX: -50, minY: -10, maxX: 412, maxY: 132,
  });
  // A row with a broken coordinate is skipped rather than poisoning the box
  // with NaN and framing the camera on nothing.
  assert.deepEqual(boundsOf([{ x: 0, y: 0 }, { x: NaN, y: 5 }], 10, 10), {
    minX: 0, minY: 0, maxX: 10, maxY: 10,
  });
});

test('fitTo centres the cast and never zooms IN to fill the screen', () => {
  const bounds = { minX: 0, minY: 0, maxX: 400, maxY: 200 };
  const view = fitTo(bounds, 1000, 600, 80);
  // The middle of the box lands in the middle of the viewport.
  const centre = toScreen(view, 200, 100);
  near(centre.x, 500, 1e-9);
  near(centre.y, 300, 1e-9);
  // A board with one person on it must not open at 250%.
  assert.ok(view.zoom <= 1, String(view.zoom));

  // A very spread-out board frames as far out as the camera allows rather than
  // refusing.
  const huge = fitTo({ minX: 0, minY: 0, maxX: 100000, maxY: 100000 }, 800, 600);
  assert.equal(huge.zoom, MIN_ZOOM);
  // Nonsense in, default out — never NaN.
  assert.deepEqual(fitTo(null, 800, 600), DEFAULT_VIEW);
  assert.deepEqual(fitTo(bounds, 0, 0), DEFAULT_VIEW);
});

test('re-framing is decided per node, not by any sliver of the bounding box', () => {
  const nodes = [{ x: 0, y: 0 }];
  // A saved camera that already shows somebody is left alone.
  assert.equal(anyNodeVisible(DEFAULT_VIEW, nodes, 800, 600), true);

  // **The bug this pins.** The first version tested the bounding box for any
  // overlap with the viewport, so a nineteen-pixel sliver of one portrait's
  // edge counted as "the map is visible" — and a phone opened on an empty void
  // with the whole cast just off the right edge. A node's centre is at +56, so
  // a camera showing only its left 19px must answer false.
  assert.equal(anyNodeVisible({ x: -93, y: 0, zoom: 1 }, nodes, 374, 540), false);
  // Showing most of it answers true.
  assert.equal(anyNodeVisible({ x: -20, y: 0, zoom: 1 }, nodes, 374, 540), true);

  // Entirely off screen in each direction.
  assert.equal(anyNodeVisible({ x: -5000, y: 0, zoom: 1 }, nodes, 800, 600), false);
  assert.equal(anyNodeVisible({ x: 0, y: 5000, zoom: 1 }, nodes, 800, 600), false);
  // One visible node out of many is enough — the board is not empty.
  assert.equal(
    anyNodeVisible(DEFAULT_VIEW, [{ x: 9000, y: 9000 }, { x: 10, y: 10 }], 800, 600),
    true
  );
  // Nothing to frame never re-frames, and a broken coordinate is not "visible".
  assert.equal(anyNodeVisible(DEFAULT_VIEW, [], 800, 600), true);
  assert.equal(anyNodeVisible(DEFAULT_VIEW, [{ x: NaN, y: 0 }], 800, 600), false);
});
