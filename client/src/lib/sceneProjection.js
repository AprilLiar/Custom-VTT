// Converts between "a fraction of the ACTIVE SCENE's background image" and
// "a fraction of THIS viewer's own measured stage box" (Scene tab plan,
// bugfix: manually-placed summons syncing wrong vertically between GM and
// Players).
//
// The backdrop renders per that Scene's own `background_fit` (server:
// scenes.background_fit — decided per-Scene, db.js's own comment), which
// crops/letterboxes/stretches the image differently depending on how the
// VIEWER's own stage box aspect ratio compares to the image's own natural
// aspect ratio — a wide desktop GM and a narrower tablet Player scale the
// same image differently even under the SAME fit mode. A position stored
// as a fraction of the STAGE BOX (the original scheme) rides on top of
// that, so it drifts between viewers whenever their aspect ratios differ —
// usually most visibly on the vertical axis, since stage boxes tend to
// differ more in height-to-width proportion than the images uploaded for
// them do. Storing/transmitting positions as a fraction of the IMAGE's own
// content instead, and projecting through each viewer's own fit geometry
// at render time, is what makes "the GM put them here" mean the same
// visual spot in the artwork for everyone — a real camera-free equivalent
// of a shared coordinate system.
//
// Every function below takes the active Scene's own `fit` (one of
// client/src/lib/backgroundFit.js's own values) and defaults it to
// `'cover'` when omitted — the original, and still most common, mode —
// so any call site that predates this parameter degrades to exactly its
// previous behavior rather than breaking.
//
// All functions degrade to a plain stage-box fraction when there's no
// image yet (natural dimensions unknown, or no backdrop at all) — the
// stage box IS the whole coordinate space in that case, same as before
// object-fraction projection existed at all.

// The two axes' own scale factors for a given fit mode — the one thing
// that actually differs between fit modes; everything else (offsets,
// rendered size) is the same formula once these are known.
// `cover`/`contain` are uniform (the same scale on both axes, one of them
// picked by Math.max/Math.min so the image either fully covers or fully
// fits inside the box). `fill` is the one mode where X and Y genuinely
// differ — the image is stretched independently to match the box exactly,
// which is the whole point of "Stretch." `fit-height`/`fit-width` are also
// uniform, just pinned to one specific axis's own ratio regardless of
// which axis that leaves overflowing or underflowing — there is no
// `object-fit` keyword for either (object-fit always PICKS an axis itself
// based on aspect ratio; these two force a specific one).
function fitScale(fit, containerWidth, containerHeight, naturalWidth, naturalHeight) {
  const rw = containerWidth / naturalWidth;
  const rh = containerHeight / naturalHeight;
  switch (fit) {
    case 'contain':
      return { x: Math.min(rw, rh), y: Math.min(rw, rh) };
    case 'fill':
      return { x: rw, y: rh };
    case 'fit-height':
      return { x: rh, y: rh };
    case 'fit-width':
      return { x: rw, y: rw };
    case 'cover':
    default:
      return { x: Math.max(rw, rh), y: Math.max(rw, rh) };
  }
}

function fitGeometry(fit, containerWidth, containerHeight, naturalWidth, naturalHeight) {
  const { x: scaleX, y: scaleY } = fitScale(fit, containerWidth, containerHeight, naturalWidth, naturalHeight);
  const renderedWidth = naturalWidth * scaleX;
  const renderedHeight = naturalHeight * scaleY;
  return {
    renderedWidth,
    renderedHeight,
    // Centers the rendered image in the box on whichever axis it doesn't
    // exactly fill — negative when it overflows (cover, fit-height on a
    // wide image, fit-width on a tall one: this axis crops), positive
    // when it underflows (contain, fit-height on a tall image, fit-width
    // on a wide one: this axis letterboxes). The formula is identical
    // either way; only the sign differs; `fill` always lands on exactly
    // 0 for both, since renderedWidth/Height already equal the container.
    offsetX: (containerWidth - renderedWidth) / 2,
    offsetY: (containerHeight - renderedHeight) / 2,
  };
}

// Screen (stage-box-relative) pixels -> a fraction of the image's own content.
export function stageToImageFraction({ x, y, containerWidth, containerHeight, naturalWidth, naturalHeight, fit = 'cover' }) {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return {
      fx: containerWidth ? x / containerWidth : 0,
      fy: containerHeight ? y / containerHeight : 0,
    };
  }
  const { renderedWidth, renderedHeight, offsetX, offsetY } = fitGeometry(
    fit,
    containerWidth,
    containerHeight,
    naturalWidth,
    naturalHeight
  );
  return { fx: (x - offsetX) / renderedWidth, fy: (y - offsetY) / renderedHeight };
}

// A fraction of the image's own content -> screen (stage-box-relative) pixels.
export function imageFractionToStage({ fx, fy, containerWidth, containerHeight, naturalWidth, naturalHeight, fit = 'cover' }) {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return { x: fx * (containerWidth || 0), y: fy * (containerHeight || 0) };
  }
  const { renderedWidth, renderedHeight, offsetX, offsetY } = fitGeometry(
    fit,
    containerWidth,
    containerHeight,
    naturalWidth,
    naturalHeight
  );
  return { x: offsetX + fx * renderedWidth, y: offsetY + fy * renderedHeight };
}

// A LENGTH (e.g. a drawing stroke's width) in stage-box pixels -> a fraction
// of the image's own natural width — same reasoning as the point functions
// above, so a line looks the same relative thickness on every viewer's own
// screen regardless of their stage box's size. Falls back to a fraction of
// the stage box itself with no image loaded yet. Always keyed off the
// horizontal (X) scale specifically, even under `fill` where X and Y
// genuinely differ — a canvas stroke's own `lineWidth` is isotropic (one
// thickness, not a separate horizontal/vertical one), so there is no fully
// faithful answer once the backdrop itself is being stretched unevenly;
// this at least stays exactly correct for every OTHER fit mode, where
// scaleX and scaleY are always equal anyway.
export function stageLengthToImageFraction(px, containerWidth, naturalWidth, naturalHeight, containerHeight, fit = 'cover') {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return containerWidth ? px / containerWidth : 0;
  }
  const { x: scaleX } = fitScale(fit, containerWidth, containerHeight, naturalWidth, naturalHeight);
  return px / (naturalWidth * scaleX);
}

export function imageFractionLengthToStage(fraction, containerWidth, naturalWidth, naturalHeight, containerHeight, fit = 'cover') {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return fraction * (containerWidth || 0);
  }
  const { x: scaleX } = fitScale(fit, containerWidth, containerHeight, naturalWidth, naturalHeight);
  return fraction * naturalWidth * scaleX;
}
