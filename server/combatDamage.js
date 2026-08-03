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
//   'too-late'  — coverage starts in time but runs out before the Active
//                 window ends. `extensionTicsNeeded` is exactly how many
//                 Active Tics aren't covered — for Block, this is how many
//                 extra Recovery Tics the blocker's move needs (4.3); Dodge
//                 has no partial case and simply fails here too.
export function classifyDefenseCoverage({ attackActiveStart, attackActiveEnd, defenseTics }) {
  const defenseSet = new Set(defenseTics);
  let uncoveredCount = 0;
  for (let t = attackActiveStart; t < attackActiveEnd; t++) {
    if (!defenseSet.has(t)) uncoveredCount++;
  }
  if (uncoveredCount === 0) return { coverage: 'full', extensionTicsNeeded: 0 };
  if (!defenseSet.has(attackActiveStart)) return { coverage: 'too-early', extensionTicsNeeded: 0 };
  return { coverage: 'too-late', extensionTicsNeeded: uncoveredCount };
}

// 4.4 — the Interruption roll's bonus: however many of the attacker's own
// move's Active Tics have already concluded, including the current one —
// always at least +1, since landing the hit at all means at least 1 Active
// Tic is resolving right now.
export function computeInterruptBonus({ revealTic, currentTic }) {
  return Math.max(1, currentTic - revealTic + 1);
}

// Sub-phase 5 — a self_recovery automation's +/- delta applied to a declared
// move's own recovery_extension_tics, floored so the move's Recovery window
// can never shrink past its Active window ending (extension can go negative,
// but recoveryTics + extension can't go below 0). Mirrors the same additive
// recovery_extension_tics column 4.3's Block-too-late handling already
// writes to — a self_recovery automation just adds another delta on top.
export function clampRecoveryExtension({ currentExtensionTics, recoveryTics, delta }) {
  const next = currentExtensionTics + delta;
  return Math.max(-recoveryTics, next);
}
