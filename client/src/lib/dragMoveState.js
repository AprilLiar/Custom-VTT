// The declare-a-move drag source (CombatArena's move picker) and the drop
// target (CombatHeaderBar's Tic squares, mounted globally so it's reachable
// from any page) are siblings, not parent/child — plain HTML5 drag events
// can carry the payload to the eventual `drop`, but `dataTransfer.getData`
// is deliberately unreadable during `dragover`, so it can't drive a live
// resize preview on its own. This tiny module is the one piece of shared
// state that lets the header show that preview while a card is dragging.
let current = null;
const listeners = new Set();

export function setDraggingMove(move) {
  current = move;
  for (const listener of listeners) listener(current);
}

export function getDraggingMove() {
  return current;
}

export function onDraggingMoveChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
