import { cropStyle } from '../lib/imageCrop.js';

// One picture, showing the region its owner chose.
//
// **The only place a stored crop is turned into pixels.** Every thumbnail in
// the app goes through here or through `Thumb`, which wraps it, so there is one
// implementation of "how a crop renders" rather than two dozen that would
// eventually disagree about which corner `crop_x` measures from.
//
// With no crop this collapses to exactly what was here before — a plain
// `object-cover` <img> — which is what keeps every picture uploaded before the
// crop editor existed looking identical.
//
// The frame is `position: relative; overflow: hidden` and the image inside it
// is absolutely positioned from four percentages, so no intrinsic size is ever
// needed and the render stays synchronous. See `imageCrop.js` for the maths.
export default function CroppedImage({
  src,
  alt = '',
  crop,
  className = '',
  style,
  draggable,
  loading,
}) {
  const inner = cropStyle(crop);
  if (!inner) {
    return (
      <img
        src={src}
        alt={alt}
        draggable={draggable}
        loading={loading}
        className={`${className} object-cover`}
        style={style}
      />
    );
  }
  return (
    <span className={`relative block overflow-hidden ${className}`} style={style}>
      {/* **The inner square, and why it is not optional.**
          The crop maths assumes the region it is filling is square, because the
          stored rectangle is square in image pixels — that is the whole reason
          scaling width and height by different factors still comes out with the
          original aspect ratio. Drop that assumption and a portrait in a
          non-square frame is visibly stretched, which reads as a bad photograph
          rather than as a bug. Caught by measuring a 194x224 frame and finding a
          3:1 picture rendered at 2.6:1.
          `aspect-ratio: 1` with both minimums at 100% is exactly a square of
          side max(width, height) — so it covers any frame — and centring it
          gives the same overflow-both-ways behaviour `object-fit: cover` has. */}
      <span
        className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2"
        style={{ aspectRatio: '1 / 1', minWidth: '100%', minHeight: '100%' }}
      >
        <img src={src} alt={alt} draggable={draggable} loading={loading} style={inner} />
      </span>
    </span>
  );
}
