// **What one Move Point actually buys (decided, new).**
//
// A preset's Move count used to be a count of `moves` rows, and the table found
// two places where that is the wrong unit — both of them cases where several
// rows are obviously one thing a fighter learns:
//
//   1. **Variants.** `Cross - Head` and `Cross - Body` are one punch aimed two
//      ways. You do not learn the cross twice.
//   2. **A grapple and its first follow-up.** A grab that goes nowhere is not a
//      move, so the grappler and one extension come together. *Further*
//      extensions are real additions and cost their own point.
//
// So the unit is a **bundle**, not a row: one checkbox, one point, every row
// inside it learned together. Pure and shared by the wizard and the server for
// the reason characterCreation.js gives — a budget only the UI counts is a
// suggestion, not a rule.
//
// **Hard-coded on purpose.** These are naming and authoring conventions the
// table keeps, not data any Move Creator field expresses, and the ask was for
// exactly these exceptions rather than for a general "bundle" editor. A field
// would make every GM answer a question they have never needed to.

// The separator a variant name hangs off: `Cross - Head`. Spaces on both sides
// are required, so a hyphenated name (`Push-Kick`, `Off-Balance Sweep`) is one
// move and not a family — which is the whole reason the convention is written
// with spaces at the table.
const VARIANT_SEPARATOR = ' - ';

// `Cross - Head` -> `Cross`; `Jab` -> `Jab`. Trimmed and lower-cased for the
// key so `Cross - Head` and `cross  -  Body` land in the same family; the
// display name keeps the GM's own capitalisation of whichever came first.
export function variantBase(name) {
  const text = String(name ?? '').trim();
  const at = text.indexOf(VARIANT_SEPARATOR);
  return at === -1 ? text : text.slice(0, at).trim();
}

const variantKey = (name) => variantBase(name).toLowerCase();

// Every move id a grapple eventually leads to, in a stable order and **never
// including the grappler itself**.
//
// **Recursion is the reason this is a graph walk and not a list read.** A
// grapple may name itself as one of its own directions — that is the "chain the
// same move over and over" authoring the table asked for — and a chain of
// grapples can loop back to any earlier link. Learning a move once is enough,
// so `seen` is the whole answer: a move already reachable is not a second
// extension to pay for, and the walk terminates on any shape of cycle.
export function grappleExtensionIds(rootId, movesById) {
  const root = movesById.get(rootId);
  if (!root) return [];
  const seen = new Set([rootId]);
  const out = [];
  const queue = [root];
  while (queue.length) {
    const move = queue.shift();
    for (const direction of move.grapple_directions ?? []) {
      const targetId = direction?.target_move_id;
      if (targetId == null || seen.has(targetId)) continue;
      seen.add(targetId);
      const target = movesById.get(targetId);
      if (!target) continue;
      out.push(targetId);
      // A follow-up that is itself a grapple opens its own directions, and
      // those are extensions of this same chain — one grab that keeps going.
      if (target.is_grappling) queue.push(target);
    }
  }
  return out;
}

// The library, grouped into what a point buys.
//
// Returns one bundle per variant family, in the order the moves arrived (the
// GM's own `sort_order`), each carrying:
//
//   key            stable identity, used by the selection and the checkbox
//   name           the base name, for the label
//   moveIds        every row the one checkbox takes
//   isGrappleRoot  whether ticking it opens a grapple's extensions
//   extensionKeys  the bundles this grapple leads to, deduped, in walk order
//
// **Grapple families are expressed between bundles rather than inside one**,
// because the two rules have to compose: `Arm Bar - Left` and `Arm Bar - Right`
// are one extension, not two, and the only way that stays true is if the grapple
// walk speaks in bundles. It also keeps the pricing rule sayable in one line —
// see `moveSelectionCost`.
export function bundleMoves(moves = []) {
  const list = Array.isArray(moves) ? moves : [];
  const movesById = new Map(list.map((m) => [m.id, m]));
  const byKey = new Map();
  for (const move of list) {
    const key = variantKey(move.name);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        name: variantBase(move.name),
        moveIds: [],
        isGrappleRoot: false,
        extensionKeys: [],
      });
    }
    byKey.get(key).moveIds.push(move.id);
  }

  const keyOfMove = new Map();
  for (const bundle of byKey.values()) {
    for (const id of bundle.moveIds) keyOfMove.set(id, bundle.key);
  }

  for (const bundle of byKey.values()) {
    // A family is a grapple if ANY of its variants is — `Headlock - Standing`
    // being a grapple makes the family one, which is what a table means by it.
    const roots = bundle.moveIds.filter((id) => movesById.get(id)?.is_grappling);
    if (!roots.length) continue;
    bundle.isGrappleRoot = true;
    const seen = new Set([bundle.key]);
    for (const rootId of roots) {
      for (const extensionId of grappleExtensionIds(rootId, movesById)) {
        const key = keyOfMove.get(extensionId);
        // Deduped by BUNDLE, so two variants of one follow-up are one
        // extension — and a follow-up inside the grapple's own family (a
        // `Headlock - Standing` leading to `Headlock - Ground`) is not an
        // extension of itself.
        if (key == null || seen.has(key)) continue;
        seen.add(key);
        bundle.extensionKeys.push(key);
      }
    }
  }

  return [...byKey.values()];
}

// What a selection costs, in Move Points.
//
// **One point per selected bundle, minus one free extension per selected
// grapple.** That is the whole rule, and it is the two asks said once:
// variants come free with each other because they are one bundle, and "the
// initial Grappling move and 1 extension cost 1 Move Point" because the grapple
// pays for its first selected extension.
//
// **The player chooses WHICH extension is free** — it is whichever they took —
// rather than the engine picking one for them. "One extension comes with the
// grab" says nothing about which, and a fixed choice would quietly make some
// grapples better than others.
//
// Two guards, and **both of them are the "be careful of recursive moves"
// warning cashed out**:
//
//   - A bundle already freed by one grapple cannot be freed again by a second
//     that also leads to it. It is only being counted once, so discounting it
//     twice would price a two-grapple build below what it holds.
//   - **A grapple only pays for a follow-up if you are paying for the
//     grapple.** A follow-up you got free cannot turn around and free the move
//     that gave it to you. Without this, two grapples naming each other — which
//     is exactly the shape the chain-the-same-move authoring produces — hand
//     each other a discount, and a three-move mutual chain collapses to one
//     point.
//
// Roots are considered in bundle order, which is the GM's own `sort_order`, so
// the answer is stable rather than depending on which grapple happened to be
// looked at first.
export function moveSelectionCost(selectedMoveIds = [], bundles = []) {
  const selected = new Set(selectedMoveIds ?? []);
  const chosen = new Set();
  for (const bundle of bundles) {
    if (bundle.moveIds.some((id) => selected.has(id))) chosen.add(bundle.key);
  }
  const freed = new Set();
  for (const bundle of bundles) {
    if (!bundle.isGrappleRoot || !chosen.has(bundle.key)) continue;
    // Already somebody else's free follow-up — it is not being paid for, so it
    // has nothing to give away.
    if (freed.has(bundle.key)) continue;
    const free = bundle.extensionKeys.find((key) => chosen.has(key) && !freed.has(key));
    if (free != null) freed.add(free);
  }
  return { points: chosen.size - freed.size, bundleKeys: [...chosen], freedKeys: [...freed] };
}

// Ticking a bundle takes every row in it — that is what "one checkbox" means.
// Returned as a plain list so a caller can union it into a selection without
// knowing anything about bundles.
export function moveIdsForBundles(bundleKeys = [], bundles = []) {
  const wanted = new Set(bundleKeys ?? []);
  const out = [];
  for (const bundle of bundles) {
    if (wanted.has(bundle.key)) out.push(...bundle.moveIds);
  }
  return out;
}
