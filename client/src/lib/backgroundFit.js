// A Scene's own backdrop-scaling mode (server: scenes.background_fit —
// db.js's own comment on why this is per-Scene, not a per-viewer Settings
// slider). Shared between SceneEditor.jsx (the <select> options below) and
// ScenePage.jsx (backdropFitClassName, the actual className the backdrop
// <img> renders with) — one list, so a fit mode can never exist in the
// picker without existing in the renderer, or vice versa. Mirrors
// server/index.js's own VALID_BACKGROUND_FITS set exactly.
export const DEFAULT_BACKGROUND_FIT = 'cover';

export const BACKGROUND_FIT_OPTIONS = [
  { value: 'cover', label: 'Cover (Crop to Fill)' },
  { value: 'contain', label: 'Best Fit (Show Whole Image)' },
  { value: 'fill', label: 'Stretch (Fill Exactly)' },
  { value: 'fit-height', label: 'Vertical Fit (Match Height)' },
  { value: 'fit-width', label: 'Horizontal Fit (Match Width)' },
];

// `cover`/`contain`/`fill` map straight onto their own CSS `object-fit`
// keyword. `fit-height`/`fit-width` don't exist as an `object-fit` keyword
// at all — `object-fit` always picks ONE axis to match itself, based on
// the image's own aspect ratio versus the box's; these two force a
// SPECIFIC axis regardless, which needs a different technique: size the
// `<img>` itself along just that one axis (`height: 100%` or `width: 100%`,
// the OTHER left `auto` — how a plain replaced element already scales
// proportionally with zero help from `object-fit`) and center it on the
// free axis. `max-w-none`/an explicit width still beat Tailwind's own
// preflight `img { max-width: 100% }` reset the same way StageRoster.jsx's
// own height-only sizing needs it to. The parent stage's own
// `overflow-hidden` (ScenePage.jsx's outer div) clips whatever overflows
// on the free axis, exactly like `cover` already relies on it doing.
const BACKDROP_FIT_CLASS = {
  cover: 'absolute inset-0 h-full w-full object-cover',
  contain: 'absolute inset-0 h-full w-full object-contain',
  fill: 'absolute inset-0 h-full w-full object-fill',
  'fit-height': 'absolute left-1/2 top-0 h-full w-auto max-w-none -translate-x-1/2',
  'fit-width': 'absolute left-0 top-1/2 h-auto w-full max-w-none -translate-y-1/2',
};

export function backdropFitClassName(fit) {
  return BACKDROP_FIT_CLASS[fit] ?? BACKDROP_FIT_CLASS[DEFAULT_BACKGROUND_FIT];
}
