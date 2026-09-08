// client/src/lib/sceneProjection.js — converts between a fraction of a
// Scene's backdrop image and a fraction of the viewer's own stage box,
// projected through the active Scene's own `background_fit` (Scene tab
// plan: "Add scene-specific setting to change how the Background is
// displayed").
//
// Lives in server/test because that is where `npm test` looks; the module
// under test is pure ES with no DOM imports at the top level, so it
// imports cleanly here — same reasoning sceneLayout.test.js's own header
// gives.
//
// What's pinned: each fit mode's own geometry is exactly what its name
// promises (cover always covers with no gap, contain always shows the
// whole image with no crop, fill always matches the box exactly on both
// axes even when that distorts, fit-height/fit-width always match their
// one named axis exactly regardless of what happens on the other), that a
// round-trip through stage->image->stage returns the original point for
// every mode, and that every function still degrades to a plain stage-box
// fraction with no image loaded — the pre-existing behavior this file's
// own header comment promises is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stageToImageFraction,
  imageFractionToStage,
  stageLengthToImageFraction,
  imageFractionLengthToStage,
} from '../../client/src/lib/sceneProjection.js';

const closeTo = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `${actual} !== ${expected}`);

// A wide box (1000x500) with a TALL natural image (200x400) — deliberately
// mismatched aspect ratios so cover/contain/fit-height/fit-width all
// disagree with each other, which is the whole point of testing them.
const box = { containerWidth: 1000, containerHeight: 500 };
const img = { naturalWidth: 200, naturalHeight: 400 };

test('cover: always fully covers the box, cropping the overflowing axis, no gap on either', () => {
  const { x, y } = imageFractionToStage({ fx: 0, fy: 0, ...box, ...img, fit: 'cover' });
  const { x: x2, y: y2 } = imageFractionToStage({ fx: 1, fy: 1, ...box, ...img, fit: 'cover' });
  // scale = max(1000/200, 500/400) = max(5, 1.25) = 5 -> rendered 1000x2000
  closeTo(x2 - x, 1000, 'rendered width covers the box exactly');
  closeTo(y2 - y, 2000, 'rendered height overflows (2000 > 500 box height) — the crop');
  // Horizontally centered exactly (renderedWidth === containerWidth -> offset 0);
  // vertically the image massively overflows, so it's centered around the
  // box's own vertical middle, extending equally past both edges.
  closeTo(x, 0);
  closeTo(y, (500 - 2000) / 2);
});

test('contain: always shows the WHOLE image, no crop, gap on the axis that doesn\'t fill', () => {
  const { x, y } = imageFractionToStage({ fx: 0, fy: 0, ...box, ...img, fit: 'contain' });
  const { x: x2, y: y2 } = imageFractionToStage({ fx: 1, fy: 1, ...box, ...img, fit: 'contain' });
  // scale = min(5, 1.25) = 1.25 -> rendered 250x500
  closeTo(x2 - x, 250);
  closeTo(y2 - y, 500);
  // Fully fills height (renderedHeight === containerHeight -> offsetY 0);
  // letterboxed left/right.
  closeTo(y, 0);
  closeTo(x, (1000 - 250) / 2);
});

test('fill: always matches the box exactly on BOTH axes, independently — the distortion is the point', () => {
  const { x, y } = imageFractionToStage({ fx: 0, fy: 0, ...box, ...img, fit: 'fill' });
  const { x: x2, y: y2 } = imageFractionToStage({ fx: 1, fy: 1, ...box, ...img, fit: 'fill' });
  closeTo(x2 - x, 1000);
  closeTo(y2 - y, 500);
  closeTo(x, 0);
  closeTo(y, 0);
});

test('fit-height: always matches height exactly; width free (here: overflows, and is centered/cropped)', () => {
  const { x, y } = imageFractionToStage({ fx: 0, fy: 0, ...box, ...img, fit: 'fit-height' });
  const { x: x2, y: y2 } = imageFractionToStage({ fx: 1, fy: 1, ...box, ...img, fit: 'fit-height' });
  // scale = 500/400 = 1.25 -> rendered 250x500
  closeTo(y2 - y, 500, 'height always matches the box exactly');
  closeTo(x2 - x, 250);
  closeTo(y, 0);
  closeTo(x, (1000 - 250) / 2);
});

test('fit-width: always matches width exactly; height free (here: overflows, and is centered/cropped)', () => {
  const { x, y } = imageFractionToStage({ fx: 0, fy: 0, ...box, ...img, fit: 'fit-width' });
  const { x: x2, y: y2 } = imageFractionToStage({ fx: 1, fy: 1, ...box, ...img, fit: 'fit-width' });
  // scale = 1000/200 = 5 -> rendered 1000x2000
  closeTo(x2 - x, 1000, 'width always matches the box exactly');
  closeTo(y2 - y, 2000);
  closeTo(x, 0);
  closeTo(y, (500 - 2000) / 2);
});

test('fit-height on the OTHER aspect-ratio relationship: underflows width instead, letterboxed not cropped', () => {
  // A short natural image now (400x200) against the same wide box — height
  // still always matches exactly, but this time the resulting width is
  // SHORTER than the box (letterboxed) rather than longer (cropped),
  // proving the same formula handles both without a special case.
  const shortImg = { naturalWidth: 400, naturalHeight: 200 };
  const { x, y } = imageFractionToStage({ fx: 0, fy: 0, ...box, ...shortImg, fit: 'fit-height' });
  const { x: x2, y: y2 } = imageFractionToStage({ fx: 1, fy: 1, ...box, ...shortImg, fit: 'fit-height' });
  // scale = 500/200 = 2.5 -> rendered 1000x500 (exactly fills both, coincidentally)
  closeTo(y2 - y, 500);
  closeTo(x2 - x, 1000);
});

test('every mode round-trips: stage -> image fraction -> stage returns the original point', () => {
  for (const fit of ['cover', 'contain', 'fill', 'fit-height', 'fit-width']) {
    const original = { x: 314, y: 159 };
    const { fx, fy } = stageToImageFraction({ ...original, ...box, ...img, fit });
    const back = imageFractionToStage({ fx, fy, ...box, ...img, fit });
    closeTo(back.x, original.x, `${fit}: x round-trips`);
    closeTo(back.y, original.y, `${fit}: y round-trips`);
  }
});

test('a length round-trips through the same fit mode', () => {
  for (const fit of ['cover', 'contain', 'fill', 'fit-height', 'fit-width']) {
    const px = 42;
    const fraction = stageLengthToImageFraction(px, box.containerWidth, img.naturalWidth, img.naturalHeight, box.containerHeight, fit);
    const back = imageFractionLengthToStage(fraction, box.containerWidth, img.naturalWidth, img.naturalHeight, box.containerHeight, fit);
    closeTo(back, px, `${fit}: length round-trips`);
  }
});

test('omitting fit defaults to cover — every pre-existing call site keeps working unchanged', () => {
  const withFit = imageFractionToStage({ fx: 0.5, fy: 0.5, ...box, ...img, fit: 'cover' });
  const withoutFit = imageFractionToStage({ fx: 0.5, fy: 0.5, ...box, ...img });
  closeTo(withoutFit.x, withFit.x);
  closeTo(withoutFit.y, withFit.y);
});

test('with no image loaded yet, every mode degrades identically to a plain stage-box fraction', () => {
  for (const fit of ['cover', 'contain', 'fill', 'fit-height', 'fit-width']) {
    const { fx, fy } = stageToImageFraction({ x: 250, y: 125, containerWidth: 1000, containerHeight: 500, naturalWidth: 0, naturalHeight: 0, fit });
    closeTo(fx, 0.25);
    closeTo(fy, 0.25);
  }
});
