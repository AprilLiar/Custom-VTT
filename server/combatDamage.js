// Pure damage/defense math for Combat Automation (Phase 9 — see
// vttprojectplan.md's "Game mechanic — Combat Automation" section for the
// full decided design). Split out from combatTiming.js since this is a
// distinct group of math (damage/defense resolution vs. Tic placement) —
// kept just as free of I/O so it's independently unit-testable before any
// schema/socket/UI wiring, same methodology combatTiming.js itself used.

// 4.1 — every 5 points of a roll's result is 1 Half-Damage step (0.5
// damage). A result of 5-9 is 1 step (0.5 damage); 25-29 is 5 steps (2.5
// damage). Never negative — a result below 0 (shouldn't normally happen,
// but defensive) floors at 0 steps.
export function computeHitDamage(result) {
  const halfDamageSteps = Math.max(0, Math.floor(result / 5));
  return { halfDamageSteps, damage: halfDamageSteps * 0.5 };
}

// The No Damage Tag (decided — the second Tag automation). A move carrying it
// never deals damage at all. It has one question instead: did the roll reach
// the move's **Success Threshold**? At or above, the move did what it set out
// to do; below, it simply failed.
//
// **The default is 5 and that is not a coincidence — but it is not the same
// number as the one above, either.** The 5 in computeHitDamage is a
// granularity (every 5 points buys another Half-Damage step); this 5 is a
// floor (anything under it accomplished nothing). They agree today because a
// roll worth less than one step of damage is exactly the roll that should not
// achieve anything, and that symmetry is the whole reason the default was
// picked. They are still two separate constants: a GM raising one move's
// threshold to 12 must not change how damage is counted anywhere.
export const DEFAULT_SUCCESS_THRESHOLD = 5;

export function resolveNoDamageOutcome({ result = 0, successThreshold = DEFAULT_SUCCESS_THRESHOLD } = {}) {
  // `null` is checked before Number(), which would turn it into 0 — and 0 is
  // a real threshold here ("always succeeds"), so an absent value coercing
  // into it would make every move with no stored threshold unfailable.
  const n = successThreshold == null ? NaN : Number(successThreshold);
  const threshold = Number.isFinite(n) ? n : DEFAULT_SUCCESS_THRESHOLD;
  return { threshold, result, succeeded: result >= threshold };
}

// 4.2 — a successful Block/Dodge rolls the defending move's own Roll
// (already summed by the caller into defenderResult, including any
// defensive-only pool) against the attacker's own roll result. netResult is
// floored at 0 (never negative). Whether this is a Partial or Full
// Block/Dodge falls directly out of computeHitDamage's own step count
// rather than re-checking the ">= 5" threshold separately: 0 steps (net
// result under 5) is a Full Block/Dodge — no damage, only the block-trigger
// interaction fires; 1+ steps is Partial — reduced damage applies AND the
// block-trigger interaction still fires (see the mechanic doc).
export function resolveDefenseRoll({ attackerResult, defenderResult }) {
  const netResult = Math.max(0, attackerResult - defenderResult);
  const { halfDamageSteps, damage } = computeHitDamage(netResult);
  return {
    netResult,
    halfDamageSteps,
    damage,
    outcome: halfDamageSteps > 0 ? 'partial' : 'full',
  };
}

// Block Stamina (decided, new — the Block Tag's automation). A Block has no
// up-front Stamina Cost. It pays at resolution, for exactly as much of the
// attack as its guard actually **absorbed**, scaled by the move's own
// Stamina Modifier.
//
// **Absorbed is `min(attackerResult, defenderResult)`.** Out-guarding an
// attack by a mile costs no more than the attack was worth: a 6 met by a 20
// is fully negated but only ever charges for 6. That single quantity also
// reproduces the existing damage math exactly — `netResult = attackerResult
// - absorbed` equals the old `max(0, attackerResult - defenderResult)` in
// both directions, so a blocker with Stamina to spare resolves identically
// to before this rule existed.
//
// **The guard can only hold as much as it can pay for (decided).** If the
// full absorb costs more Stamina than the blocker has left, the block is
// scaled back to the largest amount they can actually afford and the rest of
// the attack gets through. That is what stops a fighter at 0 Stamina from
// blocking forever for free.
//
// Rounding is to nearest (decided), ties up — `Math.round`'s own behaviour.
export function resolveBlockStamina({
  attackerResult,
  defenderResult,
  staminaModifier = 1,
  availableStamina = Infinity,
}) {
  const modifier = Number(staminaModifier) > 0 ? Number(staminaModifier) : 1;
  // Floored at 0: a negative roll on either side absorbs nothing rather than
  // handing someone a negative Stamina bill or a bonus to the attack.
  const wanted = Math.max(0, Math.min(attackerResult, defenderResult));
  const available = Math.max(0, availableStamina);

  let absorbed = wanted;
  let staminaCost = Math.round(absorbed * modifier);
  const capped = staminaCost > available;
  if (capped) {
    // Largest whole absorb whose rounded cost still fits. Computed directly
    // (round-to-nearest means anything under available + 0.5 rounds down to
    // at most `available`), then stepped down defensively so a floating-point
    // edge can never leave a cost one point over budget.
    absorbed = Math.min(wanted, Math.floor((available + 0.5) / modifier));
    while (absorbed > 0 && Math.round(absorbed * modifier) > available) absorbed -= 1;
    absorbed = Math.max(0, absorbed);
    staminaCost = Math.round(absorbed * modifier);
  }

  const netResult = Math.max(0, attackerResult - absorbed);
  const { halfDamageSteps, damage } = computeHitDamage(netResult);
  return {
    absorbed,
    staminaCost,
    netResult,
    halfDamageSteps,
    damage,
    outcome: halfDamageSteps > 0 ? 'partial' : 'full',
    capped,
  };
}

// 4.3 — which phase (if any) a single absolute Tic falls in for one move's
// footprint. Mirrors ChatPanel.jsx's own snapshotPhaseColorAt (client-side,
// for lane snapshot cards) exactly, extracted here as the one shared
// server-side source of truth instead of re-deriving the same logic twice.
// `defenseFramePositions` are 0-based indices into the full Startup+Active+
// Recovery sequence (see Defense Frames under Moves & Tells) — a Defense-
// tagged square overrides whichever phase it would otherwise land in.
export function phaseAtTic({ placementTic, revealTic, activeEndTic, recoveryEndTic, defenseFramePositions = [] }, tic) {
  if (tic < placementTic || tic >= recoveryEndTic) return null;
  const offset = tic - placementTic;
  if (defenseFramePositions.includes(offset)) return 'defense';
  if (tic < revealTic) return 'startup';
  if (tic < activeEndTic) return 'active';
  return 'recovery';
}

// 4.3 — classifies how a defender's Defense-tagged Tics overlap an
// attacker's Active window (`[attackActiveStart, attackActiveEnd)`, the
// same half-open convention computeMoveFootprint's revealTic/activeEndTic
// already use). `defenseTics` is the defender's absolute Defense-tagged
// Tics (possibly non-contiguous, possibly empty).
//   'full'      — every Active Tic is covered; proceed with the normal GM
//                 Block/Dodge/Successful/Failed prompt (4.2).
//   'too-early' — the attack's very first Active Tic isn't covered (the
//                 defense hadn't started yet, or never overlaps at all) —
//                 automatically non-effective, treated as GM-picked Failed.
//   'too-short' — the guard IS up for the attack's first Active Tic, but
//                 runs out before the Active window ends.
//                 `extensionTicsNeeded` is exactly how many Active Tics
//                 aren't covered.
//
// **'too-short' is not a failure, and was renamed from 'too-late' because
// that name said it was one.** Catching the opening frame of an attack is
// how a Block is *supposed* to work: the guard connects, and the blocker's
// own Recovery simply stretches to hold it for the rest of the attack (4.3).
// The old name read as an error at the table for what is ordinary, correct
// play. Dodge is the one that genuinely fails here — it has no partial case
// at all, since a dodge that only covers part of an attack is mechanically
// doomed either way.
export function classifyDefenseCoverage({ attackActiveStart, attackActiveEnd, defenseTics }) {
  const defenseSet = new Set(defenseTics);
  let uncoveredCount = 0;
  for (let t = attackActiveStart; t < attackActiveEnd; t++) {
    if (!defenseSet.has(t)) uncoveredCount++;
  }
  if (uncoveredCount === 0) return { coverage: 'full', extensionTicsNeeded: 0 };
  if (!defenseSet.has(attackActiveStart)) return { coverage: 'too-early', extensionTicsNeeded: 0 };
  return { coverage: 'too-short', extensionTicsNeeded: uncoveredCount };
}

// 4.4 — the Interruption roll's bonus: however many of the attacker's own
// move's Active Tics have already concluded, including the current one —
// always at least +1, since landing the hit at all means at least 1 Active
// Tic is resolving right now.
export function computeInterruptBonus({ revealTic, currentTic }) {
  return Math.max(1, currentTic - revealTic + 1);
}

// Combat Automation overhaul, decision #5 — automatic damage-target
// selection when a move's Attack Target allows more than one concrete Stat.
// `effectiveAttackTargets` is a declared move's own already-canonicalized,
// already-concrete list (see moveLogic.js's expandAttackTargets/
// sanitizeAttackTargets — both already produce CONCRETE_ATTACK_TARGET_NAMES
// order, i.e. Left before Right for both Hand and Leg), so "the move's own
// listed order" and "canonical order" are the same list by construction —
// this just walks it and picks the first Stat with an eligible die.
// `dice` is the target character's own dice as `{ slot_name, status }`.
// Returns the winning die, or null if every allowed Stat's die is
// incapacitated (or missing).
export function selectAutoDamageTarget({ effectiveAttackTargets, dice }) {
  const bySlot = new Map(dice.map((d) => [d.slot_name, d]));
  for (const slot of effectiveAttackTargets) {
    const die = bySlot.get(slot);
    if (die && die.status !== 'incapacitated') return die;
  }
  return null;
}

// Combat Automation overhaul, decision #6 — Uneven Combat's "which opposing
// character gets hit" is no longer a GM click: deterministic, lowest
// characterId among opposing participants who still have a
// non-incapacitated die within the attack's own allowed target set.
// `candidates` is every character seated on the opposing side, as
// `{ characterId, dice: [{ slot_name, status }] }`; `allowedConcreteTargets`
// is the attacking move's own effective (already-concrete) Attack Target
// list. Returns the winning characterId, or null if nobody on that side has
// any eligible die at all (the attack lands on nothing).
export function selectUnevenCombatTarget({ candidates, allowedConcreteTargets }) {
  const allowed = new Set(allowedConcreteTargets);
  const eligible = candidates.filter((c) =>
    c.dice.some((d) => allowed.has(d.slot_name) && d.status !== 'incapacitated')
  );
  if (!eligible.length) return null;
  return eligible.reduce((best, c) => (c.characterId < best.characterId ? c : best)).characterId;
}

// Combat Automation overhaul, §2.2 step 4 — which (if any) of the defending
// character's own declared moves is the one actually defending against this
// particular attack: the FIRST declared move (in queue/placement order)
// whose Defense Frames land anywhere inside the attacker's Active window
// `[attackActiveStart, attackActiveEnd)`. This is a plain "any overlap at
// all" test, distinct from (and always run before) classifyDefenseCoverage
// above, which then classifies exactly how well the winning move's Defense
// Frames cover that same window (full/too-early/too-short). `defenderMoves`
// is the target's own declared moves as `{ declaredMoveId, placementTic,
// defenseFramePositions }`, already in queue order. Returns null (plain
// Hit, no defending move at all) when nothing overlaps.
export function selectDefenseMove({ defenderMoves, attackActiveStart, attackActiveEnd, random = Math.random }) {
  // Every declared move whose Defense Frames touch the attack's Active
  // window at all, not just the first one found.
  const eligible = [];
  for (const move of defenderMoves) {
    const defenseTics = move.defenseFramePositions.map((pos) => move.placementTic + pos);
    if (defenseTics.some((t) => t >= attackActiveStart && t < attackActiveEnd)) {
      eligible.push({ declaredMoveId: move.declaredMoveId, defenseTics });
    }
  }
  if (!eligible.length) return null;
  // Random among them (decided, revised). This used to take the first in
  // declaration order, which quietly rewarded declaration sequence over
  // anything a fighter actually did — and meant a character with two live
  // guards always defended with the older one even when the newer one was
  // the better fit. Picking at random is the deliberate representation of
  // "which guard you actually got up, in the heat of it". `random` is
  // injectable so tests stay deterministic.
  return eligible[Math.floor(random() * eligible.length) % eligible.length];
}

// Which frame positions of a move are its Active frames — the 0-based
// indices into the full Startup+Active+Recovery sequence that `phaseAtTic`
// and `defense_frame_positions` both index into.
export function activeFramePositions({ startupTics, activeTics }) {
  const out = [];
  for (let i = 0; i < activeTics; i++) out.push(startupTics + i);
  return out;
}

// Defense Frames may only sit on a move's ACTIVE frames (decided, new). A
// guard is a thing you are doing, not a thing your wind-up or your recovery
// does incidentally — and allowing a Defense Frame on a Startup square was
// the direct cause of the "Block placed on the attack's own Tic does
// nothing" confusion, since such a frame lands a Tic before the attack's
// Active window even opens.
export function defenseFramesWithinActive({ defenseFramePositions, startupTics, activeTics }) {
  const allowed = new Set(activeFramePositions({ startupTics, activeTics }));
  return defenseFramePositions.every((p) => allowed.has(p));
}

// Whether a Block that fell short may extend its Recovery to hold the guard
// through the rest of the attack (decided, new). It may NOT if the move has
// Active frames after its last Defense Frame — that is a defensive attack
// (guard briefly, then strike), and stretching its Recovery would stretch a
// move that is supposed to be going somewhere. Such a Block simply covers
// what it covers.
export function canExtendDefense({ defenseFramePositions, startupTics, activeTics }) {
  if (!defenseFramePositions.length) return false;
  const lastGuard = Math.max(...defenseFramePositions);
  return !activeFramePositions({ startupTics, activeTics }).some((p) => p > lastGuard);
}

// A Block's Recovery extension pushes that fighter's own later declared
// moves forward to make room, recursively — each shifted move can in turn
// collide with the next (decided, new; replaces the old Forfeit/Postpone of
// a single colliding move). `moves` is that character's own declared moves
// as `{ declaredMoveId, placementTic, footprintTics }`, and `blockedUntil`
// is the first Tic that is free again after the extension. Returns the new
// placement for every move that has to move, in order, leaving untouched
// anything that already sat clear.
export function cascadeShift({ moves, blockedUntil }) {
  const ordered = [...moves].sort((a, b) => a.placementTic - b.placementTic);
  const shifted = [];
  let floor = blockedUntil;
  for (const move of ordered) {
    if (move.placementTic >= floor) {
      // Already clear, and it becomes the new floor for whatever follows.
      floor = move.placementTic + move.footprintTics;
      continue;
    }
    shifted.push({ declaredMoveId: move.declaredMoveId, from: move.placementTic, to: floor });
    floor += move.footprintTics;
  }
  return shifted;
}

// Sub-phase 5 — a self_recovery automation's +/- delta applied to a declared
// move's own recovery_extension_tics, floored so the move's Recovery window
// can never shrink past its Active window ending (extension can go negative,
// but recoveryTics + extension can't go below 0). Mirrors the same additive
// recovery_extension_tics column 4.3's Block-extension handling already
// writes to — a self_recovery automation just adds another delta on top.
export function clampRecoveryExtension({ currentExtensionTics, recoveryTics, delta }) {
  const next = currentExtensionTics + delta;
  return Math.max(-recoveryTics, next);
}
