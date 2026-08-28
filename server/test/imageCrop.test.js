// client/src/lib/imageCrop.js — which part of an uploaded picture shows.
//
// Lives in server/test because that is where `npm test` looks; the module is
// pure ES with no DOM imports.
//
// Two properties carry this file, and neither is visible in a screenshot of one
// cropped thumbnail:
//
//   1. **view <-> crop is an exact round trip.** Re-opening the editor on a
//      cropped picture and pressing Save unchanged must store the identical
//      rectangle. A conversion that drifts nudges every crop a little further
//      each time somebody edits it.
//   2. **The cropped region is square in image pixels.** The renderer scales
//      width and height by different factors on purpose, and the only reason
//      that comes out with the original aspect ratio is that the region it is
//      given is square. Get this wrong and every cropped face is subtly
//      stretched — which reads as a bad photo, not as a bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCALE_FACTOR,
  clampView,
  cropFields,
  cropFromView,
  cropOf,
  cropStyle,
  initialView,
  isValidCrop,
  minScale,
  viewFromCrop,
  zoomViewAt,
} from '../../client/src/lib/imageCrop.js';

const near = (a, b, epsilon = 1e-9) =>
  assert.ok(Math.abs(a - b) < epsilon, `${a} !== ${b} (within ${epsilon})`);

const FRAME = 320;
const LANDSCAPE = { width: 1600, height: 900 };
const PORTRAIT = { width: 720, height: 1280 };
const SQUARE = { width: 800, height: 800 };

test('the default view is exactly what object-fit: cover already shows', () => {
  // The whole reason opening the editor is not a surprise: before you touch
  // anything, the frame holds the largest centred square — the same pixels the
  // app shows today for a picture with no crop at all.
  for (const natural of [LANDSCAPE, PORTRAIT, SQUARE]) {
    const view = initialView(natural, FRAME);
    const crop = cropFromView(view, natural, FRAME);
    const shorter = Math.min(natural.width, natural.height);
    near(crop.w * natural.width, shorter);
    near(crop.h * natural.height, shorter);
    // Centred: equal margin on both sides of whichever axis is longer.
    near(crop.x + crop.w / 2, 0.5);
    near(crop.y + crop.h / 2, 0.5);
  }
});

test('the region a view selects is square in IMAGE pixels, at every zoom', () => {
  for (const natural of [LANDSCAPE, PORTRAIT, SQUARE]) {
    let view = initialView(natural, FRAME);
    for (const factor of [1, 1.7, 2.5, 0.5, 3]) {
      view = zoomViewAt(view, factor, FRAME / 2, FRAME / 2, natural, FRAME);
      const crop = cropFromView(view, natural, FRAME);
      near(crop.w * natural.width, crop.h * natural.height, 1e-6);
    }
  }
});

test('view and crop convert back and forth without drifting', () => {
  for (const natural of [LANDSCAPE, PORTRAIT, SQUARE]) {
    for (const [factor, px, py] of [
      [1, 160, 160],
      [2, 40, 300],
      [3.5, 300, 20],
      [1.4, 0, 0],
    ]) {
      const view = zoomViewAt(initialView(natural, FRAME), factor, px, py, natural, FRAME);
      const crop = cropFromView(view, natural, FRAME);
      const back = viewFromCrop(crop, natural, FRAME);
      near(back.scale, view.scale, 1e-9);
      near(back.x, view.x, 1e-6);
      near(back.y, view.y, 1e-6);
      // And a second trip lands on the identical rectangle.
      const again = cropFromView(back, natural, FRAME);
      near(again.x, crop.x, 1e-9);
      near(again.y, crop.y, 1e-9);
      near(again.w, crop.w, 1e-9);
      near(again.h, crop.h, 1e-9);
    }
  }
});

test('the frame can never leave the picture, however hard it is dragged', () => {
  // Without this there is a gap at an edge and the thumbnail shows background
  // through its corner. Every pan, every zoom and the initial load go through
  // `clampView`, so there is no path that can produce one.
  for (const natural of [LANDSCAPE, PORTRAIT, SQUARE]) {
    for (const attempt of [
      { scale: 0.4, x: 9999, y: 9999 },
      { scale: 0.4, x: -9999, y: -9999 },
      { scale: 4, x: 500, y: -20000 },
    ]) {
      const view = clampView(attempt, natural, FRAME);
      assert.ok(view.x <= 1e-9, `left gap: ${view.x}`);
      assert.ok(view.y <= 1e-9, `top gap: ${view.y}`);
      assert.ok(view.x + natural.width * view.scale >= FRAME - 1e-9, 'right gap');
      assert.ok(view.y + natural.height * view.scale >= FRAME - 1e-9, 'bottom gap');
      // And therefore the crop it produces is inside the picture.
      assert.equal(isValidCrop(cropFromView(view, natural, FRAME)), true);
    }
  }
});

test('zoom is floored at cover and capped, and holds the point under the cursor', () => {
  const natural = LANDSCAPE;
  const min = minScale(natural, FRAME);
  near(min, FRAME / 900);
  // Zooming out past cover would show through the corners, so it stops.
  const out = zoomViewAt(initialView(natural, FRAME), 0.01, 160, 160, natural, FRAME);
  near(out.scale, min);
  // And there is a ceiling, or you can zoom to four source pixels.
  let inward = initialView(natural, FRAME);
  for (let i = 0; i < 20; i++) inward = zoomViewAt(inward, 2, 160, 160, natural, FRAME);
  near(inward.scale, min * MAX_SCALE_FACTOR);
  // At a limit the SAME object comes back, so a caller can skip a state write.
  assert.equal(zoomViewAt(inward, 2, 160, 160, natural, FRAME), inward);

  // The point under the cursor stays under the cursor — the whole feel of a
  // zoom, and the one thing that makes framing a face possible.
  const before = { scale: min * 2, x: -100, y: -60 };
  const [cx, cy] = [210, 90];
  const imageX = (cx - before.x) / before.scale;
  const imageY = (cy - before.y) / before.scale;
  const after = zoomViewAt(before, 1.35, cx, cy, natural, FRAME);
  near((cx - after.x) / after.scale, imageX, 1e-6);
  near((cy - after.y) / after.scale, imageY, 1e-6);
});

test('a crop renders as CSS that needs no intrinsic image size', () => {
  // The point of normalising per axis: a 24px roster thumbnail and a 112px
  // board portrait use the identical percentages, with no onLoad anywhere.
  const style = cropStyle({ x: 0.25, y: 0.1, w: 0.5, h: 0.5 });
  assert.equal(style.width, '200%');
  assert.equal(style.height, '200%');
  assert.equal(style.left, '-50%');
  assert.equal(style.top, '-20%');
  // `maxWidth: none` matters: the app's CSS reset caps images at 100% and would
  // silently undo every zoom.
  assert.equal(style.maxWidth, 'none');
  // A full-frame crop is the identity, which is what an uncropped picture in a
  // square box already looks like.
  const whole = cropStyle({ x: 0, y: 0, w: 1, h: 1 });
  assert.equal(whole.width, '100%');
  assert.equal(whole.left, '0%');
});

test('anything that is not a real rectangle falls back to no crop at all', () => {
  // NULL is not "the default crop", it is "render exactly as before" — which is
  // what keeps this change invisible to every picture already uploaded.
  const bad = [
    null,
    undefined,
    {},
    { x: 0, y: 0, w: 0, h: 1 },
    { x: 0, y: 0, w: NaN, h: 1 },
    { x: -0.2, y: 0, w: 0.5, h: 0.5 },
    { x: 0.8, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.9, w: 0.5, h: 0.5 },
    { x: '0', y: 0, w: 0.5, h: 0.5 },
  ];
  for (const crop of bad) {
    assert.equal(isValidCrop(crop), false, JSON.stringify(crop));
    assert.equal(cropStyle(crop), null, JSON.stringify(crop));
  }
  assert.equal(isValidCrop({ x: 0, y: 0, w: 1, h: 1 }), true);
  // A row straight out of the database, with the columns never written.
  assert.equal(cropOf({ image_data: 'x' }), null);
  assert.equal(cropOf({ crop_x: null, crop_y: null, crop_w: null, crop_h: null }), null);
  assert.deepEqual(cropOf({ crop_x: 0.1, crop_y: 0.2, crop_w: 0.3, crop_h: 0.4 }), {
    x: 0.1, y: 0.2, w: 0.3, h: 0.4,
  });
});

test('cropFields sends four nulls for no crop, and rounded numbers for one', () => {
  assert.deepEqual(cropFields(null), { cropX: null, cropY: null, cropW: null, cropH: null });
  // Nulls rather than an omitted field: the server has to be able to tell
  // "clear this crop" from "leave it alone".
  assert.deepEqual(cropFields({ x: 1 / 3, y: 0, w: 0.5, h: 0.5 }), {
    cropX: 0.333333, cropY: 0, cropW: 0.5, cropH: 0.5,
  });
});

test('a degenerate picture never produces NaN', () => {
  // Reachable: an SVG with no intrinsic size, or a decode that failed and left
  // zeroes behind. It must render something rather than writing NaN into four
  // columns.
  for (const natural of [{ width: 0, height: 0 }, { width: 100, height: 0 }]) {
    const view = initialView(natural, FRAME);
    assert.ok(Number.isFinite(view.scale) && Number.isFinite(view.x) && Number.isFinite(view.y));
    const crop = cropFromView(view, natural, FRAME);
    assert.equal(isValidCrop(crop), false, 'a degenerate crop is refused, not stored');
    assert.deepEqual(cropFields(crop), { cropX: null, cropY: null, cropW: null, cropH: null });
  }
  assert.ok(Number.isFinite(minScale(LANDSCAPE, 0)));
});
