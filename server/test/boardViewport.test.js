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
  centerOn,
  clampZoom,
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
