// The Relationships board's camera: pure maths for a pan/zoom viewport, kept
// out of the component so the coordinate conversions can be unit-tested. Every
// bug class this file exists to prevent is the same one — a point converted in
// one direction by one call site and the other direction by another, drifting
// apart under zoom — so there is exactly one implementation of each direction.
//
// **Two coordinate spaces.**
//   - *world* — where nodes actually live. Stored in the DB, never changes when
//     the camera moves. An unbounded plane; the origin is arbitrary.
//   - *screen* — pixels inside the viewport element, measured from its top-left.
//
// The camera is `{ x, y, zoom }`, applied to the world layer as
// `translate(x, y) scale(zoom)` with `transform-origin: 0 0`. That order and
// that origin are what make the conversions below the simple pair they are; a
// centred origin would put the viewport's half-size into every formula.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;

// Below this, text is too small to read and is hidden rather than left to blur
// things behind it for no benefit — see the halo note in the plan.
export const TEXT_VISIBLE_ZOOM = 0.4;

export const DEFAULT_VIEW = { x: 0, y: 0, zoom: 1 };

export const clampZoom = (zoom) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

// screen -> world. `screenX/screenY` are already relative to the viewport's
// top-left corner (subtract getBoundingClientRect() first).
export function toWorld(view, screenX, screenY) {
  return { x: (screenX - view.x) / view.zoom, y: (screenY - view.y) / view.zoom };
}

// world -> screen. The exact inverse of toWorld, and tested as such.
export function toScreen(view, worldX, worldY) {
  return { x: worldX * view.zoom + view.x, y: worldY * view.zoom + view.y };
}

// Zoom by `factor` about a fixed screen point — the point under the cursor stays
// under the cursor, which is the whole feel of wheel-zoom. Solving
// `screen = view.x + world * zoom` for the new view.x with `world` held constant
// gives the pullback below.
//
// Returns the SAME object when the zoom is already at its limit, so a caller can
// skip a state write on a no-op scroll.
export function zoomAt(view, factor, screenX, screenY) {
  const zoom = clampZoom(view.zoom * factor);
  if (zoom === view.zoom) return view;
  const k = zoom / view.zoom;
  return { x: screenX - (screenX - view.x) * k, y: screenY - (screenY - view.y) * k, zoom };
}

export const panBy = (view, dx, dy) => ({ x: view.x + dx, y: view.y + dy, zoom: view.zoom });

// Centre the camera on a world point, given the viewport's pixel size. Used to
// frame the board on first open and by "recentre".
export function centerOn(view, worldX, worldY, width, height) {
  return {
    zoom: view.zoom,
    x: width / 2 - worldX * view.zoom,
    y: height / 2 - worldY * view.zoom,
  };
}

// **Framing what is actually there.**
//
// A camera position is per-browser, so opening a board on a second device — or
// after somebody laid the map out far from the origin — lands you at the
// default view staring at empty space, with no clue that a whole web exists a
// few thousand units away. Found by opening the board at phone size: the void
// rendered perfectly and had nothing in it.
//
// `boundsOf` measures the cast; `fitTo` returns the camera that frames it.
// Zoom is clamped like any other, so a very spread-out board simply shows as
// much as MIN_ZOOM allows rather than refusing to frame at all.

export function boundsOf(nodes, nodeW = 112, nodeH = 112) {
  if (!nodes?.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + nodeW);
    maxY = Math.max(maxY, n.y + nodeH);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

export function fitTo(bounds, width, height, padding = 80) {
  if (!bounds || !(width > 0) || !(height > 0)) return DEFAULT_VIEW;
  const boxW = Math.max(1, bounds.maxX - bounds.minX);
  const boxH = Math.max(1, bounds.maxY - bounds.minY);
  // Never zoom IN to fill the screen with two portraits — a board with one
  // person on it should not open at 250%.
  const zoom = clampZoom(Math.min(1, Math.min((width - padding * 2) / boxW, (height - padding * 2) / boxH)));
  return centerOn({ x: 0, y: 0, zoom }, (bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, width, height);
}

// Can the player actually SEE somebody? What decides whether opening the board
// needs to re-frame at all — a saved camera that already shows the map is left
// exactly where the player left it.
//
// **Asked per node, not against the bounding box.** The first version tested
// the box for any overlap with the viewport at all, which counted a nineteen
// pixel sliver of one portrait's edge as "the map is visible" and left a phone
// staring at an empty void with the whole cast just off the right edge. Found
// by opening the board at phone size and then measuring where everything
// actually was. A node's CENTRE being on screen is the honest test: it means a
// face is there to be recognised, not a hairline of one.
export function anyNodeVisible(view, nodes, width, height, nodeW = 112, nodeH = 112) {
  if (!nodes?.length) return true;
  return nodes.some((n) => {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) return false;
    const p = toScreen(view, n.x + nodeW / 2, n.y + nodeH / 2);
    return p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height;
  });
}

// ---------------------------------------------------------------------------
// The void's dot field
// ---------------------------------------------------------------------------
//
// **A constant on-screen density, at every zoom.** The first version of the
// void scaled a fixed tile with the camera, which meant zooming out packed the
// dots tighter and tighter until the field was a grey mess — and two such grids
// at different scales beat into moiré on the way there.
//
// Instead the grid STEPS: its world spacing doubles whenever zooming out would
// push the dots closer than DOT_MIN_PX apart on screen, and halves whenever
// zooming in would spread them past DOT_MAX_PX. The field still pans 1:1 with
// the camera so it belongs to the world rather than to the screen; the stepping
// is invisible in motion, and is what every infinite canvas does.

const DOT_BASE = 64; // world units between dots at 100%
export const DOT_MIN_PX = 40;
export const DOT_MAX_PX = 88;

export function dotSpacing(zoom) {
  const spacing = DOT_BASE * zoom;
  // A zero, negative or non-finite zoom would loop forever below. It should be
  // unreachable — clampZoom guards every path that sets it — which is exactly
  // why it is worth one line here rather than a hung tab if it ever is not.
  if (!Number.isFinite(spacing) || spacing <= 0) return DOT_BASE;
  let stepped = spacing;
  while (stepped < DOT_MIN_PX) stepped *= 2;
  while (stepped > DOT_MAX_PX) stepped /= 2;
  return stepped;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
//
// **Deliberately localStorage, not the database.** Where a player happens to be
// looking is a property of the person looking, not of the game — the same rule
// SettingsPage.jsx already states for brand hue and cutscene speed. The board's
// contents are shared with the GM; the camera is not worth a column, a socket
// event or a round trip.
//
// Wrapped in try/catch on both sides: a private window can throw on access, and
// a camera position is never worth breaking a tab over.

const viewKey = (characterId) => `vtt.relationships.view.${characterId}`;

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export function loadView(characterId) {
  try {
    const raw = localStorage.getItem(viewKey(characterId));
    if (!raw) return DEFAULT_VIEW;
    const parsed = JSON.parse(raw);
    if (!finite(parsed?.x) || !finite(parsed?.y) || !finite(parsed?.zoom)) return DEFAULT_VIEW;
    return { x: parsed.x, y: parsed.y, zoom: clampZoom(parsed.zoom) };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(characterId, view) {
  try {
    localStorage.setItem(viewKey(characterId), JSON.stringify(view));
  } catch {
    /* private window, or storage full — the camera is not worth an error */
  }
}

// Whether retired relationships are drawn at all. A property of the person
// looking rather than of the board — the same rule the camera follows — so it
// lives here in localStorage and is never sent anywhere. On by default: history
// is the reason retiring exists, and a line vanishing the moment you retired it
// would read as a delete.
const retiredKey = (characterId) => `vtt.relationships.retired.${characterId}`;

export function loadShowRetired(characterId) {
  try {
    return localStorage.getItem(retiredKey(characterId)) !== '0';
  } catch {
    return true;
  }
}

export function saveShowRetired(characterId, show) {
  try {
    localStorage.setItem(retiredKey(characterId), show ? '1' : '0');
  } catch {
    /* private window, or storage full — a view preference is not worth an error */
  }
}
