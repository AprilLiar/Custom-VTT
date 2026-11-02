// Dragging a fighter from a palette (the GM's Fighters drawer, a Player's
// dock) onto the Combat map.
//
// The palette and the map are siblings deep in different parts of the Scene
// page, so instead of threading callbacks through ScenePage they meet here: a
// palette calls `beginFighterDrag` on pointerdown, and the map subscribes to
// see where the pointer is and to receive the drop. Pointer movement is
// tracked on `window`, so the drag survives leaving the drawer it started in.
//
// A drag only "starts" after the pointer moves a few pixels, so a plain click
// on a palette entry is still just a click.

const listeners = new Set();
let current = null; // { fighter, x, y, started }

const DRAG_THRESHOLD = 5;

export function subscribeFighterDrag(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const publish = (event) => {
  for (const fn of listeners) fn(event);
};

// `fighter`: { ownerType, ownerId, name, image_url, crop }.
export function beginFighterDrag(fighter, pointerEvent) {
  if (pointerEvent.button !== 0) return;
  pointerEvent.preventDefault();
  const startX = pointerEvent.clientX;
  const startY = pointerEvent.clientY;
  current = { fighter, x: startX, y: startY, started: false };

  const onMove = (e) => {
    if (!current) return;
    current = { ...current, x: e.clientX, y: e.clientY };
    if (!current.started && Math.hypot(e.clientX - startX, e.clientY - startY) > DRAG_THRESHOLD) {
      current.started = true;
    }
    if (current.started) publish({ type: 'move', ...current });
  };
  const finish = (e, cancelled) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    const was = current;
    current = null;
    if (!was?.started) return;
    publish({ type: cancelled ? 'cancel' : 'drop', fighter: was.fighter, x: e.clientX, y: e.clientY });
  };
  const onUp = (e) => finish(e, false);
  const onCancel = (e) => finish(e, true);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
