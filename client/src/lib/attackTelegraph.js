// Attack telegraph (decided, new) — "this Tic is where something that can
// hit you begins."
//
// A declared move's Tell has always been public, but *when* it starts was
// not shown to anyone but its owner, so an opponent could see that a punch
// was coming and had no way to time a guard against it. The Tic Counter now
// paints a faint grey glow on the first Startup Tic of every declared
// **attack** that hasn't gone public yet, for everyone, and the Arena draws
// a connector line between that glow and the move's own Tell card so the
// two read as one fact rather than two unrelated markers.
//
// **`placementTic` was already on the wire** for every viewer regardless of
// entitlement (see mapDeclaredMovesForViewer in server/index.js — Tic
// geometry is structure, not identity); it was simply never drawn for
// anyone but the move's own owner. The one genuinely new field is
// `telegraphsAttack`, the server's own answer to "can this move hit you"
// (`isTelegraphedAttack` in moveLogic.js) — deliberately a single derived
// boolean rather than the raw is_defensive/attack_targets it comes from, so
// the payload discloses exactly what the glow itself discloses.
//
// Two consequences worth naming, both intended rather than accidental:
//   - A prepared opponent can pair the visible Tell with the start Tic and
//     look the move's real frame data up in the Compendium (Players browse
//     it read-only). That *is* the mechanic — reading a Tell is how you
//     counter, and this is what makes reading it actionable.
//   - The absence of a glow is itself information: it says the declared
//     move is a pure guard. Also intended — seeing an opponent turtle is
//     fair play, same as seeing them wind up.

// Which declared attacks begin on each absolute Tic of one pair's current
// round window, as `Map<absoluteTic, [{ declaredMoveId, characterId, characterName }]>`.
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
    if (!dm.telegraphsAttack) continue;
    if (dm.placementTic < roundStartTic || dm.placementTic >= windowEnd) continue;
    const at = marks.get(dm.placementTic) ?? [];
    at.push({
      declaredMoveId: dm.id,
      characterId: dm.characterId,
      characterName: nameOf?.(dm.characterId) ?? null,
    });
    marks.set(dm.placementTic, at);
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
