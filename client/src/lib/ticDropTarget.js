// **Declaring a move by dropping it on the HEADER's Tic Counter (decided, new).**
//
// The global header strip mounts the very same `TicCounterCentral` the Arena
// does, but its `onDrop` was a deliberate no-op: there is no move source on a
// Compendium or character-sheet page to drag from, so there was nothing to
// drop. That stopped being true the moment the header learned to hide behind
// the Arena's own counter (below) — the reason you now see the header on the
// Arena at all is that you have scrolled *past* that counter, down to the
// declare picker, and the header is the only Tic Counter left on screen.
//
// **Why a module-level registry rather than props.** The Arena page and the
// header strip are siblings — the header is mounted once in `App.jsx`'s Shell,
// the Arena is a route inside it — so there is no parent to thread a handler
// through. This codebase already solves that sibling problem this way twice:
// `dragMoveState.js` for the drag payload, and `attackTelegraph.js`'s anchor
// registry for the Tell↔Tic connector. Same shape, same reasons.
//
// **The alternative was a second copy of `declareMoveAt`, and that is the thing
// to avoid.** Declaring is not one `socket.emit`: it is a Stamina pre-check
// against pending declarations, the ambiguous Left/Right popup, the drop ghost,
// and the Uneven Combat aim — all of it Arena-local state. A header that
// re-derived any of that would be a second implementation of the declare rules,
// which is how two of them quietly stop agreeing.
//
// Nothing is registered while the Arena is unmounted, so `getTicDeclare()`
// answers null and the header's counter falls back to exactly the inert
// behaviour it has always had on every other page.

let declare = null; // (absoluteTic, payload, clientX, clientY) => void
const declareListeners = new Set();

// Called by the Arena on mount; returns its own unregister, so an effect can
// just return it. Guarded on identity because React can mount the next
// instance before unmounting the previous one — a blind clear on unmount would
// drop the live handler.
export function registerTicDeclare(fn) {
  declare = fn;
  for (const listener of declareListeners) listener(declare);
  return () => {
    if (declare !== fn) return;
    declare = null;
    for (const listener of declareListeners) listener(null);
  };
}

export function getTicDeclare() {
  return declare;
}

export function onTicDeclareChange(callback) {
  declareListeners.add(callback);
  return () => declareListeners.delete(callback);
}

// ---------------------------------------------------------------------------
// Is the Arena's OWN Tic Counter currently on screen?
// ---------------------------------------------------------------------------
//
// **Two Tic Counters showing the same numbers is one too many (decided, new).**
// On the Arena the header's copy sat directly above the page's own centrepiece,
// which is the counter you are meant to be looking at — the duplicate cost a
// row of vertical space and said nothing new. It now hides while that counter
// is on screen and comes back the moment you scroll past it, which is also
// exactly when it becomes useful: the declare picker is below the fold, and the
// header is the Tic strip you can still reach.
//
// **Published by the Arena rather than observed by the header**, because only
// the Arena knows which element its counter is: it is behind a conditional (a
// resolving pair shows a banner instead) and inside a subtree the header cannot
// see. The Arena runs one `IntersectionObserver` on it and says yes or no.
//
// Defaults to **false — "not on screen"** — which is the safe answer: every page
// that is not the Arena has no such counter, and the header must show there.

let arenaCounterVisible = false;
const visibilityListeners = new Set();

export function setArenaCounterVisible(visible) {
  const next = Boolean(visible);
  if (next === arenaCounterVisible) return;
  arenaCounterVisible = next;
  for (const listener of visibilityListeners) listener(arenaCounterVisible);
}

export function isArenaCounterVisible() {
  return arenaCounterVisible;
}

export function onArenaCounterVisibility(callback) {
  visibilityListeners.add(callback);
  return () => visibilityListeners.delete(callback);
}
