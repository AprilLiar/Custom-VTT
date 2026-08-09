// The one canonical set of ink primitives — torn/brush panel edges, brush
// strokes, halftone, and grain.
//
// Visual Overhaul ("Ink & Impact"), Phase V1: the app's art direction moved
// from the Phase 8 metallic-HUD look to an anime-fighter ink look (Guilty
// Gear Strive / DBFZ reference). Every ink shape in the app is generated
// here rather than hand-authored per component, for the same reason
// framePhaseColors.js exists: a fifth ad-hoc copy of a shared visual is
// always worse than one module everything imports.
//
// **Everything here is COLOUR-AGNOSTIC on purpose.** These are all masks
// (white-on-transparent silhouettes), never coloured artwork. Colour always
// comes from CSS on the element being masked — a Tailwind `bg-*` utility or
// a `--color-brand-*` variable. That is what keeps the Settings hue picker
// (see lib/theme.js) working: swap the hue and every ink edge in the app
// follows, because none of them ever knew what colour they were.

// Deterministic PRNG (mulberry32). Seeded so a given edge variant renders
// byte-identical every time — these strings end up in CSS custom properties
// that must not change between renders, or the browser re-rasterizes the
// mask on every paint.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rawSvgUri(svg) {
  // encodeURIComponent covers the characters that actually break a CSS
  // url() — notably '#', which would otherwise truncate the data URI at the
  // first fill/stop colour or fragment.
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
}

function svgUri(svg) {
  return `url("${rawSvgUri(svg)}")`;
}

// Trace a rectangle with per-vertex jitter, in viewBox units. `amp` is the
// maximum displacement perpendicular to each edge.
//
// The path is inset by TWICE the amplitude, not once, so a vertex at
// maximum outward jitter still sits a full `amp` inside the viewBox edge.
// That margin is load-bearing: it guarantees the tear always clears the 1px
// CSS border ring of the element it masks. At a single-amp inset the tear
// grazes the edge wherever jitter ran negative, leaving the old
// `border-zinc-800` visible in patches along the boundary — which reads as
// a rendering fault rather than a brush edge, and would make removing every
// border utility a correctness requirement instead of a tidiness one.
function tornRectPath(w, h, { seed = 1, amp = 0.6, step = 8 } = {}) {
  const rand = rng(seed);
  const jitter = () => (rand() * 2 - 1) * amp;
  const pts = [];
  const push = (x, y) => pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  const inset = amp * 2;
  const x0 = inset;
  const y0 = inset;
  const x1 = w - inset;
  const y1 = h - inset;

  const walk = (from, to, fixed, axis) => {
    const span = to - from;
    const n = Math.max(2, Math.round(Math.abs(span) / step));
    for (let i = 0; i <= n; i++) {
      const t = from + (span * i) / n;
      // Corners stay put: a jittered corner reads as a rendering glitch,
      // while a jittered mid-edge reads as a brush stroke.
      //
      // The distribution matters more than the amplitude here. Jittering
      // every vertex by a uniform random amount produces an even scallop —
      // a sine wave, not a brush. A real inked edge is mostly straight with
      // occasional bites out of it, so most vertices get only a fine
      // roughness and roughly one in six takes the full amplitude.
      let j = 0;
      if (i !== 0 && i !== n) j = rand() < 0.17 ? jitter() : jitter() * 0.26;
      if (axis === 'x') push(t, fixed + j);
      else push(fixed + j, t);
    }
  };

  walk(x0, x1, y0, 'x'); // top, jitters in y
  walk(y0, y1, x1, 'y'); // right, jitters in x
  walk(x1, x0, y1, 'x'); // bottom, jitters in y
  walk(y1, y0, x0, 'y'); // left, jitters in x

  return `M${pts.join('L')}Z`;
}

// A torn-edge mask at a given viewBox aspect.
//
// The aspect matters because these are stretched with
// preserveAspectRatio="none": a viewBox scaled to an element scales x by
// w/W and y by h/H, so a jitter amplitude authored in viewBox units only
// renders equally on all four edges when W/H matches the element's own
// aspect. Hence three bands rather than one mask — a single square mask
// stretched across a wide status bar would smear its horizontal wobble flat
// while leaving the vertical wobble sharp, which reads as a bug.
function edgeMask(w, h, { seed, amp, step, stroke }) {
  const d = tornRectPath(w, h, { seed, amp, step });
  // The contour is drawn wide because the parent's fill mask trims its
  // outer half — a stroke authored at the width you want to see ends up
  // half that thick on screen.
  const paint = stroke
    ? `fill="none" stroke="#fff" stroke-width="${(amp * 1.6).toFixed(2)}" stroke-linejoin="round"`
    : 'fill="#fff"';
  return svgUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" ${paint}/></svg>`
  );
}

// Amplitudes are tuned so the tear renders at roughly 2-6px on a typical
// element of each band's aspect. The upper end is the real constraint: a
// mask eats that much of the panel's own content box, and the app's tightest
// padded panels sit at p-2 (8px), so a tear deeper than that would start
// clipping text rather than framing it.
//
// Steps are deliberately long. Short segments plus jitter is a wave; long
// segments plus occasional bites is a torn edge, and the second is what the
// art direction is after.
const BANDS = {
  // Roughly square panels: cards, dialogs, move/perk tiles.
  card: { w: 100, h: 100, seed: 7, amp: 0.9, step: 17 },
  // Wide, short surfaces: HUD bars, status rows, chat cards, counter panels.
  wide: { w: 260, h: 60, seed: 23, amp: 0.55, step: 26 },
  // Tall columns: side panels, roster/folder rails.
  tall: { w: 60, h: 200, seed: 41, amp: 0.55, step: 20 },
  // Big dialogs — the theater/fullscreen DialogShell variants, which run to
  // most of the viewport. These need their OWN band rather than reusing
  // `card`, because the tear depth is amplitude x scale: a 100-unit viewBox
  // stretched to a 1400px dialog multiplies a 0.9-unit tear into 13-38px and
  // eats straight through the panel's p-4 into its content. (Caught by the
  // round-replay title rendering as "OUND REPLAY".) A wider viewBox with a
  // smaller amplitude keeps the tear at ~4px whatever the dialog's size.
  hero: { w: 160, h: 100, seed: 59, amp: 0.4, step: 26 },
};

// Filled silhouettes — the panel's own shape.
export const INK_EDGE_MASKS = Object.fromEntries(
  Object.entries(BANDS).map(([name, cfg]) => [name, edgeMask(cfg.w, cfg.h, cfg)])
);

// Stroke-only versions of the exact same paths, for the outline layer that
// rides on a masked panel's ::before. Same seed as its fill, so the line
// follows the tear instead of wandering beside it.
export const INK_EDGE_LINE_MASKS = Object.fromEntries(
  Object.entries(BANDS).map(([name, cfg]) => [name, edgeMask(cfg.w, cfg.h, { ...cfg, stroke: true })])
);

// A single tapered brush stroke, left-to-right, for section underlines and
// dividers. Returned as raw path data (not a URI) because its callers draw
// it as a real <path> inside an inline <svg> — that is what lets Framer
// Motion animate `pathLength` to draw the stroke on, which a background
// image could never do.
export const INK_STROKE_VIEWBOX = '0 0 200 12';

export function inkStroke(seed = 1) {
  const rand = rng(seed);
  const pts = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const x = (200 * i) / n;
    // Settles toward the middle at both ends so the stroke reads as a
    // brush lifting off rather than a line stopping.
    const taper = Math.sin((Math.PI * i) / n);
    const y = 6 + (rand() * 2 - 1) * 1.6 * taper;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `M${pts.join('L')}`;
}

// Paper/ink grain, baked from feTurbulence into a tile.
//
// A <filter> inside an SVG used as a background-image is rasterized once by
// the browser and cached as an image — it is NOT re-filtering the DOM on
// every paint, which is why this is affordable as an always-on overlay
// while a `filter: url(#...)` on live content would not be.
export const INK_GRAIN = svgUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
     <filter id="g">
       <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>
       <feColorMatrix type="saturate" values="0"/>
     </filter>
     <rect width="180" height="180" filter="url(#g)" opacity="0.5"/>
   </svg>`
);

// Sumi splatter silhouette — the Medium-tier stand-in for Phase V3's WebGL
// splatter, and the alpha texture that WebGL layer samples at High tier.
// One shape, two consumers, so a hit looks like the same ink either way.
//
// Exported in both forms on purpose: CSS needs the `url(...)` wrapper,
// while WebGL needs a bare URI to hand an Image element.
export const INK_SPLAT_URI = rawSvgUri(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
     <g fill="#fff">
       <circle cx="32" cy="32" r="13"/>
       <circle cx="15" cy="24" r="5.5"/><circle cx="49" cy="26" r="4.5"/>
       <circle cx="21" cy="46" r="4"/><circle cx="45" cy="45" r="5"/>
       <circle cx="32" cy="12" r="3.5"/><circle cx="8" cy="38" r="2.5"/>
       <circle cx="56" cy="40" r="2"/><circle cx="34" cy="56" r="2.5"/>
     </g>
   </svg>`
);

export const INK_SPLAT = `url("${INK_SPLAT_URI}")`;

// Publish every generated mask onto :root as a CSS custom property, so
// index.css's .ink-* classes reference them by name instead of the shapes
// being duplicated as literal data URIs in the stylesheet.
//
// Called once from main.jsx alongside initTheme(), before React renders —
// same reasoning as the saved brand hue: a variable that arrives after the
// first paint shows up as a visible flash of unstyled panels.
export function initInk() {
  const root = document.documentElement.style;
  for (const [name, uri] of Object.entries(INK_EDGE_MASKS)) {
    root.setProperty(`--ink-edge-${name}`, uri);
  }
  for (const [name, uri] of Object.entries(INK_EDGE_LINE_MASKS)) {
    root.setProperty(`--ink-edge-line-${name}`, uri);
  }
  root.setProperty('--ink-grain', INK_GRAIN);
  root.setProperty('--ink-splat', INK_SPLAT);
}
