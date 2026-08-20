// The Perk registry — where a Perk stops being a picture and a paragraph and
// starts being a rule.
//
// ============================================================================
// READ THIS BEFORE ADDING A PERK
// ============================================================================
//
// **This is the second attempt, and the first one is why this one looks like
// this.** Perks originally had a generic, GM-authored effect system: five
// stored automation types (die_step / stamina_multiplier / move_tag /
// move_frame_override / move_roll_bonus) picked from a form and applied
// automatically on grant. It was removed entirely, tables and all, because a
// form can only ever express the *intersection* of every Perk anybody will
// ever want, and Perks are the one part of this game with no intersection.
// Do not put an effect editor back in the Move/Perk Creator.
//
// **A Perk does not get its own effect language. A Perk gets to participate
// in decisions the engine already makes.** Every seam below is a place the
// engine was already choosing something and already narrating the choice —
// a roll's modifier, a trigger firing, whether a viewer may see a move. A
// Perk can push on one of those. It cannot invent a new thing for the engine
// to do; that would be an engine change, made deliberately, not a Perk.
//
// ----------------------------------------------------------------------------
// Adding a Perk
// ----------------------------------------------------------------------------
//
//   1. Write `server/perks/<slug>.js` exporting one definition object.
//   2. Import it below and add it to the array.
//
// That is the whole checklist. No schema change, no engine edit, no risk to
// any Perk that already exists. `seedPerks` in db.js creates the compendium
// row from the definition at startup if the world does not already have one,
// so a GM never has to spell the name correctly for the mechanic to bind.
//
// ----------------------------------------------------------------------------
// The three tiers — declare only what the Perk actually needs
// ----------------------------------------------------------------------------
//
//   export default {
//     name: 'Second Wind',              // REQUIRED, and matched exactly (see below)
//     description: '…',                 // seeded into the compendium
//
//     // TIER 1 — declarative. Reuses the move-interaction vocabulary
//     // verbatim: ALL_TRIGGERS for the keys, AUTOMATION_TYPES for the
//     // effects, and the same executor, so the Chat Log line, the
//     // automation_fired event and the cutscene narration all come free.
//     triggers: {
//       defense_failure: {
//         once: 'round',                // optional: 'round' | 'fight'
//         automations: [{ type: 'self_stamina', amount: -2 }],
//       },
//     },
//
//     // TIER 2 — a narrow function on a named seam. The signature belongs to
//     // the seam, not to the Perk. See SEAMS below for the full list.
//     rollBonus: ({ character }) => (character.current_stamina * 4 <= character.max_stamina ? 2 : 0),
//
//     // TIER 3 — the escape hatch, for the genuinely non-standard.
//     onGrant: async ({ characterId, io, state }) => { … },
//     onRevoke: async ({ characterId, io }) => { … },
//   };
//
// ----------------------------------------------------------------------------
// Two rules that are not negotiable
// ----------------------------------------------------------------------------
//
// **Every seam is additive, or boolean-OR.** Two Perks contributing to the
// same seam sum, or OR. There is no priority field and no ordering, ever —
// that is exactly what lets a character carry ten Perks without anybody
// having to reason about ten. A Perk that genuinely needs to *replace* a rule
// rather than add to it does not get a seam: it goes in Tier 3, and says so
// in its own file.
//
// **A Perk that changes a number says so out loud.** Either it rides the
// roll's `modifierBreakdown` under its own name, or it emits an event the
// cutscene can narrate. A Perk that silently moves a total is the same defect
// as the unexplained "+5 Modifier" the breakdown was built to kill.
//
// ----------------------------------------------------------------------------
// Matched by NAME, exactly — and what protects that
// ----------------------------------------------------------------------------
//
// Same convention as TAG_HOOKS in tagAutomations.js, for the same reason: the
// GM owns the Perks list, ids differ between databases, and a Perk can be
// re-created at any time. Name matching is what keeps a mechanic attached to
// the thing the table thinks it is attached to.
//
// Three things stop that from being invisible: the definition is seeded at
// startup so the row always exists; `automated: true` rides every Perk
// payload so the card shows a ⚙ badge; and `perk:update` refuses to rename a
// Perk that has an entry here. Description, picture and Perk Tags stay freely
// editable — only the binding name is frozen.

// Every seam name the engine knows how to call. A definition declaring a key
// that is not in here has a typo, and server/test/perkRegistry.test.js fails
// on it — the single most likely silent failure of a name-keyed registry is a
// misspelled hook that quietly does nothing for a month.
export const SEAMS = [
  // (ctx) -> number. Summed into every roll that character makes, as its own
  // named term on the roll's modifierBreakdown. See combatBonuses.js.
  'rollBonus',
  // -> number. How many idle Tics this character needs per point of Stamina
  // regen. NOT additive — the lowest requirement among granted Perks wins,
  // since it is a rate rather than a contribution.
  'idleStaminaRegen',
  // (ctx) -> boolean. OR-ed. Whether this character may read a publicly
  // revealed move in full from the log (Genius Observer).
  'canSeeRevealedDetail',
];

// Tier-3 lifecycle keys — not seams (they are not folded across Perks, each
// runs on its own), but legal top-level keys on a definition.
export const LIFECYCLE_KEYS = ['onGrant', 'onRevoke'];

// Descriptive keys carrying no behaviour.
export const META_KEYS = ['name', 'description', 'triggers'];

// ---------------------------------------------------------------------------
// The Perks themselves. One import, one array entry.
// ---------------------------------------------------------------------------

import corneredAnimal from './corneredAnimal.js';
import geniusObserver from './geniusObserver.js';
import secondWind from './secondWind.js';

const DEFINITIONS = [geniusObserver, corneredAnimal, secondWind];

export const PERK_REGISTRY = Object.fromEntries(
  DEFINITIONS.map((definition) => [definition.name, definition])
);

const norm = (name) => String(name ?? '').trim().toLowerCase();

// Lookup used by every caller. Case-insensitive and whitespace tolerant for
// the same reason hasTagNamed is: a GM typing a trailing space must not
// silently lose the mechanic.
export function perkDefinition(name) {
  const wanted = norm(name);
  for (const definition of Object.values(PERK_REGISTRY)) {
    if (norm(definition.name) === wanted) return definition;
  }
  return null;
}

export const isAutomatedPerk = (name) => perkDefinition(name) != null;
