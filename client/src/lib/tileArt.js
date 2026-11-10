// How each map tile is drawn (decided): a frame just inside its square, with
// the tile's own motif living in the four corners — bricks for a Wall, loose
// rocks for Rubble, spikes for a Trap, depth rings for a Pit, wisps for Fog,
// hazard stripes, crowns, brackets and sparkles for the markers — and its name
// in the middle. Kept light so the map still reads through it.
//
// Every shape is authored once, for the TOP-LEFT corner, in unit-square
// coordinates (0..1), and mirrored into the other three. A square on the map
// is a rectangle, a lane space is a trapezoid in perspective; `mapQuad` bends
// the unit square into either (bilinear), so the art follows the square's
// shape. Pure — no React.

const circle = (cx, cy, r, n = 9, wobble = 0) =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + (wobble ? Math.sin(i * 2.7) * wobble : 0));
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  });
const rect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
const E = 0.07; // the frame's inset from the square's edge

// Shapes: { t: 'poly' (filled), 'line' (stroked open path), points, fill?,
// opacity?, width? (stroke, as a share of the square) }. `color` = the tile's.
const MOTIFS = {
  wall: [
    { t: 'poly', points: rect(E, E, 0.13, 0.055) },
    { t: 'poly', points: rect(E + 0.145, E, 0.08, 0.055) },
    { t: 'poly', points: rect(E, E + 0.07, 0.06, 0.055) },
    { t: 'poly', points: rect(E + 0.075, E + 0.07, 0.11, 0.055) },
    { t: 'poly', points: rect(E, E + 0.14, 0.1, 0.055) },
  ],
  rubble: [
    { t: 'poly', points: circle(E + 0.05, E + 0.05, 0.04, 6, 0.25) },
    { t: 'poly', points: circle(E + 0.14, E + 0.03, 0.025, 5, 0.3) },
    { t: 'poly', points: circle(E + 0.03, E + 0.14, 0.028, 5, 0.3) },
    { t: 'poly', points: circle(E + 0.12, E + 0.11, 0.018, 5, 0.3) },
    { t: 'poly', points: circle(E + 0.21, E + 0.06, 0.014, 5, 0.3), opacity: 0.8 },
  ],
  trap: [
    ...[0, 0.07, 0.14].map((d) => ({ t: 'poly', points: [[E + d, E], [E + d + 0.07, E], [E + d + 0.035, E + 0.09]] })),
    ...[0.07, 0.14].map((d) => ({ t: 'poly', points: [[E, E + d], [E, E + d + 0.07], [E + 0.09, E + d + 0.035]] })),
  ],
  pit: [
    { t: 'poly', points: [[E, E], [E + 0.26, E], [E, E + 0.26]], fill: '#000', opacity: 0.35 },
    ...[0.1, 0.17, 0.24].map((r, i) => ({
      t: 'line',
      points: Array.from({ length: 7 }, (_, k) => {
        const a = (k / 6) * (Math.PI / 2);
        return [E + Math.cos(a) * r, E + Math.sin(a) * r];
      }),
      width: 0.022,
      opacity: 0.95 - i * 0.28,
    })),
  ],
  fog: [
    { t: 'poly', points: circle(E + 0.06, E + 0.06, 0.05, 10, 0.12), opacity: 0.55 },
    { t: 'poly', points: circle(E + 0.14, E + 0.04, 0.035, 10, 0.12), opacity: 0.4 },
    { t: 'poly', points: circle(E + 0.04, E + 0.14, 0.035, 10, 0.12), opacity: 0.4 },
    {
      t: 'line',
      points: Array.from({ length: 9 }, (_, k) => [E + 0.1 + k * 0.025, E + 0.12 + Math.sin(k * 1.2) * 0.012]),
      width: 0.016,
      opacity: 0.7,
    },
  ],
  danger: [0, 0.1, 0.2].map((k) => ({
    t: 'poly',
    points: [[E / 2, E / 2 + k], [E / 2, E / 2 + k + 0.05], [E / 2 + k + 0.05, E / 2], [E / 2 + k, E / 2]],
    opacity: 0.9,
  })),
  king: [
    {
      t: 'poly',
      points: [[E / 2 + 0.02, E / 2 + 0.15], [E / 2 + 0.02, E / 2 + 0.05], [E / 2 + 0.06, E / 2 + 0.1], [E / 2 + 0.1, E / 2 + 0.02], [E / 2 + 0.14, E / 2 + 0.1], [E / 2 + 0.18, E / 2 + 0.05], [E / 2 + 0.18, E / 2 + 0.15]],
      opacity: 0.9,
    },
  ],
  control: [{ t: 'line', points: [[E / 2, E / 2 + 0.22], [E / 2, E / 2], [E / 2 + 0.22, E / 2]], width: 0.05 }],
  important: [
    {
      t: 'poly',
      points: [[0.16, 0.06], [0.185, 0.135], [0.26, 0.16], [0.185, 0.185], [0.16, 0.26], [0.135, 0.185], [0.06, 0.16], [0.135, 0.135]],
    },
  ],
};
MOTIFS.pit_trap = [...MOTIFS.pit, ...MOTIFS.trap.map((s) => ({ ...s, fill: '#ef4444' }))];
// A Deadly Trap: a Trap's teeth, twice over.
MOTIFS.deadly_trap = [...MOTIFS.trap, ...MOTIFS.trap.map((s) => ({ ...s, points: s.points.map(([x, y]) => [x + 0.045, y + 0.045]), opacity: 0.7 }))];

const MARKERS = new Set(['danger', 'king', 'control', 'important']);

// The four mirrored copies of one corner's points.
const CORNERS = [
  ([u, v]) => [u, v],
  ([u, v]) => [1 - u, v],
  ([u, v]) => [1 - u, 1 - v],
  ([u, v]) => [u, 1 - v],
];

// A point of the unit square inside quad [tl, tr, br, bl] (bilinear).
export function mapQuad(quad, [u, v]) {
  const [tl, tr, br, bl] = quad;
  const a = (1 - u) * (1 - v);
  const b = u * (1 - v);
  const c = u * v;
  const d = (1 - u) * v;
  return [a * tl[0] + b * tr[0] + c * br[0] + d * bl[0], a * tl[1] + b * tr[1] + c * br[1] + d * bl[1]];
}

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
// The square's average width and height, for stroke and text sizes.
export function quadSize(quad) {
  const [tl, tr, br, bl] = quad;
  return { w: (dist(tl, tr) + dist(bl, br)) / 2, h: (dist(tl, bl) + dist(tr, br)) / 2 };
}
export const quadCenter = (quad) => mapQuad(quad, [0.5, 0.5]);

const path = (pts, close) =>
  `M ${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')}${close ? ' Z' : ''}`;

// **Stacked tiles (decided, new):** up to three effects share a square as
// nested frames — layer 0 at the edge, each next one shrunk toward the centre
// (LAYER_SHRINK of the square per layer), so every frame's corner motif stays
// visible. Pure geometry: the whole unit-square design is scaled about the
// centre before being bent into the quad.
export const MAX_LAYERS = 3;
const LAYER_SHRINK = 0.17;

// Everything to draw for one tile kind in `quad`, at nesting `layer`:
// [{ d, fill?, stroke?, strokeWidth?, opacity? }].
export function tileShapes(kind, quad, color, layer = 0) {
  const k = 1 - Math.min(layer, MAX_LAYERS - 1) * LAYER_SHRINK;
  const shrink = ([u, v]) => [0.5 + (u - 0.5) * k, 0.5 + (v - 0.5) * k];
  const mq = (p) => mapQuad(quad, shrink(p));
  const { w, h } = quadSize(quad);
  const s = Math.min(w, h) * (0.6 + 0.4 * k);
  const out = [];
  const inset = MARKERS.has(kind) ? E / 2 : E;
  const frame = [
    [inset, inset],
    [1 - inset, inset],
    [1 - inset, 1 - inset],
    [inset, 1 - inset],
  ].map(mq);
  // A faint tint inside the frame (markers: fainter, they cover areas).
  out.push({ d: path(frame, true), fill: color, opacity: (MARKERS.has(kind) ? 0.08 : 0.14) * (layer ? 0.6 : 1) });
  out.push({
    d: path(frame, true),
    fill: 'none',
    stroke: color,
    strokeWidth: Math.max(1, s * (MARKERS.has(kind) ? 0.022 : 0.03)),
    opacity: 0.9,
    dash: kind === 'danger' || kind === 'king' ? `${(s * 0.08).toFixed(1)} ${(s * 0.05).toFixed(1)}` : undefined,
  });
  for (const shape of MOTIFS[kind] ?? []) {
    for (const corner of CORNERS) {
      const pts = shape.points.map((p) => mq(corner(p)));
      if (shape.t === 'line') {
        out.push({ d: path(pts, false), fill: 'none', stroke: shape.fill ?? color, strokeWidth: Math.max(1, s * shape.width), opacity: shape.opacity ?? 1 });
      } else {
        out.push({ d: path(pts, true), fill: shape.fill ?? color, opacity: shape.opacity ?? 0.95, stroke: 'rgba(0,0,0,0.55)', strokeWidth: Math.max(0.5, s * 0.008) });
      }
    }
  }
  return out;
}
