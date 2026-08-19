// Pure validation/normalization for Moves — kept free of I/O for unit testing.

export const TRIGGERS = ['hit', 'block', 'miss'];

// Defensive-only triggers — only accepted by normalizeInteractions when the
// move itself is flagged is_defensive (see Defensive Moves in the plan).
export const DEFENSE_TRIGGERS = ['defense_success', 'defense_failure'];

// Grappling-only, gated on is_grappling exactly as the two above are gated on
// is_defensive. A grapple has no "hit" of its own to hang things from — it
// wins the contest or it doesn't — so this is where a grappling move's
// consequences live.
export const GRAPPLE_TRIGGERS = ['grapple_success'];

export const ALL_TRIGGERS = [...TRIGGERS, ...DEFENSE_TRIGGERS, ...GRAPPLE_TRIGGERS];

// Frame data: 0-10 squares per segment (Startup/Active/Recovery), at least
// one square total. Startup yellow, Active red, Recovery blue (client-side).
export const FRAME_MAX = 10;

export function clampFrame(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(0, Math.min(FRAME_MAX, n));
}

export function validFrames(startup, active, recovery) {
  return startup + active + recovery >= 1;
}

// Defense Frames: a purely additive annotation on top of the Startup/
// Active/Recovery totals above, not a 4th timing phase — combatTiming.js's
// placement/reveal/overflow math is untouched by this. Each entry is a
// 0-based index into the move's full frame sequence (0..totalTics-1,
// Startup squares first, then Active, then Recovery — same order FrameBar
// renders) marking that particular square as also granting a defensive
// window; the client renders it green instead of its phase color. Can land
// anywhere in the sequence, including mid-Startup or mid-Recovery.
// `startupTics`/`activeTics` are optional only so an older caller that has
// no frame shape to hand still gets the previous "anywhere in the sequence"
// behaviour; every real caller passes them.
//
// **Defense Frames may only sit on ACTIVE frames (decided, new).** A guard
// is something you are actively doing, not something your wind-up or your
// recovery does incidentally — and allowing one on a Startup square was the
// direct cause of the long-running "a Block placed on the attack's own Tic
// does nothing" confusion: such a frame lands a Tic *before* the attack's
// Active window even opens, so it could never defend anything. Positions
// outside the Active window are dropped rather than rejecting the whole
// move, matching how every other sanitizer in this file handles bad input.
export function sanitizeDefensePositions(list, totalTics, { startupTics = null, activeTics = null } = {}) {
  if (!Array.isArray(list)) return [];
  const clean = list
    .map((n) => Math.trunc(Number(n)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < totalTics);
  const scoped =
    startupTics == null || activeTics == null
      ? clean
      : clean.filter((n) => n >= startupTics && n < startupTics + activeTics);
  return [...new Set(scoped)].sort((a, b) => a - b);
}

// Combat Automation overhaul: which of the two defensive mechanics a
// Defensive move's Defense Frames represent. Block resolves fully
// automatically from dice math alone; Dodge is the one remaining
// human-in-the-loop call (the GM's Successful/Failed prompt) — see
// vttprojectplan.md. Required whenever a move is Defensive with at least one
// Defense Frame; meaningless (and always stored as null) otherwise.
export const DEFENSE_KINDS = ['block', 'dodge'];

export function sanitizeDefenseKind(value, isDefensive, hasDefenseFrames) {
  if (!isDefensive || !hasDefenseFrames) return null;
  return DEFENSE_KINDS.includes(value) ? value : 'block';
}

// Automation types on an interaction (the only automated effects for now):
//   self_recovery:     add/remove Recovery on yourself (amount may be negative)
//   opponent_recovery: add Recovery to the opponent (positive)
//   self_stamina:      lose additional Stamina yourself (positive = amount lost)
//   opponent_stamina:  the opponent loses Stamina (positive = amount lost)
// Execution happens in the combat phases; Phase 3 stores and displays them.
//   self_stat_step:     step one of your own Stats down by `amount`
//   opponent_stat_step: step one of the opponent's Stats down by `amount`
// The two stat-step types carry a `slot` naming which Stat, and are the
// first automation that reaches a character's dice rather than their
// Stamina or their timing — the same stepping damage already uses, so a
// move can say "and it wrecks their Right Hand" without a human applying
// it. A negative amount steps the Stat back UP, which is how a move heals.
export const AUTOMATION_TYPES = [
  'self_recovery',
  'opponent_recovery',
  'self_stamina',
  'opponent_stamina',
  'self_stat_step',
  'opponent_stat_step',
];

// Which Stats a stat-step automation may name. Deliberately the concrete
// slots only — an automation names one Stat outright, so the ambiguous
// Hand/Leg vocabulary a move's Roll uses has no meaning here.
export const AUTOMATION_STAT_SLOTS = [
  'Skull',
  'Brain',
  'Left Hand',
  'Right Hand',
  'Body',
  'Stamina',
  'Left Leg',
  'Right Leg',
];

const STAT_STEP_TYPES = new Set(['self_stat_step', 'opponent_stat_step']);

const AMOUNT_LIMIT = 20;

// Returns a cleaned automations array, dropping anything malformed.
export function sanitizeAutomations(list) {
  if (!Array.isArray(list)) return [];
  const clean = [];
  for (const entry of list) {
    if (!entry || !AUTOMATION_TYPES.includes(entry.type)) continue;
    let amount = Math.trunc(Number(entry.amount) || 0);
    amount = Math.max(-AMOUNT_LIMIT, Math.min(AMOUNT_LIMIT, amount));
    if (amount === 0) continue;
    // self_recovery and the stat steps are signed (a negative stat step is
    // a heal); the rest are positive.
    if (entry.type !== 'self_recovery' && !STAT_STEP_TYPES.has(entry.type)) amount = Math.abs(amount);
    if (STAT_STEP_TYPES.has(entry.type)) {
      // A stat step without a valid Stat has nothing to act on, so it is
      // dropped rather than stored as a row that can never fire.
      if (!AUTOMATION_STAT_SLOTS.includes(entry.slot)) continue;
      clean.push({ type: entry.type, amount, slot: entry.slot });
      continue;
    }
    clean.push({ type: entry.type, amount });
  }
  return clean;
}

// Normalizes the interactions payload {hit, block, miss, defense_success?,
// defense_failure?, grapple_success?} -> rows worth storing (non-empty text or
// at least one automation). hit/block/miss are always accepted; the two
// defense triggers only when isDefensive, and grapple_success only when
// isGrappling — a move switched off and re-saved simply stops having them
// normalized in, so a plain move:update (which always replaces
// move_interactions wholesale) drops them.
//
// The two gates are independent: a move can be both Defensive and Grappling
// (a guard that turns into a hold), and gets both sets.
export function normalizeInteractions(interactions, isDefensive = false, isGrappling = false) {
  const rows = [];
  if (!interactions || typeof interactions !== 'object') return rows;
  const allowedTriggers = [
    ...TRIGGERS,
    ...(isDefensive ? DEFENSE_TRIGGERS : []),
    ...(isGrappling ? GRAPPLE_TRIGGERS : []),
  ];
  for (const trigger of allowedTriggers) {
    const entry = interactions[trigger];
    if (!entry) continue;
    const text = String(entry.text ?? '').trim();
    const automations = sanitizeAutomations(entry.automations);
    if (text || automations.length) rows.push({ trigger, text, automations });
  }
  return rows;
}

const ROLL_BONUS_LIMIT = 20;

export function clampRollBonus(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(-ROLL_BONUS_LIMIT, Math.min(ROLL_BONUS_LIMIT, n));
}

// Stamina Cost: required on every move, but 0 (free) is valid; negative
// restores Stamina instead of spending it. Same +/-20 bound as roll bonus —
// there's nothing move-specific requiring a different limit.
const STAMINA_COST_LIMIT = 20;

export function clampStaminaCost(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(-STAMINA_COST_LIMIT, Math.min(STAMINA_COST_LIMIT, n));
}

// Block Stamina (decided, new): the multiplier a Block Tag move's absorb is
// scaled by before it is charged as Stamina. Unlike every other numeric field
// on a move this is fractional on purpose — the whole point is that it sits
// either side of 1: 0.5 is a cheap guard you can hold all fight, 2 is one
// that costs you dearly for what it stops.
//
// **Never 0 or negative** (decided). A 0 would make blocking free, which is
// exactly what this rule exists to stop, and a negative would pay you to be
// hit. Anything unparseable falls back to 1 (charge exactly what you
// absorbed) rather than to the floor, so a malformed payload is neutral
// rather than quietly making a move the cheapest in the game.
const STAMINA_MODIFIER_MIN = 0.1;
const STAMINA_MODIFIER_MAX = 10;
export const DEFAULT_STAMINA_MODIFIER = 1;

export function clampStaminaModifier(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_STAMINA_MODIFIER;
  const bounded = Math.max(STAMINA_MODIFIER_MIN, Math.min(STAMINA_MODIFIER_MAX, n));
  // One decimal place: the Move Creator's own step, and it keeps the stored
  // value readable rather than 0.30000000000000004.
  return Math.round(bounded * 10) / 10;
}

// The No Damage Tag (decided, new): the roll a No Damage move has to reach to
// have accomplished anything. Whole numbers only — it is compared against a
// roll result, which is always an integer, so a threshold of 7.5 would just be
// 8 wearing a disguise.
//
// **Bounded at 0, not below.** A negative threshold would mean a move that
// succeeds no matter what, including on a roll it never made; if a GM wants
// that, 0 already says it honestly. The upper bound matches Stamina Cost's
// own ±20 range — high enough for a move that only the best stance can land,
// low enough that a typo can't author something unreachable.
const SUCCESS_THRESHOLD_MIN = 0;
const SUCCESS_THRESHOLD_MAX = 20;
export const DEFAULT_SUCCESS_THRESHOLD = 5;

export function clampSuccessThreshold(value) {
  // `null` and `''` are checked before Number(), which turns both into 0 —
  // and 0 is a real, meaningful threshold here ("always succeeds"), so
  // letting an absent value coerce into it would quietly author the easiest
  // move in the game every time a client omitted the field.
  if (value == null || value === '') return DEFAULT_SUCCESS_THRESHOLD;
  const n = Number(value);
  // Unparseable falls back to the default rather than to the floor, same
  // reasoning: a malformed payload should give the move the standard rule.
  if (!Number.isFinite(n)) return DEFAULT_SUCCESS_THRESHOLD;
  return Math.max(SUCCESS_THRESHOLD_MIN, Math.min(SUCCESS_THRESHOLD_MAX, Math.trunc(n)));
}

// A move's Roll picks from 6 slots, not the 8 concrete dice: Left/Right Hand
// collapse into one ambiguous 'Hand' choice, Left/Right Leg into 'Leg' — the
// player picks which side at roll time, not the GM at creation time (see
// AMBIGUOUS_ROLL_SLOTS below for how each resolves to a real die).
export const ROLL_SLOT_NAMES = ['Skull', 'Brain', 'Hand', 'Stamina', 'Body', 'Leg'];

// left/right resolution for each ambiguous Roll slot, in [left, right] order.
export const AMBIGUOUS_ROLL_SLOTS = {
  Hand: ['Left Hand', 'Right Hand'],
  Leg: ['Left Leg', 'Right Leg'],
};

// An ambiguous slot may be taken TWICE, which means "both sides at once" —
// a Straight Block guards with both hands, so it rolls Left Hand *and*
// Right Hand (decided). Two is the hard ceiling because a character has
// exactly two of each appendage; a concrete slot (Skull/Brain/Stamina/Body)
// is still one-of-a-kind and stays capped at 1.
export const MAX_AMBIGUOUS_ROLL_SLOT_COUNT = 2;

export function maxRollSlotCount(slot) {
  return slot in AMBIGUOUS_ROLL_SLOTS ? MAX_AMBIGUOUS_ROLL_SLOT_COUNT : 1;
}

// A move's optional Roll: which slots get rolled together, in the order the
// client sent them. Drops unknown slot names and anything over a slot's own
// ceiling (see maxRollSlotCount); empty array = no Roll on this move.
export function sanitizeRollSlots(list) {
  if (!Array.isArray(list)) return [];
  const taken = new Map();
  const clean = [];
  for (const raw of list) {
    const slot = String(raw);
    if (!ROLL_SLOT_NAMES.includes(slot)) continue;
    const already = taken.get(slot) ?? 0;
    if (already >= maxRollSlotCount(slot)) continue;
    taken.set(slot, already + 1);
    clean.push(slot);
  }
  return clean;
}

// move_roll_slots/move_defensive_roll_slots store one row per distinct slot
// with a count (see server/db.js), but every consumer wants the flat list
// the Roll actually rolls — so expand here rather than in each caller. Rows
// written before the count column existed read back as 1, unchanged.
export function expandRollSlotRows(rows) {
  const flat = [];
  for (const row of rows ?? []) {
    const times = Math.min(
      maxRollSlotCount(row.slot_name),
      Math.max(1, Math.trunc(Number(row.count) || 1))
    );
    for (let i = 0; i < times; i++) flat.push(row.slot_name);
  }
  return flat;
}

// Inverse of expandRollSlotRows: collapses a flat Roll list back to the
// one-row-per-slot shape the tables store, preserving first-appearance order.
export function collapseRollSlots(rollSlots) {
  const counts = new Map();
  for (const slot of rollSlots) counts.set(slot, (counts.get(slot) ?? 0) + 1);
  return [...counts].map(([slot_name, count]) => ({ slot_name, count }));
}

export function countRollSlot(rollSlots, slot) {
  return rollSlots.reduce((n, s) => (s === slot ? n + 1 : n), 0);
}

// Grappling: the four directions a grab can be taken, and which move each one
// chains into. Kept here rather than in grappleLogic.js because this is
// *authoring* validation — the same job as normalizeInteractions and
// collapseRollSlots — while grappleLogic.js is the rules the engine runs.
//
// `validMoveIds` is the set of moves that actually exist. A direction naming
// one that doesn't (deleted between opening the form and saving it) is
// dropped rather than stored, the same forgiving shape writeMove already uses
// for a missing folder: the rest of the move still saves.
//
// **A move may never point a direction at itself.** Chaining into another
// grappling move is allowed and resolves as an ordinary move (decided), but a
// self-reference is an unbounded loop rather than a design choice, and it is
// the one case that rule doesn't cover.
export const GRAPPLE_DIRECTIONS = ['up', 'down', 'left', 'right'];

export function normalizeGrappleDirections(directions, { moveId = null, validMoveIds = null } = {}) {
  if (!directions || typeof directions !== 'object') return [];
  const known = validMoveIds == null ? null : new Set(validMoveIds.map(Number));
  const out = [];
  // Iterated in DIRECTIONS order, not payload order, so the cross always
  // stores and renders the same way round.
  for (const direction of GRAPPLE_DIRECTIONS) {
    const raw = Array.isArray(directions)
      ? directions.find((d) => d?.direction === direction)?.targetMoveId
      : directions[direction];
    const targetMoveId = Number(raw);
    if (!Number.isInteger(targetMoveId)) continue;
    if (moveId != null && targetMoveId === Number(moveId)) continue;
    if (known && !known.has(targetMoveId)) continue;
    out.push({ direction, targetMoveId });
  }
  return out;
}

// Requirement: the move this one may only be thrown immediately after.
//
// Same authoring-validation job as normalizeGrappleDirections above, and the
// same two rejections for the same two reasons — a move that no longer exists
// is dropped rather than stored, and **a move may never require itself**,
// which would be a move that can never legally be declared at all (it would
// have to follow a copy of itself that could never have been declared either).
//
// A chain across several moves is fine and needs no depth guard: each link is
// checked independently against whatever was actually declared before it, so
// A-requires-B-requires-C simply has to be declared in that order. A cycle
// between two *different* moves is likewise harmless — it just describes two
// moves that can each only follow the other, so neither can open a sequence.
export function normalizeRequirement(requirementMoveId, { moveId = null, validMoveIds = null } = {}) {
  const required = asMoveId(requirementMoveId);
  if (required == null) return null;
  if (moveId != null && required === Number(moveId)) return null;
  if (validMoveIds != null && !new Set(validMoveIds.map(Number)).has(required)) return null;
  return required;
}

// "Absent" has to be tested BEFORE coercion, not after. `Number(null)` and
// `Number('')` are both 0, and 0 passes Number.isInteger — so a move with no
// Requirement would read as one requiring move id 0, and (worse) the *gate*
// below would then refuse to declare it. The same trap the No Damage
// Success Threshold hit; caught here by a unit test rather than in play.
function asMoveId(value) {
  if (value == null || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

// May a move with this Requirement be declared, given the move the declaring
// character already has queued immediately before it?
//
// `previousMoveId` is the move id of that character's last-queued declared
// move — the one whose footprint ends latest — or null when they have nothing
// queued at all. Passing the *previous* move rather than the whole queue is
// the whole rule: "right after" means the requirement has to be the thing
// directly before, so a Requirement satisfied three moves ago no longer is.
//
// A move with no Requirement is always allowed, which lets the caller run this
// unconditionally instead of branching first.
export function requirementSatisfiedBy(requirementMoveId, previousMoveId) {
  const required = asMoveId(requirementMoveId);
  if (required == null) return true;
  return asMoveId(previousMoveId) === required;
}

// May this move be declared by hand, right now, off the declaration picker?
//
// Two rules, and the second is what **Secondary** means (decided, new):
//
//   1. A Requirement must be satisfied — the move it names has to be the last
//      one this character queued. That is `requirementSatisfiedBy` above and
//      applies to every move, Secondary or not.
//   2. **A Secondary move with no Requirement is never hand-declarable at
//      all.** It is a move that exists to be reached, not chosen: the engine
//      puts it on the board when a grapple's cross picks it (see
//      `declareChainedMove`), and there is no other legitimate way in. A
//      Secondary move that *does* carry a Requirement is the combo case — it
//      is declared by hand, but only ever in the slot right after the move it
//      follows, which rule 1 already enforces on its own.
//
// So Secondary never *adds* a position a move can be declared from; it removes
// the free one. Pure, and shared verbatim by the server's `move:declare` gate
// and the Arena's declare picker, so a greyed-out card and a rejected event can
// never disagree about why.
export function declarableByHand({ isSecondary, requirementMoveId, previousMoveId } = {}) {
  if (!requirementSatisfiedBy(requirementMoveId, previousMoveId)) return false;
  if (isSecondary && asMoveId(requirementMoveId) == null) return false;
  return true;
}

// Does this Roll still contain an unanswered Left/Right question? If so the
// move needs two Tells (right-choice, left-choice) instead of one, and a
// declaration has to record an appendage_choice.
//
// Taking an ambiguous slot twice *answers* it — both sides are used, so
// there is nothing left to pick. Only a slot taken exactly once is genuinely
// ambiguous.
export function hasAmbiguousRollSlot(rollSlots) {
  return Object.keys(AMBIGUOUS_ROLL_SLOTS).some((slot) => countRollSlot(rollSlots, slot) === 1);
}

// Resolves a Roll's slot list to the concrete die slots actually rolled.
// A concrete slot passes through; an ambiguous slot taken twice becomes both
// sides in canonical Left-then-Right order (the same order
// CONCRETE_ATTACK_TARGET_NAMES uses); taken once it follows the
// declaration's own appendage_choice, defaulting to Left when there is none.
export function resolveRollSlotNames(rollSlots, appendageChoice = null) {
  const used = new Map();
  const concrete = [];
  for (const slot of rollSlots) {
    if (!(slot in AMBIGUOUS_ROLL_SLOTS)) {
      concrete.push(slot);
      continue;
    }
    const [left, right] = AMBIGUOUS_ROLL_SLOTS[slot];
    const nth = used.get(slot) ?? 0;
    used.set(slot, nth + 1);
    if (countRollSlot(rollSlots, slot) > 1) concrete.push(nth === 0 ? left : right);
    else concrete.push(appendageChoice === 'right' ? right : left);
  }
  return concrete;
}

// Roll type (decided, new): 'stat' is the original body-part Roll above;
// 'custom' replaces it with one flat base die (for weapons — see
// CUSTOM_ROLL_SIZES), not tied to any character stat. Anything else falls
// back to 'stat'.
export const CUSTOM_ROLL_SIZES = [4, 6, 8, 10, 12];

export function sanitizeRollType(value) {
  return value === 'custom' ? 'custom' : 'stat';
}

// Only meaningful (and only ever stored) when rollType is 'custom' —
// writeMove forces this to null otherwise, mirroring how a Default move's
// styleAttributeId is always forced null regardless of what's sent.
export function sanitizeCustomRollSize(value) {
  const n = Math.trunc(Number(value));
  return CUSTOM_ROLL_SIZES.includes(n) ? n : null;
}

// Attack Target (Change 001): which Stats a Roll's damage may land on. The
// Move template stores the same 6-slot abstract vocabulary as a Roll itself
// (ROLL_SLOT_NAMES) — Hand/Leg only resolve to a concrete side once a
// specific attack is declared (see expandAttackTargets below), same as a
// Roll's own ambiguous slots resolve at roll time, not creation time.
export const ATTACK_TARGET_NAMES = ROLL_SLOT_NAMES;

// The 8 concrete Stats a die/damage application can actually target.
export const CONCRETE_ATTACK_TARGET_NAMES = [
  'Skull',
  'Brain',
  'Left Hand',
  'Stamina',
  'Body',
  'Right Hand',
  'Left Leg',
  'Right Leg',
];

// Unlike sanitizeRollSlots (which preserves input order), this returns
// canonical ATTACK_TARGET_NAMES order — MoveCard/MoveCreator display and the
// Chat/Apply "effective target" line are more legible in a fixed order than
// in whatever order the client happened to send.
export function sanitizeAttackTargets(list) {
  const supplied = new Set(Array.isArray(list) ? list : []);
  return ATTACK_TARGET_NAMES.filter((name) => supplied.has(name));
}

// Attack telegraph (decided, new): does this move announce its first Startup
// Tic to everyone on the Tic Counter? Yes for anything that can actually hit
// you, no for a pure guard — "this Tic is where something dangerous begins"
// is the whole content of the marker, so a Block lighting one up would make
// it mean nothing.
//
// **Active frames alone are not the test**, even though they are what does
// the hitting. Defense Frames may only sit on ACTIVE positions (see
// sanitizeDefensePositions above and the Defence rework in
// vttprojectplan.md), so every working defence necessarily has Active frames
// too — Front Guard and Slip Step both ship as 1/2/x. What separates them is
// the plan's existing **defence-pure** idea: Defensive with no Attack Target
// is a move that exists only to be guarded with, and is the one thing here
// that never telegraphs. A Defensive move that *does* carry an Attack Target
// is a counter-attack — it guards and strikes — so it telegraphs like any
// other attack, because it will in fact land on someone.
export function isTelegraphedAttack({ activeTics, isDefensive, attackTargets }) {
  if (!(Number(activeTics) > 0)) return false;
  const defencePure = Boolean(isDefensive) && sanitizeAttackTargets(attackTargets).length === 0;
  return !defencePure;
}

// Expands a Move template's abstract attack_targets (or any subset of
// ATTACK_TARGET_NAMES) into concrete Stat names, resolving Hand/Leg to one
// or both sides via the same appendage_choice a declared move already
// records for its own ambiguous Roll slot. appendageChoice = null expands to
// both sides (used for the pre-Block "either side is a valid target" case);
// 'left'/'right' narrows to just that side (used once a Successful Block's
// own declared side is known).
export function expandAttackTargets(list, appendageChoice = null) {
  const slots = sanitizeAttackTargets(list);
  const concrete = [];

  for (const slot of slots) {
    if (slot === 'Hand') {
      concrete.push(
        ...(appendageChoice === 'left'
          ? ['Left Hand']
          : appendageChoice === 'right'
            ? ['Right Hand']
            : ['Left Hand', 'Right Hand'])
      );
    } else if (slot === 'Leg') {
      concrete.push(
        ...(appendageChoice === 'left'
          ? ['Left Leg']
          : appendageChoice === 'right'
            ? ['Right Leg']
            : ['Left Leg', 'Right Leg'])
      );
    } else {
      concrete.push(slot);
    }
  }

  return [...new Set(concrete)];
}

// Parses a declared_moves.effective_attack_targets JSON column, dropping
// anything that isn't a recognized concrete Stat name.
export function parseConcreteAttackTargets(json) {
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.filter((name) => CONCRETE_ATTACK_TARGET_NAMES.includes(name));
}
