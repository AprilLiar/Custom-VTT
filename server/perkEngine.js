// Perk resolution — the bridge between a granted Perk and the decisions the
// engine already makes.
//
// **The architecture and the rules for writing a Perk live in
// server/perks/index.js.** This file is only the machinery: it looks up which
// granted Perks have code behind them, folds their contributions to a given
// seam, and owns their per-grant scratch state.
//
// **Import-safe on purpose.** Only `db.js` and pure modules, never
// `server/index.js` — that module boots a real HTTP server at import time, so
// anything importing it (a test file above all) starts one. `io` is taken as an
// explicit parameter wherever a broadcast is needed, exactly as
// roundResolution.js and combatBonuses.js already do, and a Perk definition
// receives it through its ctx rather than importing it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { all, one, run } from './db.js';
import { injuryPenaltyBySlot } from './gameLogic.js';
import { MIN_DAMAGE_THRESHOLD } from './combatDamage.js';
import { expandRollSlotRows, sanitizeAttackTargets } from './moveLogic.js';
import { perkDefinition } from './perks/index.js';

// ---------------------------------------------------------------------------
// What a Perk is allowed to know about a move
// ---------------------------------------------------------------------------

// The facts shape (see the predicates in moveLogic.js that consume it). One
// normalised object, whether it was built from a full getMovesFor row or from a
// bare `SELECT * FROM moves` — those two disagree about `attack_targets` (an
// array on one, a JSON string on the other), and a Perk reading the wrong one
// would silently answer "no Attack Target" for every move in the game.
//
// Deliberately small. A Perk gets what it needs to recognise a move, not a
// handle on the row: nothing here can be written back through.
export function moveFacts(row, rollSlots = null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? null,
    rollSlots: rollSlots ?? (Array.isArray(row.roll_slots) ? row.roll_slots : []),
    activeTics: row.active_tics ?? 0,
    isDefensive: Boolean(row.is_defensive),
    attackTargets: sanitizeAttackTargets(
      Array.isArray(row.attack_targets) ? row.attack_targets : JSON.parse(row.attack_targets ?? '[]')
    ),
    defenseKind: row.defense_kind ?? null,
    // Only ever set on a DECLARED move (see declared_moves.defense_outcome).
    // Null on a Compendium template, which has not been thrown yet and so has
    // no verdict — which is exactly what Deadly Pendulum needs it to say.
    defenseOutcome: row.defense_outcome ?? null,
  };
}

// Roll slots for a set of move ids, flattened, in one batched query. The picker
// asks about twenty moves at once; twenty queries for it would be twenty
// round-trips to Turso.
async function rollSlotsByMove(moveIds) {
  const ids = [...new Set((moveIds ?? []).filter((id) => id != null))];
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const rows = await all(
    `SELECT * FROM move_roll_slots WHERE move_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  );
  for (const row of rows) out.get(row.move_id)?.push(...expandRollSlotRows([row]));
  return out;
}

// One move, as facts, roll slots included.
export async function loadMoveFacts(moveId) {
  if (moveId == null) return null;
  const row = await one('SELECT * FROM moves WHERE id = ?', [moveId]);
  if (!row) return null;
  return moveFacts(row, (await rollSlotsByMove([moveId])).get(moveId) ?? []);
}

// A declared move's footprint end — reveal plus everything that follows it.
// The ordering key for "what did this fighter do before that?", and the same
// expression move:declare's own placement floor uses.
const ENDS_AT = '(dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics)';

// **The move this character threw immediately before — the whole of what "right
// after" means in this game** (Punches in Bunches, Deadly Pendulum, and the
// same rule Requirements already run on; see requirementSatisfiedBy).
//
// Two callers, two moments, one answer:
//
//   - **At declare time** there is no row for the move being declared yet, so
//     `beforeDeclaredMoveId` is null and this is simply the last thing queued —
//     identical to the `last` lookup move:declare already does for Requirements.
//   - **At roll time** the move is on the board, so it is passed in and skipped
//     over: the answer is the queued move that ends nearest before it.
//
// Ordered by footprint end and not by reveal_tic, because a short move declared
// later can still finish earlier than a long one declared before it — and by id
// on a tie, so two moves ending on the same Tic still have a definite order.
export async function previousDeclaredMoveFacts(characterId, { beforeDeclaredMoveId = null } = {}) {
  if (characterId == null) return null;
  const select =
    `SELECT dm.id AS declared_move_id, dm.defense_outcome, m.*, ${ENDS_AT} AS ends_at
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
     WHERE dm.character_id = ?`;

  let row;
  if (beforeDeclaredMoveId == null) {
    row = await one(`${select} ORDER BY ends_at DESC, dm.id DESC LIMIT 1`, [characterId]);
  } else {
    const self = await one(
      `SELECT ${ENDS_AT} AS ends_at FROM declared_moves dm JOIN moves m ON m.id = dm.move_id WHERE dm.id = ?`,
      [beforeDeclaredMoveId]
    );
    if (!self) return null;
    row = await one(
      `${select} AND (${ENDS_AT} < ? OR (${ENDS_AT} = ? AND dm.id < ?))
       ORDER BY ends_at DESC, dm.id DESC LIMIT 1`,
      [characterId, self.ends_at, self.ends_at, beforeDeclaredMoveId]
    );
  }
  if (!row) return null;
  return moveFacts(row, (await rollSlotsByMove([row.id])).get(row.id) ?? []);
}

// A thunk that runs at most once, however many Perks call it.
//
// **This is what keeps the seam context cheap.** `perkRollBonusTerms` runs on
// every roll in the game, and the facts below cost two or three queries to
// build — so they are not built unless a Perk actually asks. Cornered Animal
// never calls them and pays nothing; Deadly Pendulum calls them and pays once,
// even if three Perks ask on the same roll.
function once(fn) {
  let promise = null;
  return () => (promise ??= Promise.resolve().then(fn));
}

// A character's granted Perks that actually have code behind them, paired with
// their own `character_perks.id` — the key their private state hangs off.
//
// Granted Perks with no definition are simply absent: a Perk that is pure
// flavour is the normal case, not an error, and must never make a resolver
// throw. Ordered by grant so a fold is at least deterministic, even though
// every seam below is order-independent by design.
// **A memo with a lifetime somebody else controls (decided, new).**
//
// Resolving one round asked this question eleven times — it is on the path of
// every roll, every trigger and every threshold, for both fighters. Who holds
// which Perk cannot change *within* a resolution: the engine never grants or
// revokes, and a grant arriving from another socket mid-round is already
// undefined as to which Tic it would first apply on.
//
// A module-level cache would be wrong anyway: Node yields at every await, so a
// `perk:grant` handler can interleave between Tics and would then be reading a
// stale map for the rest of the session. AsyncLocalStorage scopes the memo to
// exactly one `withPerkCache` call — concurrent handlers each get their own,
// and nothing outside a resolution is cached at all.
//
// The *promise* is memoised rather than the value, so ten seams asking at once
// still make one read.
const perkCache = new AsyncLocalStorage();

export function withPerkCache(fn) {
  return perkCache.run(new Map(), fn);
}

function loadPerkDefinitions(characterId) {
  return all(
    `SELECT p.name AS name, cp.id AS characterPerkId
     FROM character_perks cp JOIN perks p ON p.id = cp.perk_id
     WHERE cp.character_id = ? ORDER BY cp.id`,
    [characterId]
  ).then((rows) => {
    const out = [];
    for (const row of rows) {
      const definition = perkDefinition(row.name);
      if (definition) out.push({ definition, name: row.name, characterPerkId: row.characterPerkId });
    }
    return out;
  });
}

export async function perkDefinitionsFor(characterId) {
  if (characterId == null) return [];
  const cache = perkCache.getStore();
  if (!cache) return loadPerkDefinitions(characterId);
  if (!cache.has(characterId)) cache.set(characterId, loadPerkDefinitions(characterId));
  return cache.get(characterId);
}

// The context every seam function receives. Built once per resolution rather
// than per Perk, so ten Perks on one roll is still one character read.
async function seamContext(characterId, extra = {}) {
  const character = await one('SELECT * FROM characters WHERE id = ?', [characterId]);
  return { characterId, character, ...extra };
}

// The two move questions a roll-time Perk may want, as thunks (see `once`):
// **what am I throwing**, and **what did I throw right before it**. Neither
// costs anything until a Perk calls it.
//
// `getMove()` answers null for a roll that belongs to no move at all — a hand
// thrown die, the round's Initiative roll — which is the correct answer rather
// than a missing one, and is what stops a move-scoped Perk (The Simplest Tool)
// from paying out on a roll that is not a move's.
function rollMoveContext(characterId, { moveId = null, declaredMoveId = null } = {}) {
  return {
    getMove: once(() => loadMoveFacts(moveId)),
    getPreviousMove: once(() =>
      previousDeclaredMoveFacts(characterId, { beforeDeclaredMoveId: declaredMoveId })
    ),
  };
}

// ---------------------------------------------------------------------------
// Seam resolvers
//
// Each one folds every granted Perk's contribution. **Additive or boolean-OR,
// never ordered** — see the doctrine in perks/index.js. That is what lets a
// character carry any number of Perks without anybody reasoning about which
// one "wins": none of them do, they all just count.
// ---------------------------------------------------------------------------

// Flat modifier on every roll this character makes, as ONE NAMED TERM PER PERK
// rather than a single lump — a Perk that moves a total has to be readable in
// the roll's own breakdown, or it is indistinguishable from the engine
// inventing numbers. Zero contributions are dropped, matching how
// getCombatRollBonusBreakdown drops its own zero terms.
export async function perkRollBonusTerms(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.rollBonus === 'function');
  if (!withSeam.length) return [];
  const ctx = await seamContext(characterId, { ...extra, ...rollMoveContext(characterId, extra) });
  const terms = [];
  for (const { definition, name, characterPerkId } of withSeam) {
    const amount = Math.trunc(Number(await definition.rollBonus({ ...ctx, characterPerkId })) || 0);
    if (amount) terms.push({ key: `perk:${name}`, label: name, amount });
  }
  return terms;
}

// Whether this character may read a publicly revealed move in full (Genius
// Observer). OR-ed: any one Perk saying yes is a yes.
export async function perkAllowsRevealedDetail(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.canSeeRevealedDetail === 'function');
  if (!withSeam.length) return false;
  const ctx = await seamContext(characterId, extra);
  for (const { definition, characterPerkId } of withSeam) {
    if (await definition.canSeeRevealedDetail({ ...ctx, characterPerkId })) return true;
  }
  return false;
}

// The shared shape of every numeric seam that just sums: ask each granted Perk,
// truncate, add up. Written once rather than five near-identical loops, because
// five copies is how one of them quietly stops truncating.
async function sumSeam(characterId, seam, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition[seam] === 'function');
  if (!withSeam.length) return 0;
  const ctx = await seamContext(characterId, extra);
  let total = 0;
  for (const { definition, characterPerkId } of withSeam) {
    total += Math.trunc(Number(await definition[seam]({ ...ctx, characterPerkId })) || 0);
  }
  return total;
}

// The Minimum Damage Threshold for one exchange: the game's own 5, plus what
// the attacker's Perks say about attacks they make, plus what the target's say
// about attacks made against them.
//
// **Both halves in one call, deliberately.** They are the same number to every
// caller downstream — one figure threaded into computeHitDamage — and asking
// for them separately is how a call site ends up applying one and forgetting
// the other. Iron Skin (+2) facing Not Just a Scratch (−2) therefore lands back
// on the plain 5 with no rule of its own for the meeting.
export async function minDamageThresholdFor({ attackerCharacterId, targetCharacterId }) {
  const [attacking, attacked] = await Promise.all([
    attackerCharacterId == null ? 0 : sumSeam(attackerCharacterId, 'minDamageThresholdWhenAttacking'),
    targetCharacterId == null ? 0 : sumSeam(targetCharacterId, 'minDamageThresholdWhenAttacked'),
  ]);
  // Floored at 1: a pile of Not Just a Scratch must not make a roll of 0 — or a
  // negative one — deal damage. Something still has to land.
  return Math.max(1, MIN_DAMAGE_THRESHOLD + attacking + attacked);
}

// How many Half-Damage steps a Full Block sends back at the attacker (Spiked
// Shell). Summed across Perks; 0 when nobody has one, which is the overwhelming
// majority of blocks.
export async function perkBlockRiposteSteps(characterId, { attackerResult, defenderResult }) {
  return Math.max(0, await sumSeam(characterId, 'blockRiposteSteps', { attackerResult, defenderResult }));
}

// How many pending Half-Damage markers this character sheds at Round Start
// (Healing Factor). Which ones is not decided here — see openRoundForCharacters.
export async function perkRoundStartHalfHealing(characterId) {
  return Math.max(0, await sumSeam(characterId, 'roundStartHalfHealing'));
}

// Extra damage this character's blow deals beyond what it just landed (Piercing
// Headache, Last Breath Taker). Concatenated, not summed — see the seam's own
// note. Empty for every fighter without one, which is almost every blow.
export async function perkSplashDamage(characterId, { appliedBySlot }) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.splashDamage === 'function');
  if (!withSeam.length) return [];
  const ctx = await seamContext(characterId, { appliedBySlot });
  const out = [];
  for (const { definition, characterPerkId } of withSeam) {
    const entries = (await definition.splashDamage({ ...ctx, characterPerkId })) ?? [];
    for (const entry of entries) {
      const steps = Math.trunc(Number(entry?.steps) || 0);
      if (entry?.slotName && steps > 0) out.push({ slotName: entry.slotName, steps });
    }
  }
  return out;
}

// Does this character's own move shrug off an opponent's Movement Punisher
// (Grounded)? Asked of the fighter who would be tripped.
export async function perkIgnoresMovementPunisher(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.ignoresMovementPunisher === 'function');
  if (!withSeam.length) return false;
  const ctx = await seamContext(characterId, extra);
  for (const { definition, characterPerkId } of withSeam) {
    if (await definition.ignoresMovementPunisher({ ...ctx, characterPerkId })) return true;
  }
  return false;
}

// What this character's Perks are worth to the Interruption contest
// (Dogfighter). Both halves in one call, folded field by field — the seam was
// designed this way (see vttprojectplan.md's register) because the two numbers
// are the two sides of one comparison and a Perk that moves one usually has an
// opinion about the other.
export async function perkInterruptAmounts(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.interruptAmounts === 'function');
  const total = { interrupter: 0, hardToInterrupt: 0 };
  if (!withSeam.length) return total;
  const ctx = await seamContext(characterId, extra);
  for (const { definition, characterPerkId } of withSeam) {
    const part = (await definition.interruptAmounts({ ...ctx, characterPerkId })) ?? {};
    total.interrupter += Math.trunc(Number(part.interrupter) || 0);
    total.hardToInterrupt += Math.trunc(Number(part.hardToInterrupt) || 0);
  }
  return total;
}

// Stamina back per Half-Damage step this character deals (Baron of Suffering).
// Summed; 0 for everybody else, which is every fighter in almost every fight.
export async function perkStaminaPerHalfDamage(characterId) {
  return Math.max(0, await sumSeam(characterId, 'staminaPerHalfDamage'));
}

// What one move costs this character beyond its authored Stamina Cost — a
// negative number is a discount (Perfect Player). Summed.
//
// The context carries the character's live dice and an injury-penalty lookup
// because the conditions Perks want here are about the state of the fighter, and
// making every Perk fetch them itself would be a query per Perk per move.
// **A whole list of moves in one pass**, because that is how every caller
// actually asks: the declare picker wants a figure for twenty moves at once, and
// the previous version answered them one at a time — re-reading the granted Perk
// list and the character row for each, twenty round-trips for one screen.
//
// Returns a Map of move id -> delta. The character-level facts (dice, Injuries,
// the move thrown right before) are gathered once and shared by every move in
// the list, since none of them vary per move.
export async function perkStaminaCostDeltas({ characterId, moves, dice, injuries }) {
  const out = new Map();
  const list = moves ?? [];
  if (!list.length) return out;
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.staminaCostDelta === 'function');
  if (!withSeam.length) return out;

  const penalties = injuryPenaltyBySlot(injuries);
  const slots = await rollSlotsByMove(list.map((m) => m.id));
  const base = await seamContext(characterId, {
    dice,
    injuryPenaltyFor: (slotName) => penalties.get(slotName) ?? 0,
  });

  // **"The previous move" is per entry, not per batch (bugfix).** The two
  // callers ask fundamentally different questions and the difference is only
  // visible once a Perk reads the queue:
  //
  //   - The **declare picker** prices moves that are not on the board. None of
  //     them has a predecessor of its own, so every one is measured against
  //     this character's last-queued move — one lookup, shared.
  //   - **getPendingStaminaCost** prices moves that ARE on the board, to total
  //     up what this Declaration will cost. Each one has its own place in the
  //     queue, so each is measured against whatever it personally comes after.
  //
  // A shared answer looked right against the picker and then quietly overcharged
  // at commit: every already-queued move was compared to the LAST one declared
  // rather than to its own predecessor, so a two-move combo was billed a
  // different figure from the one it had just been quoted. Callers signal which
  // case they are in by putting `declared_move_id` on the rows they pass.
  const lastQueued = once(() => previousDeclaredMoveFacts(characterId));
  const previousFor = (move) =>
    move.declared_move_id == null
      ? lastQueued
      : once(() => previousDeclaredMoveFacts(characterId, { beforeDeclaredMoveId: move.declared_move_id }));

  for (const move of list) {
    const facts = moveFacts(move, slots.get(move.id) ?? []);
    const getPreviousMove = previousFor(move);
    let total = 0;
    for (const { definition, characterPerkId } of withSeam) {
      total += Math.trunc(
        Number(await definition.staminaCostDelta({ ...base, move: facts, getPreviousMove, characterPerkId })) || 0
      );
    }
    out.set(move.id, total);
  }
  return out;
}

// **How many frames a Perk adds to one move, for this character (new seam).**
//
// Folded into `getMovesFor`'s existing per-character override deltas, which is
// the single place a character's move list is built — so a Perk-granted frame
// lands in the declare picker, the placement floor, the footprint the engine
// resolves and the Tic strip, all from one addition. The character_move_overrides
// table was the alternative and is the wrong shape for this: it is a snapshot
// written at grant time, so a move learned *afterwards* would silently miss out.
//
// Field by field and additive, like `interruptAmounts`. A Perk answering only
// `{ recovery: 1 }` leaves the other two alone.
export async function perkMoveFrameDeltas({ characterId, moves }) {
  const out = new Map();
  const list = moves ?? [];
  if (!list.length) return out;
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.moveFrameDelta === 'function');
  if (!withSeam.length) return out;

  const slots = await rollSlotsByMove(list.map((m) => m.id));
  const base = await seamContext(characterId, {});

  for (const move of list) {
    const facts = moveFacts(move, slots.get(move.id) ?? []);
    const total = { startup: 0, active: 0, recovery: 0 };
    for (const { definition, characterPerkId } of withSeam) {
      const answer = (await definition.moveFrameDelta({ ...base, move: facts, characterPerkId })) ?? {};
      for (const key of ['startup', 'active', 'recovery']) {
        total[key] += Math.trunc(Number(answer[key]) || 0);
      }
    }
    if (total.startup || total.active || total.recovery) out.set(move.id, total);
  }
  return out;
}

// **What this character could pick up right now (Never Empty-Handed).**
//
// Not folded across Perks: each offer is its own button, so two Perks offering
// something would both be listed rather than summing into nonsense. Returns
// only offers that are actually *takeable* — the caller renders them directly,
// so an offer that is already spent must not reach the client at all rather
// than appearing and then being refused.
//
// The empty-slot condition lives with the caller (server/index.js), which knows
// whether the character is carrying anything; this answers the Perk half only.
export async function perkWeaponOffers(characterId) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.weaponOffer === 'function');
  if (!withSeam.length) return [];
  const ctx = await seamContext(characterId, {});
  const offers = [];
  for (const { definition, characterPerkId } of withSeam) {
    const offer = await definition.weaponOffer({ ...ctx, characterPerkId });
    if (!offer) continue;
    // A spent once-per-Fight offer is dropped here rather than shown greyed:
    // the slot is a small control, and "you already did this" is a state the
    // absence of the button says perfectly well.
    if (offer.once && (await readPerkState(characterPerkId, offerKey(definition.name)))) continue;
    offers.push({ ...offer, perkName: definition.name, characterPerkId });
  }
  return offers;
}

// One key per Perk name, so two Perks offering weapons spend their charges
// independently.
export const offerKey = (perkName) => `weapon-offer:${perkName}`;

// Take one. Returns the offer that was taken, or null if it is not on the
// table — a stale client, a second click, or a Perk that was revoked between
// the render and the press. Deliberately re-derives the offers rather than
// trusting anything the client sent beyond the Perk's name.
export async function takeWeaponOffer(characterId, perkName) {
  const offers = await perkWeaponOffers(characterId);
  const offer = offers.find((o) => o.perkName === perkName);
  if (!offer) return null;
  if (offer.once && !(await consumeOnce(offer.characterPerkId, offerKey(perkName), offer.once))) {
    return null;
  }
  return offer;
}

// Does this character get the take-it-back window at the head of resolution?
// (Non-Committed.) OR-ed, like every other boolean seam.
export async function perkInterruptsOwnDeclarations(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.interruptsOwnDeclarations === 'function');
  if (!withSeam.length) return false;
  const ctx = await seamContext(characterId, extra);
  for (const { definition, characterPerkId } of withSeam) {
    if (await definition.interruptsOwnDeclarations({ ...ctx, characterPerkId })) return true;
  }
  return false;
}

// What a Block rolled against this character is penalised by (Path To Mastery:
// Strength). Summed, like every other number seam — asked of the ATTACKER and
// folded into the blocker's own modifier.
export async function perkBlockPenaltyAgainstYou(characterId, extra = {}) {
  return sumSeam(characterId, 'blockPenaltyAgainstYou', extra);
}

// **Spend one charge to keep a Stat off the floor (Path To Mastery:
// Durability).** Returns true if a Perk absorbed the break.
//
// NOT folded across Perks: each keeps its own charges, and the first with any
// left pays. Two Perks each granting two would give four, in the order they
// happen to be granted — which is fine, because they are charges rather than a
// rate and nothing about the outcome depends on which one paid.
//
// Called only once the engine knows a break really happened, which is why the
// spend lives here rather than in the definitions: a Perk decrementing its own
// counter would have to be told about breaks it did not prevent.
export async function perkAbsorbBreak(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.absorbsBreak === 'function');
  if (!withSeam.length) return false;
  const ctx = await seamContext(characterId, extra);
  for (const { definition, characterPerkId } of withSeam) {
    const answer = await definition.absorbsBreak({ ...ctx, characterPerkId });
    const charges = Math.trunc(Number(answer?.charges) || 0);
    if (charges <= 0) continue;
    const key = `absorbs-break:${definition.name}`;
    const used = Math.trunc(Number(await readPerkState(characterPerkId, key)) || 0);
    if (used >= charges) continue;
    await writePerkState(characterPerkId, key, used + 1, answer.scope ?? 'fight');
    return true;
  }
  return false;
}

// Does this character read the High/Mid/Low band of attacks aimed at them?
// (Eye Catcher.) OR-ed.
export async function perkSeesAttackHeight(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.seesAttackHeight === 'function');
  if (!withSeam.length) return false;
  const ctx = await seamContext(characterId, extra);
  for (const { definition, characterPerkId } of withSeam) {
    if (await definition.seesAttackHeight({ ...ctx, characterPerkId })) return true;
  }
  return false;
}

// One move's delta. The single-move shorthand over the batch above.
export async function perkStaminaCostDelta({ characterId, move, dice, injuries }) {
  const deltas = await perkStaminaCostDeltas({ characterId, moves: [move], dice, injuries });
  return deltas.get(move?.id) ?? 0;
}

// How many qualifying idle Tics this character needs per point of Stamina
// regen — 1 unless a granted Perk says otherwise.
//
// **The one seam that is not additive**, and it is worth saying exactly what it
// does instead, because a rate runs the opposite way from a contribution: a
// HIGHER value is a stricter Perk, not a stronger one (the shape this seam was
// designed around is "regen 1 Stamina for every 2 Tics you spend blocking" — a
// restriction bundled with a benefit that lives elsewhere). Summing would be
// nonsense, so the strictest requirement wins. That keeps it order-independent
// like every other seam — the previous version took "the first granted Perk
// with an entry", which quietly depended on grant order — and means a
// restriction can never be dodged by picking up a second Perk.
//
// Pure, and takes names rather than reading the database, so it stays a drop-in
// for the idleStaminaRegenRate this replaces and its existing tests keep
// working unchanged.
export function idleStaminaRegenRate(perkNames) {
  let rate = 1;
  for (const name of perkNames ?? []) {
    const definition = perkDefinition(name);
    const value = Math.trunc(Number(definition?.idleStaminaRegen) || 0);
    if (value > 0) rate = Math.max(rate, value);
  }
  return rate;
}

// ---------------------------------------------------------------------------
// Per-grant state (character_perk_state)
// ---------------------------------------------------------------------------

export async function readPerkState(characterPerkId, key) {
  const row = await one(
    'SELECT value FROM character_perk_state WHERE character_perk_id = ? AND key = ?',
    [characterPerkId, key]
  );
  return row?.value ?? 0;
}

export async function writePerkState(characterPerkId, key, value, scope = 'round') {
  await run(
    `INSERT INTO character_perk_state (character_perk_id, key, value, scope)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(character_perk_id, key) DO UPDATE SET value = excluded.value, scope = excluded.scope`,
    [characterPerkId, key, Math.trunc(Number(value) || 0), scope]
  );
}

// "Has this Perk already fired this round/fight?" — asked and answered in one
// call, because every caller wants both halves and splitting them is how a
// once-per-round effect ends up firing twice.
//
// Returns true the first time and false afterwards, until the scope resets.
export async function consumeOnce(characterPerkId, key, scope = 'round') {
  if (await readPerkState(characterPerkId, key)) return false;
  await writePerkState(characterPerkId, key, 1, scope);
  return true;
}

// Wipe one scope's rows for a set of characters.
//
// **`characterIds` is not optional, and that is deliberate.** A round in this
// game belongs to a *pair*, not to the arena — each pair runs its own clock and
// advances on its own (see combat_pairs). Clearing round-scoped state globally
// would refresh a fighter's once-per-round charge because an unrelated fight
// somewhere else started its next round, which is the exact class of bug the
// per-pair redesign has already produced twice elsewhere. Callers pass the
// characters the reset actually applies to.
export async function clearPerkState(scope, characterIds) {
  const ids = (characterIds ?? []).filter((id) => Number.isInteger(Number(id)));
  if (!ids.length) return;
  await run(
    `DELETE FROM character_perk_state
     WHERE scope = ?
       AND character_perk_id IN (
         SELECT id FROM character_perks WHERE character_id IN (${ids.map(() => '?').join(',')})
       )`,
    [scope, ...ids]
  );
}

// The global wipe, for a scope that genuinely is global. A **fight** ending is
// one — combat:end and combat:clear both tear down every pair, every seat and
// every declaration at once — and a character who left the arena mid-fight
// still has to lose their fight-scoped state, which a seated-characters-only
// sweep would miss.
//
// Deliberately its own exported name rather than a null default on
// clearPerkState above: "clear everywhere" has to be something a caller asks
// for on purpose, so that a round-scoped reset can never reach it by leaving an
// argument off.
export async function clearAllPerkState(scope) {
  await run('DELETE FROM character_perk_state WHERE scope = ?', [scope]);
}
