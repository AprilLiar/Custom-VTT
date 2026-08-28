// Character Creation — the rules a guided build has to obey.
//
// Pure, and kept that way on purpose: this is the module that decides whether a
// build is legal, and **the budget has to be enforced here rather than in the
// wizard**. A points counter that only lives in the UI is a suggestion, not a
// rule — anything that can open a socket can spend 200 points. The dialog and
// the server both read this file, so what the player is shown and what the
// server accepts cannot drift.
//
// See `character:apply_creation` in server/index.js for the side effects, and
// vttprojectplan.md's Character Creation section for the design.

import { DICE_TEMPLATE, rankOf } from './gameLogic.js';

// The three starting points. Everything a preset decides is here: how many
// points there are to raise Stats with, and how many Perks and Moves the
// character begins play with.
//
// The order is the arc — a Teenager is quick and unformed, an Old Master is
// everything a lifetime buys — and the numbers are the table's, not derived
// from anything, so they live as data rather than as a formula.
//
// **Perks and Moves are hard caps; Stat points are still guidance (decided,
// revised).** The flow used to treat every one of these numbers as a
// suggestion — said plainly and then allowed — on the reasoning that guiding a
// build is not policing one. The table has since asked for the two *counts* to
// be limits, and reducing a budget nobody enforces would have changed nothing.
// Stat points are untouched by that call and still only warn: a spread is a
// shape, and the table has never wanted a shape refused.
export const PRESETS = [
  {
    key: 'teenager',
    name: 'Teenager',
    statPoints: 8,
    perkCount: 2,
    moveCount: 4,
    blurb: 'Young, fast, and mostly potential. Few Stats worth writing home about, and fewer tricks.',
  },
  {
    key: 'adult',
    name: 'Adult',
    statPoints: 16,
    perkCount: 3,
    moveCount: 8,
    blurb: 'A fighter in their prime — trained, experienced, and still in one piece.',
  },
  {
    key: 'old_master',
    name: 'Old Master',
    statPoints: 24,
    perkCount: 5,
    moveCount: 16,
    blurb: 'Decades of it. Deep Stats and a long list of things nobody else knows how to do.',
  },
];

export const presetByKey = (key) => PRESETS.find((p) => p.key === key) ?? null;

// Every Stat a character has, in sheet order. Creation touches all eight —
// there is no "combat Stats only" subset, and Brain and Stamina are bought
// exactly like the rest.
export const CREATION_SLOTS = DICE_TEMPLATE.map((d) => d.slot_name);

// **Every Stat starts at d4, and one point is one step.** A step is the same
// unit the whole game already counts in — `rankOf`/`dieAtRank` in gameLogic.js,
// the unit an Injury's penalty is expressed in, the unit damage moves a die by.
// So a Stat's cost IS its rank: d4 costs 0, d6 costs 1, d12 costs 4, d12+1
// costs 5, and there is no separate price list to keep in step with the ladder.
export const BASE_RANK = 0;

// What a whole spread costs. `ranks` is `{ [slotName]: rank }`; anything absent
// is a bare d4 and free.
export function statPointsSpent(ranks) {
  return CREATION_SLOTS.reduce((sum, slot) => sum + Math.max(0, Math.trunc(Number(ranks?.[slot]) || 0)), 0);
}

// The rank a die currently sits at, for showing a part-built character their
// existing spread rather than starting them over.
export const rankOfDie = (die) => (die?.status === 'incapacitated' ? 0 : rankOf(die?.current_size ?? 4, die?.bonus ?? 0));

// Validate and normalize a whole draft.
//
// **Errors block; warnings do not.** What is which changed once, on the table's
// call, and the split now runs:
//
//   - *error* — the Perk count and the Move count over their preset's cap, a
//     Move whose Style the character will not have, and anything that would
//     leave the character structurally broken (a half-built stance, or two of
//     the same Style, which is not a stance at all).
//   - *warning* — Stat points over the preset's budget, said plainly in the
//     wizard and in the chat line the build posts, and then allowed.
//
// Every blocking case has a Skip or an obvious undo next to it in the wizard;
// nobody is trapped by one.
//
// **Every step is optional, including the preset.** No preset means no caps at
// all: a free-form build, with nothing to exceed.
//
// Normalizes rather than rejecting where it safely can, the same way every
// other write path here does (see writeMove): unknown ids are dropped and
// out-of-range numbers are clamped.
//
// `moveStyles` (`{ [moveId]: styleAttributeId | null }`) and `ownedStyleIds`
// are both optional and only used together: a caller that cannot say which
// Styles the character will end up with gets no Style check, rather than a
// guess. The server passes the character's EXISTING stances plus the one this
// draft creates, because that union is exactly what `move:grant` will test
// against afterwards — a narrower answer here would refuse a build the grant
// would have accepted.
export function validateCreation({
  presetKey,
  statRanks = {},
  stance = null,
  moveIds = [],
  perkIds = [],
  roleplay = {},
  validMoveIds = null,
  validPerkIds = null,
  validAttributeIds = null,
  moveStyles = null,
  ownedStyleIds = null,
  moveNames = null,
} = {}) {
  const errors = [];
  const warnings = [];
  // Skipping the preset is allowed and means "no budget" — see the note above.
  const preset = presetByKey(presetKey);

  // ---- Stats ----
  const ranks = {};
  for (const slot of CREATION_SLOTS) {
    const raw = Math.trunc(Number(statRanks?.[slot]) || 0);
    // A negative rank is not a thing you can buy — d4 is the floor, and a
    // character cannot start play with an incapacitated Stat.
    ranks[slot] = Math.max(BASE_RANK, raw);
  }
  const spent = statPointsSpent(ranks);
  if (preset && spent > preset.statPoints) {
    warnings.push(`${preset.name} suggests ${preset.statPoints} Stat points; this spread spends ${spent}.`);
  }

  // ---- Stance ----
  // One stance, two DIFFERENT styles — the same pair rule stance:create
  // enforces. Optional at this stage: a character with no stance yet is
  // incomplete, not illegal, and the Stances tab can finish the job.
  let normalizedStance = null;
  if (stance && (stance.name || stance.attributeAId != null || stance.attributeBId != null)) {
    const name = String(stance.name ?? '').trim();
    const a = Number(stance.attributeAId);
    const b = Number(stance.attributeBId);
    if (!name) errors.push('Your stance needs a name.');
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      errors.push('Pick two Styles for your stance.');
    } else if (a === b) {
      errors.push('A stance is two different Styles.');
    } else if (validAttributeIds && !(validAttributeIds.includes(a) && validAttributeIds.includes(b))) {
      errors.push('That stance uses a Style that does not exist.');
    } else if (name) {
      normalizedStance = { name, attributeAId: a, attributeBId: b };
    }
  }

  // ---- Moves ----
  // Deduped, and filtered to moves that exist when the caller knows which
  // those are. Picking the same Move twice is one Move against the cap, not
  // two — the dedupe happens before the count for exactly that reason.
  const moves = dedupeIds(moveIds).filter((id) => !validMoveIds || validMoveIds.includes(id));
  if (preset && moves.length > preset.moveCount) {
    errors.push(`${preset.name} allows ${preset.moveCount} Moves; this picks ${moves.length}.`);
  }

  // **A Style you do not have is not a Move you can learn.** The same rule
  // `move:grant` enforces, checked here so the wizard can refuse it up front
  // rather than the server accepting the build and silently dropping the Move —
  // which is what used to happen, and which looked exactly like it had worked.
  if (moveStyles && ownedStyleIds) {
    const owned = new Set(ownedStyleIds.map(Number).filter(Number.isInteger));
    const blocked = moves.filter((id) => {
      const styleId = moveStyles[id] ?? moveStyles[String(id)] ?? null;
      return styleId != null && !owned.has(Number(styleId));
    });
    if (blocked.length) {
      const named = blocked.map((id) => moveNames?.[id] ?? moveNames?.[String(id)] ?? `#${id}`);
      errors.push(
        `Your stance does not carry the Style for ${named.join(', ')} — drop ${blocked.length === 1 ? 'it' : 'them'} or pick that Style.`
      );
    }
  }

  // ---- Perks ----
  const perks = dedupeIds(perkIds).filter((id) => !validPerkIds || validPerkIds.includes(id));
  if (preset && perks.length > preset.perkCount) {
    errors.push(`${preset.name} allows ${preset.perkCount} Perks; this picks ${perks.length}.`);
  }

  // ---- Role-play ----
  // Explicitly optional, per the flow. Empty answers are dropped rather than
  // written as blanks, so skipping the step leaves no trace.
  const answers = Object.entries(roleplay ?? {})
    .map(([question, answer]) => [String(question ?? '').trim(), String(answer ?? '').trim()])
    .filter(([question, answer]) => question && answer)
    .map(([question, answer]) => ({ question, answer }));

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized: {
      preset,
      ranks,
      pointsSpent: spent,
      // Null rather than a number when there is no preset: "how many are left"
      // is not a question a free-form build has an answer to, and 0 would read
      // as "you are out".
      pointsLeft: preset ? preset.statPoints - spent : null,
      stance: normalizedStance,
      moveIds: moves,
      movesLeft: preset ? preset.moveCount - moves.length : null,
      perkIds: perks,
      perksLeft: preset ? preset.perkCount - perks.length : null,
      roleplay: answers,
    },
  };
}

function dedupeIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(Number).filter(Number.isInteger))];
}
