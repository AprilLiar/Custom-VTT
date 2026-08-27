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
