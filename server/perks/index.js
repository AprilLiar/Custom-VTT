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
  // (ctx) -> number. Summed onto the Minimum Damage Threshold for attacks
  // THIS character makes — negative lowers the bar (Not Just a Scratch).
  'minDamageThresholdWhenAttacking',
  // (ctx) -> number. Summed onto the Minimum Damage Threshold for attacks
  // made AGAINST this character — positive raises it (Iron Skin). The two are
  // separate seams rather than one with a role flag so that an attacker and a
  // defender both carrying a threshold Perk simply add up, which is what makes
  // them cancel correctly when they face each other.
  'minDamageThresholdWhenAttacked',
  // ({ attackerResult, defenderResult, … }) -> number of Half-Damage steps the
  // attacker takes when this character Fully Blocks them (Spiked Shell). Summed.
  // Answers HOW MUCH only — where it lands is selectRiposteTargets' business.
  'blockRiposteSteps',
  // ({ character, dice, move, injuryPenaltyFor }) -> number. Summed onto one
  // move's Stamina Cost for this character, floored at 0 by the caller
  // (Perfect Player). Asked once per move, so a Perk that only touches Dodges
  // answers 0 for everything else.
  'staminaCostDelta',
  // (ctx) -> number of pending Half-Damage markers to clear at Round Start
  // (Healing Factor). Summed. WHICH markers is the engine's choice, at random.
  'roundStartHalfHealing',
  // ({ appliedBySlot }) -> [{ slotName, steps }] of EXTRA damage this
  // character's attack deals on top of what it just landed (Piercing Headache,
  // Last Breath Taker). Concatenated across Perks rather than summed, which is
  // the list-shaped version of the same additive rule: each entry is applied
  // independently and their order cannot matter.
  //
  // `appliedBySlot` is what the blow ACTUALLY put on a die this exchange, keyed
  // by concrete Stat name — not what it rolled, and not what it aimed at. So a
  // splash never fires off damage that found a broken Stat and went nowhere,
  // and it does fire off damage a Successful Block redirected onto the guard
  // (decided): damage to the Skull is damage to the Skull, however it got there.
  'splashDamage',
  // (ctx) -> boolean. OR-ed. Whether this character's moves ignore an
  // opponent's Movement Punisher Tag (Grounded).
  'ignoresMovementPunisher',
  // (ctx) -> { interrupter, hardToInterrupt }. Folded field by field, additively.
  // The two halves of the Interruption contest (Dogfighter). Designed with this
  // shape long before anything used it — see the seam register in
  // vttprojectplan.md — and this is the first Perk to take it up.
  'interruptAmounts',
  // (ctx) -> Stamina returned to this character per Half-Damage step their
  // attack actually LANDS (Baron of Suffering). Summed.
  //
  // "Landed" is the whole rule: the figure comes off the damage the engine
  // wrote to a die, not off what the attack rolled — so a blow aimed at a Stat
  // already broken pays nothing, matching the same "it cannot be applied"
  // reading the end-of-round report uses.
  'staminaPerHalfDamage',
  // ({ move }) -> { startup?, active?, recovery? } frames added to ONE move for
  // this character (Osu!). Folded field by field, additively, into the same
  // per-character override deltas `getMovesFor` already applies — so a frame a
  // Perk adds shows up in the declare picker, in the placement floor, in the
  // footprint the engine resolves and on the Tic strip, from one addition.
  //
  // Deliberately a seam rather than rows written at grant time into
  // character_move_overrides: that table is a snapshot, so a move learned
  // *after* the Perk was granted would silently miss out.
  'moveFrameDelta',
  // ({ character }) -> { label, name, dieSize, bonus?, durability, once? } | null.
  // A weapon this character could pick up, offered on their EMPTY Weapon slot
  // (Never Empty-Handed). NOT folded: each Perk's offer is its own button, so
  // two Perks offering something would simply both be listed.
  //
  // The only seam so far that is a player-facing *action* rather than a number
  // the engine folds in — and it is still shaped as participation in a decision
  // the engine already makes, namely what may fill an empty Weapon slot. The
  // Perk does not arm anybody; it says what it is willing to offer, and
  // `weapon:take_offer` is what actually calls `grantWeapon`.
  'weaponOffer',
  // (ctx) -> boolean. OR-ed. Whether this character gets the chance to take
  // their own declarations back at the head of resolution, after everyone has
  // declared and before anything reveals (Non-Committed).
  //
  // A boolean rather than a number because it is a *window*, not a quantity —
  // two Perks granting it grant the same one window, which is exactly what
  // OR-ing means here.
  'interruptsOwnDeclarations',
];

// Tier-3 lifecycle keys — not seams (they are not folded across Perks, each
// runs on its own), but legal top-level keys on a definition.
export const LIFECYCLE_KEYS = ['onGrant', 'onRevoke'];

// Descriptive keys carrying no behaviour.
//
// `manual: true` marks a Perk that is **deliberately** not automated — its rule
// is one the table keeps, with nothing for the engine to do (see multifaceted.js).
// It changes nothing at runtime; it exists so such a Perk can still be seeded,
// badged and rename-guarded rather than looking forgotten. perkRegistry.test.js
// asserts a manual Perk declares no seam and no lifecycle hook, so the flag can
// never end up on a Perk that actually does something.
export const META_KEYS = ['name', 'description', 'triggers', 'manual'];

// ---------------------------------------------------------------------------
// The Perks themselves. One import, one array entry.
// ---------------------------------------------------------------------------

import baronOfSuffering from './baronOfSuffering.js';
import corneredAnimal from './corneredAnimal.js';
import deadlyPendulum from './deadlyPendulum.js';
import dogfighter from './dogfighter.js';
import geniusObserver from './geniusObserver.js';
import grounded from './grounded.js';
import healingFactor from './healingFactor.js';
import ironSkin from './ironSkin.js';
import lastBreathTaker from './lastBreathTaker.js';
import multifaceted from './multifaceted.js';
import neverEmptyHanded from './neverEmptyHanded.js';
import nonCommitted from './nonCommitted.js';
import notJustAScratch from './notJustAScratch.js';
import osu from './osu.js';
import perfectPlayer from './perfectPlayer.js';
import piercingHeadache from './piercingHeadache.js';
import punchesInBunches from './punchesInBunches.js';
import secondWind from './secondWind.js';
import spikedShell from './spikedShell.js';
import theSimplestTool from './theSimplestTool.js';
import woundedWolf from './woundedWolf.js';

const DEFINITIONS = [
  geniusObserver,
  corneredAnimal,
  secondWind,
  ironSkin,
  notJustAScratch,
  spikedShell,
  perfectPlayer,
  healingFactor,
  multifaceted,
  punchesInBunches,
  theSimplestTool,
  deadlyPendulum,
  baronOfSuffering,
  woundedWolf,
  piercingHeadache,
  lastBreathTaker,
  grounded,
  osu,
  neverEmptyHanded,
  nonCommitted,
  dogfighter,
];

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

// Registered, but with nothing for the engine to do — see `manual` in META_KEYS.
// The badge stays (it means "accounted for"), only its tooltip changes.
export const isManualPerk = (name) => perkDefinition(name)?.manual === true;
