// Where the seven style nodes and their labels sit on the counter wheel.
//
// Pure, and split out of `StanceGraph.jsx` for the same reason the board's
// camera is split out of its component: this is arithmetic whose failure mode
// is two things overlapping, which is invisible in code and obvious on screen —
// and which a test can state exactly.
//
// **The bug this file exists to fix.** Every label used to sit on its node's own
// ray at a fixed radius, `RADIUS + 44`. That works for a label above or below
// the wheel, where the text grows sideways into empty space. It fails for the
// two nodes nearest the horizontal, where the text grows back along the ray
// straight into the node: "Improvisation" is thirteen characters, so its left
// edge reached about forty pixels back toward the wheel and landed on top of
// the shuffle icon. "Defensive" did the same on the other side. Reported from
// play as the labels overlapping the style icons.
//
// The fix is to push each label out by the part of its own half-width that
// actually points at the node — `|cos θ| · halfWidth`. A label at the top or
// bottom has `cos θ ≈ 0` and does not move at all; one out to the side is
// pushed out by nearly its whole half-width, which is exactly the amount that
// was overlapping.

export const SIZE = 460;
export const CENTER = SIZE / 2;
export const RADIUS = 150;
export const NODE_R = 22;

// Clear air between the node's edge and the nearest edge of its label.
export const LABEL_GAP = 22;

export const LABEL_FONT_SIZE = 12;
// Average advance per character at LABEL_FONT_SIZE in the UI's sans stack.
// An estimate, deliberately: measuring needs a laid-out DOM, this module is
// pure, and the number only has to be big enough to clear the node — being a
// little generous costs a few pixels of margin and nothing else. Checked
// against the real rendered widths in the browser.
export const CHAR_WIDTH = 6.9;

export const labelWidth = (name) => String(name ?? '').length * CHAR_WIDTH;

// The angle of the i-th of n nodes: the first sits at the top and the rest run
// clockwise from there.
export const angleAt = (i, n) => ((-90 + (i * 360) / n) * Math.PI) / 180;

export function polar(i, n, radius) {
  const angle = angleAt(i, n);
  return { x: CENTER + radius * Math.cos(angle), y: CENTER + radius * Math.sin(angle) };
}

export const nodePosition = (i, n) => polar(i, n, RADIUS);

// The label's centre. Radial like the node, but pushed out by however much of
// its own width points back at the wheel.
export function labelPosition(i, n, name) {
  const angle = angleAt(i, n);
  const radius = RADIUS + NODE_R + LABEL_GAP + Math.abs(Math.cos(angle)) * (labelWidth(name) / 2);
  return { x: CENTER + radius * Math.cos(angle), y: CENTER + radius * Math.sin(angle) };
}

// **The viewBox has to grow with the labels, or the fix just moves the problem.**
// Pushing "Improvisation" clear of its icon pushes it off the right edge
// instead, where an outermost `<svg>` clips it away without a word. So the box
// is measured from what is actually being drawn — the wheel plus every label's
// own bounding box — rather than being a constant that happens to fit the seven
// styles the app ships with today.
const PAD = 6;

export function graphViewBox(attributes) {
  // The wheel itself is always inside, so start from the square and grow.
  let minX = 0;
  let minY = 0;
  let maxX = SIZE;
  let maxY = SIZE;
  const n = attributes?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const name = attributes[i]?.name ?? '';
    const p = labelPosition(i, n, name);
    const half = labelWidth(name) / 2;
    minX = Math.min(minX, p.x - half - PAD);
    maxX = Math.max(maxX, p.x + half + PAD);
    minY = Math.min(minY, p.y - LABEL_FONT_SIZE);
    maxY = Math.max(maxY, p.y + LABEL_FONT_SIZE);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export const viewBoxString = (attributes) => {
  const b = graphViewBox(attributes);
  return `${b.x} ${b.y} ${b.width} ${b.height}`;
};

// Does a label's box touch its own node's circle? What the overlap bug was, and
// the one thing worth asserting about this layout.
export function labelClearsNode(i, n, name) {
  const node = nodePosition(i, n);
  const label = labelPosition(i, n, name);
  const half = labelWidth(name) / 2;
  // Nearest point of the label's box to the node's centre.
  const dx = Math.max(0, Math.abs(label.x - node.x) - half);
  const dy = Math.max(0, Math.abs(label.y - node.y) - LABEL_FONT_SIZE / 2);
  return Math.hypot(dx, dy) >= NODE_R;
}
