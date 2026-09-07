// Converts between "a fraction of the ACTIVE SCENE's background image" and
// "a fraction of THIS viewer's own measured stage box" (Scene tab plan,
// bugfix: manually-placed summons syncing wrong vertically between GM and
// Players).
//
// The backdrop renders with `object-cover` (ScenePage.jsx), which crops the
// image differently depending on how the VIEWER's own stage box aspect
// ratio compares to the image's own natural aspect ratio — a wide desktop
// GM and a narrower tablet Player crop the same image differently. A
// position stored as a fraction of the STAGE BOX (the original scheme) rides
// on top of that crop, so it drifts between viewers whenever their aspect
// ratios differ — usually most visibly on the vertical axis, since stage
// boxes tend to differ more in height-to-width proportion than the images
// uploaded for them do. Storing/transmitting positions as a fraction of the
// IMAGE's own content instead, and projecting through each viewer's own
// object-cover crop at render time, is what makes "the GM put them here"
// mean the same visual spot in the artwork for everyone — a real camera-free
// equivalent of a shared coordinate system.
//
// Both functions degrade to a plain stage-box fraction when there's no
// image yet (natural dimensions unknown, or no backdrop at all) — the
// stage box IS the whole coordinate space in that case, same as before this
// fix existed.

function coverGeometry(containerWidth, containerHeight, naturalWidth, naturalHeight) {
  const scale = Math.max(containerWidth / naturalWidth, containerHeight / naturalHeight);
  const renderedWidth = naturalWidth * scale;
  const renderedHeight = naturalHeight * scale;
  return {
    renderedWidth,
    renderedHeight,
    offsetX: (containerWidth - renderedWidth) / 2,
    offsetY: (containerHeight - renderedHeight) / 2,
  };
}

// Screen (stage-box-relative) pixels -> a fraction of the image's own content.
export function stageToImageFraction({ x, y, containerWidth, containerHeight, naturalWidth, naturalHeight }) {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return {
      fx: containerWidth ? x / containerWidth : 0,
      fy: containerHeight ? y / containerHeight : 0,
    };
  }
  const { renderedWidth, renderedHeight, offsetX, offsetY } = coverGeometry(
    containerWidth,
    containerHeight,
    naturalWidth,
    naturalHeight
  );
  return { fx: (x - offsetX) / renderedWidth, fy: (y - offsetY) / renderedHeight };
}

// A fraction of the image's own content -> screen (stage-box-relative) pixels.
export function imageFractionToStage({ fx, fy, containerWidth, containerHeight, naturalWidth, naturalHeight }) {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return { x: fx * (containerWidth || 0), y: fy * (containerHeight || 0) };
  }
  const { renderedWidth, renderedHeight, offsetX, offsetY } = coverGeometry(
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
// the stage box itself with no image loaded yet.
export function stageLengthToImageFraction(px, containerWidth, naturalWidth, naturalHeight, containerHeight) {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return containerWidth ? px / containerWidth : 0;
  }
  const scale = Math.max(containerWidth / naturalWidth, containerHeight / naturalHeight);
  return px / (naturalWidth * scale);
}

export function imageFractionLengthToStage(fraction, containerWidth, naturalWidth, naturalHeight, containerHeight) {
  if (!naturalWidth || !naturalHeight || !containerWidth || !containerHeight) {
    return fraction * (containerWidth || 0);
  }
  const scale = Math.max(containerWidth / naturalWidth, containerHeight / naturalHeight);
  return fraction * naturalWidth * scale;
}
