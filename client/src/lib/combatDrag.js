// Dragging something from a palette onto the Combat map or a Simple Combat
// lane: a fighter (the GM's Fighters drawer, a Player's dock) or a map tile
// (the Map Tiles palette).
//
// The palette and the map are siblings deep in different parts of the Scene
// page, so instead of threading callbacks through ScenePage they meet here: a
// palette calls `begin…Drag` on pointerdown, and the map subscribes to see
// where the pointer is and to receive the drop. Pointer movement is tracked on
// `window`, so the drag survives leaving the drawer it started in.
//
// A drag only "starts" after the pointer moves a few pixels, so a plain click
// on a palette entry is still just a click.

const DRAG_THRESHOLD = 5;

// One independent channel. Events: { type: 'move' | 'drop' | 'cancel', item, x, y }.
function createDragBus() {
  const listeners = new Set();
  let current = null; // { item, x, y, started }
  const publish = (event) => {
    for (const fn of listeners) fn(event);
  };
  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const begin = (item, pointerEvent) => {
    if (pointerEvent.button !== 0) return;
    pointerEvent.preventDefault();
    const startX = pointerEvent.clientX;
    const startY = pointerEvent.clientY;
    current = { item, x: startX, y: startY, started: false };

    const onMove = (e) => {
      if (!current) return;
      current = { ...current, x: e.clientX, y: e.clientY };
      if (!current.started && Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_THRESHOLD) {
        current.started = true;
      }
      if (current.started) publish({ type: 'move', item: current.item, x: current.x, y: current.y });
    };
    const finish = (e, cancelled) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      const was = current;
      current = null;
      if (!was?.started) return;
      publish({ type: cancelled ? 'cancel' : 'drop', item: was.item, x: e.clientX, y: e.clientY });
    };
    const onUp = (e) => finish(e, false);
    const onCancel = (e) => finish(e, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };
  return { subscribe, begin };
}

const fighters = createDragBus();
const tiles = createDragBus();

// Fighters. `fighter`: { ownerType, ownerId, name, image_url, crop }. Events
// carry it as `fighter`, as they always have.
export const beginFighterDrag = (fighter, pointerEvent) => fighters.begin(fighter, pointerEvent);
export const subscribeFighterDrag = (fn) => fighters.subscribe((ev) => fn({ ...ev, fighter: ev.item }));

// Map tiles. `tile`: { kind } (a key of client/src/lib/mapTiles.js's TILES).
export const beginTileDrag = (tile, pointerEvent) => tiles.begin(tile, pointerEvent);
export const subscribeTileDrag = tiles.subscribe;
