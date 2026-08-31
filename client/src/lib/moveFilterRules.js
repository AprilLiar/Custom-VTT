import { ROLL_SLOT_LABELS, ROLL_SLOT_NAMES } from './diceSlots.js';

// **What counts as a match — the move filter's pure half.**
//
// Split out of `moveFilters.jsx` for one reason: `node --test` cannot load a
// `.jsx`, and this is the half worth pinning. The hook and the chip components
// next door need a renderer; these five functions are the rule everything else
// only draws, so they live where a test can reach them (the same split every
// other `client/src/lib/*.js` under test already has).
//
// The rules, unchanged from the sheet's own original version:
//   - picks *within* one filter are OR'd — "a Jab or a Hook"
//   - the filters are AND'd with each other — "...and Fast"
//   - an empty filter is not applied at all
//
// Both sides of an ambiguous move's Left/Right Tell pair count, because a move
// that can open with either is findable by either.
export const moveTellIds = (move) =>
  [move.tell_id, move.left_tell_id, move.right_tell_id].filter((id) => id != null);

// `effective_tag_ids` first: a Perk may add or strip a Tag for one character,
// and the filter has to match what that fighter's card actually shows.
export const moveTagIds = (move) => move.effective_tag_ids ?? move.tag_ids ?? [];

// **What a move HITS and what it ROLLS** — the two questions the Tell/Tag pair
// could not answer. "Which of these goes for the head" and "which of these
// rolls a Hand" are exactly what you ask a long list mid-round, and neither was
// askable before.
//
// Both read the same seven-slot vocabulary (`ROLL_SLOT_NAMES`): Left/Right Hand
// collapse into one ambiguous `Hand`, Left/Right Leg into `Leg`, and `Weapon` is
// the seventh. A move that rolls `Hand` twice — a Straight Block guards with
// both — is still one `Hand` to a filter, which is why these are membership
// tests rather than counts.
//
// `effective_*` first for the same reason `moveTagIds` does it: a Perk can move
// what a move does for one character, and a filter has to match what that
// fighter's card actually shows. Neither is on the sheet payload today; reading
// for it costs nothing and means the filter does not quietly go stale the day a
// seam starts writing one.
export const moveAttackTargets = (move) =>
  move.effective_attack_targets ?? move.attack_targets ?? [];

export const moveRollSlots = (move) => move.effective_roll_slots ?? move.roll_slots ?? [];

// The chips for a slot filter, in the vocabulary's own canonical order and
// limited to what is actually in the pile — the same rule the Tell and Tag rows
// follow. A filter that can only ever return nothing is a worse answer than no
// filter at all.
export const slotItems = (present) =>
  ROLL_SLOT_NAMES.filter((name) => present.has(name)).map((name) => ({
    id: name,
    name: ROLL_SLOT_LABELS[name] ?? name,
  }));
