// Choosing which part of an uploaded picture actually shows.
//
// **A stored rectangle, never a baked-in cut.** The full picture stays in
// `image_data` exactly as uploaded — the Arena card renders it whole, and
// re-opening the crop editor starts from the original rather than from a
// previous crop of a crop. What is stored beside it is four numbers.
//
// **Normalised per axis, not as a square.** `crop_w` is a fraction of the
// image's width and `crop_h` a fraction of its height, which looks odd until
// you see what it buys: rendering needs no intrinsic image size at all.
//
//     width:  calc(100% / crop_w)      left: calc(-100% * crop_x / crop_w)
//     height: calc(100% / crop_h)      top:  calc(-100% * crop_y / crop_h)
//
// — four CSS lengths on an <img> inside an `overflow: hidden` box, and the
// chosen region fills the frame. No `onLoad`, no `naturalWidth`, no second
// render pass, and every one of the two dozen places that show a thumbnail
// stays a plain synchronous render. The editor is what keeps the *pixel* region
// square (see `cropFromView`), so the aspect ratio is preserved by construction
// rather than by the renderer.
//
// A NULL crop is not "the default crop" — it is **no crop**, and renders with
// plain `object-fit: cover` exactly as everything did before this existed. That
// is what makes this change invisible to every picture already uploaded.

// A crop must stay a sane fraction of the picture: past this you are looking at
// a handful of source pixels blown up to fill a thumbnail.
export const MIN_CROP = 0.05;

export const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

// Is this a crop worth applying? Anything else — a missing field, a NaN out of
// a bad row, a zero width — falls back to `object-cover`.
export function isValidCrop(crop) {
  if (!crop) return false;
  const { x, y, w, h } = crop;
  if (![x, y, w, h].every(isFiniteNumber)) return false;
  if (!(w > 0) || !(h > 0)) return false;
  // Allow a hair over the edge for floating-point drift, but not a rectangle
  // that genuinely leaves the picture.
  const slack = 1e-6;
  return x >= -slack && y >= -slack && x + w <= 1 + slack && y + h <= 1 + slack;
}

// Pull a crop off a database row. The columns are flat (`crop_x`…) because that
// is how every other optional field on these tables is stored.
export const cropOf = (record) => {
  const crop = {
    x: record?.crop_x,
    y: record?.crop_y,
    w: record?.crop_w,
    h: record?.crop_h,
  };
  return isValidCrop(crop) ? crop : null;
};

// The CSS that shows `crop` inside a square frame. Returned as a style object
// for the <img>; the frame itself supplies `position: relative; overflow:
// hidden`. Percentages throughout, so it is correct at any frame size — a 24px
// roster thumbnail and a 112px board portrait use the identical numbers.
export function cropStyle(crop) {
  if (!isValidCrop(crop)) return null;
  return {
    position: 'absolute',
    width: `${100 / crop.w}%`,
    height: `${100 / crop.h}%`,
    left: `${(-100 * crop.x) / crop.w}%`,
    top: `${(-100 * crop.y) / crop.h}%`,
    maxWidth: 'none',
  };
}

// ---------------------------------------------------------------------------
// The editor's view
// ---------------------------------------------------------------------------
//
// The editor shows the picture behind a square frame of side `frame`, and you
// pan and zoom it until the part you want is inside. The view is
// `{ scale, x, y }`: the image is drawn at `(natural × scale)` with its
// top-left at `(x, y)` in frame coordinates. Exactly the shape the relationship
// board's camera uses, and for the same reason — one representation, converted
// in one place.

// The smallest scale that still covers the frame. Zooming out past it would
// show background through the corners, so it is the floor rather than a
// suggestion.
export function minScale(natural, frame) {
  const shorter = Math.min(natural.width, natural.height);
  if (!(shorter > 0) || !(frame > 0)) return 1;
  return frame / shorter;
}

export const MAX_SCALE_FACTOR = 8;

export function clampScale(scale, natural, frame) {
  const min = minScale(natural, frame);
  if (!isFiniteNumber(scale)) return min;
  return Math.max(min, Math.min(min * MAX_SCALE_FACTOR, scale));
}

// Keep the frame inside the picture. Called after every pan, every zoom and
// once on load, so there is no path that can leave a gap at an edge.
export function clampView(view, natural, frame) {
  const scale = clampScale(view.scale, natural, frame);
  const w = natural.width * scale;
  const h = natural.height * scale;
  return {
    scale,
    // `min(0, …)` on the left and `max(frame - w, …)` on the right: the image's
    // top-left is at or left of the frame's, and its bottom-right at or right
    // of the frame's. When the two coincide there is exactly one legal value.
    x: Math.min(0, Math.max(frame - w, view.x)),
    y: Math.min(0, Math.max(frame - h, view.y)),
  };
}

// The view that shows the whole of the largest centred square — what
// `object-fit: cover` already does, so opening the editor on a picture shows it
// exactly as the app would without any crop at all.
export function initialView(natural, frame) {
  const scale = minScale(natural, frame);
  return clampView(
    { scale, x: (frame - natural.width * scale) / 2, y: (frame - natural.height * scale) / 2 },
    natural,
    frame
  );
}

// view -> stored crop. The frame is square in *frame* pixels, so the region it
// covers is square in *image* pixels too — which is the invariant the renderer
// relies on to scale width and height by different factors and still come out
// with the original aspect ratio.
export function cropFromView(view, natural, frame) {
  const { scale, x, y } = clampView(view, natural, frame);
  const side = frame / scale; // in image pixels, and square
  return {
    x: -x / scale / natural.width,
    y: -y / scale / natural.height,
    w: side / natural.width,
    h: side / natural.height,
  };
}

// stored crop -> view, for re-opening the editor on a picture already cropped.
// The exact inverse of `cropFromView`, and tested as such: a round trip that
// drifts would nudge every crop a little further each time it was edited.
export function viewFromCrop(crop, natural, frame) {
  if (!isValidCrop(crop)) return initialView(natural, frame);
  const side = crop.w * natural.width;
  if (!(side > 0)) return initialView(natural, frame);
  const scale = frame / side;
  return clampView(
    { scale, x: -crop.x * natural.width * scale, y: -crop.y * natural.height * scale },
    natural,
    frame
  );
}

// Zoom about a point in frame coordinates, holding whatever is under it still —
// the same pullback the board's camera uses, for the same reason: anything else
// reads as the picture sliding away from your fingers.
export function zoomViewAt(view, factor, px, py, natural, frame) {
  const scale = clampScale(view.scale * factor, natural, frame);
  if (scale === view.scale) return view;
  const k = scale / view.scale;
  return clampView({ scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k }, natural, frame);
}

// The payload the upload sites send. Flat, because the columns are flat, and
// rounded because six decimal places of a fraction is already sub-pixel on any
// picture anyone will upload — and it keeps the stored text short.
const round = (n) => Math.round(n * 1e6) / 1e6;

export function cropFields(crop) {
  if (!isValidCrop(crop)) return { cropX: null, cropY: null, cropW: null, cropH: null };
  return {
    cropX: round(crop.x),
    cropY: round(crop.y),
    cropW: round(crop.w),
    cropH: round(crop.h),
  };
}
