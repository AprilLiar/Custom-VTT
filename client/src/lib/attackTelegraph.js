// Move telegraph (decided, widened) — "this Tic is where something begins."
//
// A declared move's Tell has always been public, but *when* it starts was not
// shown to anyone but its owner, so an opponent could see that something was
// coming and had no way to time against it. The Tic Counter paints a faint grey
// glow on the first Startup Tic of every declared move that hasn't gone public
// yet, for everyone, and the Arena draws a connector line between that glow and
// the move's own Tell card so the two read as one fact rather than two
// unrelated markers.
//
// **Every move, guards included (decided, revised).** This used to mark only
// moves that could hit you — a pure Block or Dodge glowed on nothing. The
// absence of a glow was therefore a perfectly reliable read: it said "they are
// turtling", handed over for free, and it made a guard the one move you could
// identify without reading anything. Every declared move now marks its
// placement Tic, so the glow says only "they have committed to something here",
// which is the fact this marker exists to publish.
//
// **`placementTic` was already on the wire** for every viewer regardless of
// entitlement (see mapDeclaredMovesForViewer in server/index.js — Tic geometry
// is structure, not identity); it was simply never drawn for anyone but the
// move's own owner. There is no accompanying "is this an attack" field any
// more: it existed to gate this glow, and the gate is gone.
//
// A Feint-masked move still glows on nothing, because its row is dropped from
// the payload outright rather than blanked — see the Feint note server-side.
//
// **The Feint itself can be marked, for one viewer only (Never a Fool).** The
// server puts `isFeint` on a row when that viewer's Perk earns it, and the
// square turns red — that it is a lie, and nothing else. The move it masks is
// still not on the wire at all, so the Perk never sees through to what came
// after the Feint.
//
// One consequence worth naming, intended rather than accidental: a prepared
// opponent can pair the visible Tell with the start Tic and look the move's
// real frame data up in the Compendium (Players browse it read-only). That *is*
// the mechanic — reading a Tell is how you counter, and this is what makes
// reading it actionable.

// Which declared moves **begin winding up** on each absolute Tic of one pair's
// current round window, as
// `Map<absoluteTic, [{ declaredMoveId, characterId, characterName }]>`.
//
// **Only the first Startup Tic is marked (decided, revised back).** It briefly
// marked the whole run `[placementTic, revealTic)` so that a 3-Tic wind-up and
// a 1-Tic one drew differently, and that is exactly the problem: the length of
// a wind-up is frame data, and frame data is what a Tell is supposed to make
// you guess at. Painting the run handed every opponent the move's Startup
// count for free. One square says "something is committed here" and stops
// there, which is the fact this glow exists to publish.
//
// **Identity, Startup length, Active and Recovery all stay secret.** The
// square anchors the Tell<->Tic connector, and hover/tap-to-pin work from it.
//
// Scoped to a single pair (a different fight's timing is none of this
// strip's business) and to the round window actually on screen, since a
// move placed before it has no square here to glow on. `publiclyRevealed`
// (not `isRevealed`) is the gate — see the server-side comment on why the
// viewer-relative flag would hide a fighter's own telegraph from them.
export function attackStartsByTic({
  declaredMoves,
  pairIndexByChar,
  pairIndex,
  roundStartTic,
  roundLength,
  nameOf,
}) {
  const marks = new Map();
  if (pairIndex == null || roundStartTic == null || !roundLength) return marks;
  const windowEnd = roundStartTic + roundLength;
  for (const dm of declaredMoves ?? []) {
    if (pairIndexByChar.get(dm.characterId) !== pairIndex) continue;
    if (dm.publiclyRevealed) continue;
    // A 0-Startup move has revealTic === placementTic and still marks its
    // placement square: it is committed there just the same, and the glow drops
    // the moment it goes public anyway.
    const tic = dm.placementTic;
    if (tic < roundStartTic || tic >= windowEnd) continue;
    const at = marks.get(tic) ?? [];
    at.push({
      declaredMoveId: dm.id,
      characterId: dm.characterId,
      characterName: nameOf?.(dm.characterId) ?? null,
      // **Never a Fool.** Present on this row only when the server decided this
      // viewer's Perk earns it (see mapDeclaredMovesForViewer) — absent, not
      // false, for everybody else — so the client never has to decide who may
      // know. It paints the square red and nothing more: which move it is, its
      // frames and its Roll all stay exactly as secret as they were.
      isFeint: Boolean(dm.isFeint),
    });
    marks.set(tic, at);
  }
  return marks;
}

// ---------- Tell <-> Tic connector ----------
//
// The Tell card (Declaration Lanes) and the glowing square (Tic Counter)
// are siblings in two different subtrees, and the line between them has to
// be drawn above both — so the anchors are registered into a module-level
// registry and one portalled overlay reads them, rather than threading refs
// up and back down through the Arena. Same shape and reasoning as
// dragMoveState.js, which solves the identical sibling problem for the
// declare drag.

const anchors = new Map(); // `${kind}:${declaredMoveId}` -> Element

// Returns its own unregister function, so an effect can just return it.
// Guarded on identity because React can mount the next element before
// unmounting the previous one — a blind delete would drop the live anchor.
export function registerLinkAnchor(kind, declaredMoveId, el) {
  const key = `${kind}:${declaredMoveId}`;
  anchors.set(key, el);
  return () => {
    if (anchors.get(key) === el) anchors.delete(key);
  };
}

export function getLinkAnchor(kind, declaredMoveId) {
  return anchors.get(`${kind}:${declaredMoveId}`) ?? null;
}

// `ids` are the declared-move ids currently linked. `pinned` distinguishes
// a tap (sticky until tapped again) from a hover (clears on mouse-out) —
// touch devices have no hover at all, so without the pinned mode the
// connector would simply not exist on a phone.
let link = { ids: [], pinned: false };
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener(link);
}

const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

export function setLinkHover(ids) {
  if (link.pinned) return; // a pinned selection outranks whatever the cursor is over
  if (sameIds(ids, link.ids)) return;
  link = { ids, pinned: false };
  emit();
}

// Tapping the same anchor again clears it; tapping a different one moves
// the pin rather than accumulating.
export function toggleLinkPin(ids) {
  link = link.pinned && sameIds(ids, link.ids) ? { ids: [], pinned: false } : { ids, pinned: true };
  emit();
}

export function clearLink() {
  if (!link.ids.length && !link.pinned) return;
  link = { ids: [], pinned: false };
  emit();
}

export function getLink() {
  return link;
}

export function onLinkChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}
