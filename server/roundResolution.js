// Combat Automation overhaul, Phase C — the automatic round-resolution
// engine (see vttprojectplan.md's "Combat Automation overhaul" subsection,
// under Game mechanic — Combat Automation, for the full decided design this
// implements). advancePairResolution(pairIndex, io) processes one pair's
// currently-open round automatically, Tic by Tic, persisting a round_events
// row per event as it happens.
//
// Phase C scope ("no pausing yet" — see the plan's phased build order):
// this engine is NOT wired into any live socket handler yet (still behind
// the existing manual Start Tic Countdown / click-to-step flow in
// server/index.js) and the two genuine human-decision points — a
// full-coverage Dodge, and a Block-too-late move conflict — are auto-
// resolved with a placeholder decision (documented at each site below)
// rather than truly pausing. Both landings (real pausing/resumability, and
// wiring this into combat:character_done_declaring) are Phase D's job.
//
// Why this lives in its own module rather than server/index.js directly
// (a deliberate, documented deviation from this overhaul's original plan
// text, which named server/index.js as the engine's home): server/index.js
// has unconditional module-load side effects (initDb() +
// httpServer.listen()), so anything that imports it — including a test
// file — boots a real server on a real port. Every import below is
// genuinely side-effect-free, which is what lets server/test/
// roundResolution.test.js exercise this engine directly against a real
// (test) database without booting the app — the same reason the existing
// pure-math modules (combatDamage.js/combatTiming.js) are split out, just
// extended here to a thin DB-orchestration layer too.
//
// A handful of small orchestration primitives below (postSystemMessage,
// adjustStamina, logRoll, applyMoveInteractions, getReasonsToFightBonus,
// resolveMoveRollDice) are therefore intentionally-parallel duplicates of
// the same-named functions in server/index.js rather than shared imports —
// `io` is taken as an explicit parameter here instead of closed over, which
// is what keeps this module import-safe. Keep both sides' behavior in sync
// if either one changes.

import { all, one, run } from './db.js';
import { rollDie, applyHalfDamage, clamp } from './gameLogic.js';
import { AMBIGUOUS_ROLL_SLOTS, parseConcreteAttackTargets, expandAttackTargets } from './moveLogic.js';
import {
  computeHitDamage,
  resolveDefenseRoll,
  classifyDefenseCoverage,
  computeInterruptBonus,
  clampRecoveryExtension,
  selectAutoDamageTarget,
  selectUnevenCombatTarget,
  selectDefenseMove,
} from './combatDamage.js';
import {
  computeMoveFootprint,
  computeNextRoundStartTic,
  computeInitiativeOverflowPenalty,
  resolveSideInitiative,
  findInterruptEligibleTic,
} from './combatTiming.js';
import { idleStaminaRegenRate } from './perkAutomations.js';

const GM_CHAT_SENTINEL_ID = 0;

const getCharacter = (id) => one('SELECT * FROM characters WHERE id = ?', [id]);
const getDice = (characterId) => all('SELECT * FROM dice WHERE character_id = ? ORDER BY id', [characterId]);

const diePayload = (die) => ({
  dieId: die.id,
  characterId: die.character_id,
  pool: die.pool,
  slot_name: die.slot_name,
  current_size: die.current_size,
  bonus: die.bonus,
  status: die.status,
  locked_size: die.locked_size,
  locked_bonus: die.locked_bonus,
  locked_status: die.locked_status,
  half_damage: Boolean(die.half_damage),
});

async function postSystemMessage(io, text) {
  await run(
    `INSERT INTO chat_log (kind, character_id, dice_rolled, content) VALUES ('message', ?, '[]', ?)`,
    [GM_CHAT_SENTINEL_ID, text]
  );
  io.emit('chat:message', {
    kind: 'message',
    characterId: null,
    characterName: 'GM',
    message: text,
    imageData: null,
    imageMimeType: null,
    timestamp: new Date().toISOString(),
  });
}

async function adjustStamina(io, characterId, delta) {
  const character = await getCharacter(characterId);
  if (!character) return null;
  const change = Math.trunc(Number(delta) || 0);
  if (!change) return character.current_stamina;
  const currentStamina = clamp(character.current_stamina + change, 0, character.max_stamina);
  await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [currentStamina, character.id]);
  io.emit('character:updated', { ...character, current_stamina: currentStamina });
  return currentStamina;
}

async function logRoll(io, { characterId, characterName, modifier, dice, rollContext = null }) {
  await run(
    'INSERT INTO chat_log (character_id, dice_rolled, modifier, payload) VALUES (?, ?, ?, ?)',
    [characterId, JSON.stringify(dice), modifier, rollContext ? JSON.stringify(rollContext) : null]
  );
  io.emit('roll:result', {
    kind: 'roll',
    ...(rollContext ?? {}),
    characterId,
    characterName,
    modifier,
    dice,
    total: dice.reduce((sum, d) => sum + d.result, 0),
    timestamp: new Date().toISOString(),
  });
}

async function getReasonsToFightBonus(characterId) {
  const row = await one(
    `SELECT cp.reasons_to_fight AS reasons_to_fight
     FROM combat_participants cp
     JOIN combat_pairs pr ON pr.pair_index = cp.pair_index
     WHERE cp.character_id = ? AND pr.phase IS NOT NULL`,
    [characterId]
  );
  return row?.reasons_to_fight ?? 0;
}

// Mirrors server/index.js's resolveMoveRollDice exactly (same helper, same
// name, duplicated for the reasons in the module comment above): resolves
// a list of Roll slot names (concrete or ambiguous Hand/Leg) against one
// character's live dice, via that declared move's own already-stored
// appendage_choice — no dialog to ask again. Silently drops an
// incapacitated/missing die.
async function resolveMoveRollDice(characterId, slotNames, appendageChoice) {
  if (!slotNames.length) return [];
  const dice = await getDice(characterId);
  const dieBySlot = new Map(dice.map((d) => [d.slot_name, d]));
  const resolved = [];
  for (const slot of slotNames) {
    const concreteSlot =
      slot in AMBIGUOUS_ROLL_SLOTS ? AMBIGUOUS_ROLL_SLOTS[slot][appendageChoice === 'right' ? 1 : 0] : slot;
    const die = dieBySlot.get(concreteSlot);
    if (die) resolved.push(die);
  }
  return resolved.filter((d) => d.status === 'active');
}

const TRIGGER_LABELS = {
  hit: 'On Hit',
  block: 'On Block',
  miss: 'On Miss',
  defense_success: 'On Successful Defense',
  defense_failure: 'On Failed Defense',
};

// Mirrors server/index.js's applyMoveInteractions exactly, minus the
// immediate emitCombatUpdated() call on a Recovery change — this engine
// already broadcasts a fresh combat:updated once per Tic it finishes
// processing (see advancePairResolution below), so a Recovery extension
// fired from here shows up at most one Tic-processing-step later, with no
// separate rebroadcast needed here.
async function applyMoveInteractions(io, {
  moveId,
  trigger,
  selfCharacterId,
  selfDeclaredMoveId,
  opponentCharacterId = null,
  opponentDeclaredMoveId = null,
}) {
  const [move, row] = await Promise.all([
    one('SELECT id, name FROM moves WHERE id = ?', [moveId]),
    one('SELECT text, automations FROM move_interactions WHERE move_id = ? AND trigger = ?', [moveId, trigger]),
  ]);
  if (!move || !row) return;
  const [selfCharacter, opponentCharacter] = await Promise.all([
    getCharacter(selfCharacterId),
    opponentCharacterId != null ? getCharacter(opponentCharacterId) : null,
  ]);
  if (!selfCharacter) return;

  let automations;
  try {
    automations = JSON.parse(row.automations ?? '[]');
  } catch {
    automations = [];
  }
  if (!Array.isArray(automations)) automations = [];

  const effects = [];

  const extendRecovery = async (declaredMoveId, delta) => {
    const dm = await one(
      `SELECT dm.id, dm.recovery_extension_tics AS current_extension_tics, m.recovery_tics
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id WHERE dm.id = ?`,
      [declaredMoveId]
    );
    if (!dm) return false;
    const nextExtension = clampRecoveryExtension({
      currentExtensionTics: dm.current_extension_tics,
      recoveryTics: dm.recovery_tics,
      delta,
    });
    await run('UPDATE declared_moves SET recovery_extension_tics = ? WHERE id = ?', [nextExtension, dm.id]);
    return true;
  };

  for (const automation of automations) {
    const amount = Math.trunc(Number(automation?.amount) || 0);
    if (!amount) continue;
    switch (automation?.type) {
      case 'self_recovery': {
        const applied = await extendRecovery(selfDeclaredMoveId, amount);
        if (applied) effects.push(`${amount > 0 ? '+' : '−'}${Math.abs(amount)} Recovery (${selfCharacter.name})`);
        break;
      }
      case 'opponent_recovery': {
        if (!opponentCharacter) break;
        const targetId =
          opponentDeclaredMoveId ??
          (
            await one(
              `SELECT dm.id
               FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
               WHERE dm.character_id = ?
               ORDER BY (dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics) DESC LIMIT 1`,
              [opponentCharacterId]
            )
          )?.id;
        const applied = targetId != null ? await extendRecovery(targetId, amount) : false;
        effects.push(
          applied
            ? `+${amount} Recovery → ${opponentCharacter.name}`
            : `(no declared move for ${opponentCharacter.name} to extend)`
        );
        break;
      }
      case 'self_stamina':
        await adjustStamina(io, selfCharacterId, -amount);
        effects.push(`−${amount} Stamina (${selfCharacter.name})`);
        break;
      case 'opponent_stamina':
        if (!opponentCharacter) break;
        await adjustStamina(io, opponentCharacterId, -amount);
        effects.push(`−${amount} Stamina → ${opponentCharacter.name}`);
        break;
      default:
        break;
    }
  }

  if (row.text || effects.length) {
    const parts = [row.text, effects.join(', ')].filter(Boolean);
    await postSystemMessage(io, `${move.name} — ${TRIGGER_LABELS[trigger] ?? trigger}: ${parts.join(' — ')}`);
  }
}

// Applies `steps` half-damage steps to whichever of `targetCharacterId`'s
// dice selectAutoDamageTarget picks (decision #5 — the move's own
// effectiveAttackTargets, first eligible Stat in that already-canonical
// order). Returns the affected die's slot_name and the actual character,
// or null if no eligible Stat was found (attack lands on nothing).
async function applyAutoDamage(io, { targetCharacterId, effectiveAttackTargets, steps, attackerName }) {
  const dice = await getDice(targetCharacterId);
  const die = selectAutoDamageTarget({ effectiveAttackTargets, dice });
  if (!die) return null;
  let next = {
    current_size: die.current_size,
    bonus: die.bonus,
    status: die.status,
    half_damage: Boolean(die.half_damage),
  };
  for (let i = 0; i < steps; i++) next = applyHalfDamage(next);
  await run('UPDATE dice SET current_size = ?, bonus = ?, status = ?, half_damage = ? WHERE id = ?', [
    next.current_size,
    next.bonus,
    next.status,
    next.half_damage ? 1 : 0,
    die.id,
  ]);
  io.emit('die:updated', diePayload({ ...die, ...next, half_damage: next.half_damage ? 1 : 0 }));
  const character = await getCharacter(targetCharacterId);
  if (character) {
    await postSystemMessage(
      io,
      `${character.name} took ${steps * 0.5} damage to ${die.slot_name}${attackerName ? ` from ${attackerName}` : ''}.`
    );
  }
  return { slotName: die.slot_name, character };
}

// Decision #4/#7/#8 — walks the attacker's own Active window for the first
// Tic the target is still in their own move's Startup, rolls that move's
// own Roll (or the target's Body die if it has none) at
// +computeInterruptBonus, and Interrupts (deletes the Startup move, refunds
// half its committed Stamina Cost) on a successful roll-off. No-op if the
// target has nothing in Startup during the attacker's Active window.
async function checkInterrupt(io, { targetCharacterId, attackerRevealTic, attackerActiveTics, halfDamageSteps, emitEvent, tic }) {
  const targetMoves = await all(
    `SELECT dm.id AS declaredMoveId, dm.placement_tic AS placementTic, dm.reveal_tic AS revealTic
     FROM declared_moves dm WHERE dm.character_id = ?`,
    [targetCharacterId]
  );
  const eligible = findInterruptEligibleTic({
    attackerActiveStart: attackerRevealTic,
    attackerActiveEnd: attackerRevealTic + attackerActiveTics,
    targetMoves,
  });
  if (!eligible) return;

  const startupDM = await one(
    `SELECT dm.*, m.stamina_cost, m.roll_type, m.custom_roll_size, m.roll_modifier, ch.name AS character_name
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id JOIN characters ch ON ch.id = dm.character_id
     WHERE dm.id = ?`,
    [eligible.declaredMoveId]
  );
  if (!startupDM) return;
  const [rollSlotRows, rollBonusRow] = await Promise.all([
    all('SELECT slot_name FROM move_roll_slots WHERE move_id = ?', [startupDM.move_id]),
    one(
      'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
      [targetCharacterId, startupDM.move_id]
    ),
  ]);
  const bonus = computeInterruptBonus({ revealTic: attackerRevealTic, currentTic: eligible.tic });
  const reasonsBonus = await getReasonsToFightBonus(targetCharacterId);
  const mod = bonus + reasonsBonus + startupDM.roll_modifier + rollBonusRow.bonus;

  // Decision #8: the interrupted character rolls their own Startup move's
  // Roll if it has one, otherwise Body (generic toughness) instead of
  // skipping the check.
  let die;
  if (startupDM.roll_type === 'custom' && startupDM.custom_roll_size != null) {
    die = { slot_name: 'Custom', current_size: startupDM.custom_roll_size, bonus: 0 };
  } else if (rollSlotRows.length) {
    const dice = await resolveMoveRollDice(targetCharacterId, rollSlotRows.map((r) => r.slot_name), startupDM.appendage_choice);
    die = dice[0] ?? null;
  }
  if (!die) {
    const bodyDice = await getDice(targetCharacterId);
    die = bodyDice.find((d) => d.slot_name === 'Body' && d.status === 'active') ?? null;
  }
  if (!die) return;

  const result = rollDie(die.current_size) + (die.bonus ?? 0) + mod;
  await logRoll(io, {
    characterId: targetCharacterId,
    characterName: startupDM.character_name,
    modifier: mod,
    dice: [{ slot_name: die.slot_name, size: die.current_size, bonus: die.bonus ?? 0, result }],
  });

  // (Needs confirmation, per the plan's own 4.4 note): threshold assumed to
  // be `roll >= damage taken` — the attack's own halfDamageSteps, threaded
  // in by the caller (this only ever runs once damage is about to land).
  const succeeded = result >= halfDamageSteps;
  await emitEvent(tic, 'interrupt_resolved', {
    startupDeclaredMoveId: startupDM.id,
    succeeded,
    result,
    threshold: halfDamageSteps,
  });
  if (!succeeded) return;

  await run('DELETE FROM declared_moves WHERE id = ?', [startupDM.id]);
  const refund = startupDM.stamina_committed ? Math.trunc(startupDM.stamina_cost / 2) : 0;
  if (refund) await adjustStamina(io, startupDM.character_id, refund);
  await postSystemMessage(
    io,
    refund
      ? `${startupDM.character_name}'s move was Interrupted — ${refund} Stamina refunded.`
      : `${startupDM.character_name}'s move was Interrupted.`
  );
}

// Resolves one revealed attacking move's full consequences (§2.2 steps
// 2-8): auto-roll, target-character selection, defense-move auto-
// selection, Block/Dodge/Hit branching, and the Interruption check. `row`
// is one entry from the enriched revealed-rows query in processTic below.
async function resolveAttack(io, { row, pairIndex, tic, emitEvent }) {
  const hasRoll = row.rollType === 'custom' ? row.customRollSize != null : row.rollSlotNames.length > 0;
  if (!hasRoll) return; // a Roll-less move never enters the damage/defense flow (see Attack Target mechanic)

  // Step 2 — auto-roll the attacker's own move.
  const [rollBonusRow, reasonsBonus] = await Promise.all([
    one(
      'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
      [row.characterId, row.moveId]
    ),
    getReasonsToFightBonus(row.characterId),
  ]);
  const mod = row.rollModifier + rollBonusRow.bonus + reasonsBonus;
  let dice;
  if (row.rollType === 'custom') {
    dice = [{ slot_name: 'Custom', size: row.customRollSize, bonus: 0, result: rollDie(row.customRollSize) + mod }];
  } else {
    const resolved = await resolveMoveRollDice(row.characterId, row.rollSlotNames, row.appendageChoice);
    dice = resolved.map((d) => ({
      slot_name: d.slot_name,
      size: d.current_size,
      bonus: d.bonus,
      result: rollDie(d.current_size) + d.bonus + mod,
    }));
  }
  const total = dice.reduce((sum, d) => sum + d.result, 0);
  await logRoll(io, { characterId: row.characterId, characterName: row.characterName, modifier: mod, dice });
  await emitEvent(tic, 'roll', { declaredMoveId: row.declaredMoveId, characterId: row.characterId, dice, modifier: mod, total });

  const { halfDamageSteps } = computeHitDamage(total);
  if (halfDamageSteps === 0) {
    // Sub-phase 5 precedent: a Miss's opponent-directed automations only
    // fire when there's exactly one target candidate on the opposing side —
    // which of several possible Uneven Combat targets a miss "affects" is
    // a genuine ambiguity not worth guessing at.
    const opposingSide = row.side === 'left' ? 'right' : 'left';
    const opponents = await all('SELECT character_id FROM combat_participants WHERE pair_index = ? AND side = ?', [
      pairIndex,
      opposingSide,
    ]);
    const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [row.declaredMoveId]);
    if (dm && !dm.interactions_resolved) {
      await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [row.declaredMoveId]);
      await applyMoveInteractions(io, {
        moveId: row.moveId,
        trigger: 'miss',
        selfCharacterId: row.characterId,
        selfDeclaredMoveId: row.declaredMoveId,
        opponentCharacterId: opponents.length === 1 ? opponents[0].character_id : null,
      });
    }
    await emitEvent(tic, 'automation_fired', { declaredMoveId: row.declaredMoveId, trigger: 'miss' });
    return;
  }

  // Step 3 — target-character selection (decision #6: deterministic for
  // Uneven Combat, trivial for 1v1).
  const opposingSide = row.side === 'left' ? 'right' : 'left';
  const opponentRows = await all(
    `SELECT cp.character_id AS characterId, d.slot_name AS slotName, d.status AS status
     FROM combat_participants cp JOIN dice d ON d.character_id = cp.character_id
     WHERE cp.pair_index = ? AND cp.side = ?`,
    [pairIndex, opposingSide]
  );
  const candidatesByChar = new Map();
  for (const r of opponentRows) {
    if (!candidatesByChar.has(r.characterId)) candidatesByChar.set(r.characterId, []);
    candidatesByChar.get(r.characterId).push({ slot_name: r.slotName, status: r.status });
  }
  const allowedConcreteTargets = parseConcreteAttackTargets(row.effectiveAttackTargets);
  const targetCharacterId = selectUnevenCombatTarget({
    candidates: [...candidatesByChar.entries()].map(([characterId, dice]) => ({ characterId, dice })),
    allowedConcreteTargets,
  });
  if (targetCharacterId == null) {
    await emitEvent(tic, 'damage_applied', { declaredMoveId: row.declaredMoveId, result: 'no-eligible-target' });
    return;
  }

  const attackActiveStart = row.revealTic;
  const attackActiveEnd = row.revealTic + row.activeTics;
  const runInterruptAndDamage = async (damageTargetCharacterId, effectiveTargets, steps) => {
    const applied = await applyAutoDamage(io, {
      targetCharacterId: damageTargetCharacterId,
      effectiveAttackTargets: effectiveTargets,
      steps,
      attackerName: row.characterName,
    });
    await emitEvent(tic, 'damage_applied', {
      declaredMoveId: row.declaredMoveId,
      targetCharacterId: damageTargetCharacterId,
      slotName: applied?.slotName ?? null,
      steps,
    });
    const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [row.declaredMoveId]);
    if (dm && !dm.interactions_resolved) {
      await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [row.declaredMoveId]);
      await applyMoveInteractions(io, {
        moveId: row.moveId,
        trigger: 'hit',
        selfCharacterId: row.characterId,
        selfDeclaredMoveId: row.declaredMoveId,
        opponentCharacterId: damageTargetCharacterId,
      });
    }
    if (applied) {
      await checkInterrupt(io, {
        targetCharacterId: damageTargetCharacterId,
        attackerRevealTic: attackActiveStart,
        attackerActiveTics: row.activeTics,
        halfDamageSteps: steps,
        emitEvent,
        tic,
      });
    }
  };

  // Step 4 — defense-move auto-selection: the first of the target's own
  // declared moves whose Defense Frames overlap this attack's Active window
  // at all.
  const defenderMoveRows = await all(
    `SELECT dm.id AS declaredMoveId, dm.placement_tic AS placementTic, m.defense_frame_positions AS defenseFramePositions
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
     WHERE dm.character_id = ? ORDER BY dm.queue_order`,
    [targetCharacterId]
  );
  const defenderMoves = defenderMoveRows.map((r) => ({
    declaredMoveId: r.declaredMoveId,
    placementTic: r.placementTic,
    defenseFramePositions: JSON.parse(r.defenseFramePositions ?? '[]'),
  }));
  const defenseMatch = selectDefenseMove({ defenderMoves, attackActiveStart, attackActiveEnd });

  if (!defenseMatch) {
    // Step 7 — plain Hit, no defending move at all.
    await runInterruptAndDamage(targetCharacterId, allowedConcreteTargets, halfDamageSteps);
    return;
  }

  const defenderDM = await one(
    `SELECT dm.id, dm.character_id, dm.placement_tic, dm.reveal_tic, dm.appendage_choice,
            dm.recovery_extension_tics AS current_extension_tics,
            m.id AS move_id, m.active_tics, m.recovery_tics, m.is_defensive, m.defense_kind,
            m.roll_type, m.custom_roll_size, m.roll_modifier, ch.name AS character_name
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id JOIN characters ch ON ch.id = dm.character_id
     WHERE dm.id = ?`,
    [defenseMatch.declaredMoveId]
  );
  const coverage = classifyDefenseCoverage({
    attackActiveStart,
    attackActiveEnd,
    defenseTics: defenseMatch.defenseTics,
  });
  await emitEvent(tic, 'defense_resolved', {
    attackerDeclaredMoveId: row.declaredMoveId,
    defenderDeclaredMoveId: defenderDM.id,
    defenseType: defenderDM.defense_kind,
    coverage: coverage.coverage,
  });

  const defenseLabel = defenderDM.defense_kind === 'block' ? 'Block' : 'Dodge';

  // 'too-early' is auto-Failed for both Block and Dodge — falls straight
  // through to a plain Hit exactly as if there'd been no Defense Frame at
  // all (matches the manual combat:resolve_defense's own force-override).
  if (coverage.coverage === 'too-early') {
    await postSystemMessage(io, `${defenderDM.character_name}'s ${defenseLabel} has failed.`);
    await applyMoveInteractions(io, {
      moveId: defenderDM.move_id,
      trigger: 'defense_failure',
      selfCharacterId: defenderDM.character_id,
      selfDeclaredMoveId: defenderDM.id,
      opponentCharacterId: row.characterId,
      opponentDeclaredMoveId: row.declaredMoveId,
    });
    await runInterruptAndDamage(targetCharacterId, allowedConcreteTargets, halfDamageSteps);
    return;
  }

  if (defenderDM.defense_kind === 'dodge') {
    // 'too-late' has no partial case for Dodge — also auto-Failed. 'full'
    // is the one genuine human decision (decision #2) — Phase C placeholder
    // per this module's header comment: auto-resolved as Failed rather than
    // truly pausing, until Phase D wires the real combat:dodge_prompt/
    // combat:resolve_dodge pause+resume path.
    if (coverage.coverage === 'full') {
      await emitEvent(tic, 'dodge_prompt', {
        attackerDeclaredMoveId: row.declaredMoveId,
        defenderDeclaredMoveId: defenderDM.id,
        attackerResult: total,
      });
      await emitEvent(tic, 'dodge_resolved', {
        attackerDeclaredMoveId: row.declaredMoveId,
        defenderDeclaredMoveId: defenderDM.id,
        outcome: 'failed',
        placeholder: true,
      });
    }
    await postSystemMessage(io, `${defenderDM.character_name}'s ${defenseLabel} has failed.`);
    await applyMoveInteractions(io, {
      moveId: defenderDM.move_id,
      trigger: 'defense_failure',
      selfCharacterId: defenderDM.character_id,
      selfDeclaredMoveId: defenderDM.id,
      opponentCharacterId: row.characterId,
      opponentDeclaredMoveId: row.declaredMoveId,
    });
    await runInterruptAndDamage(targetCharacterId, allowedConcreteTargets, halfDamageSteps);
    return;
  }

  // defense_kind === 'block', coverage 'full' or 'too-late' — fully
  // automatic (decision #1). Roll the defending move's own Roll (base +
  // defensive pool if is_defensive), same math as the manual
  // combat:resolve_defense.
  const [baseSlotRows, defensiveSlotRows, defRollBonusRow] = await Promise.all([
    all('SELECT slot_name FROM move_roll_slots WHERE move_id = ?', [defenderDM.move_id]),
    defenderDM.is_defensive
      ? all('SELECT slot_name FROM move_defensive_roll_slots WHERE move_id = ?', [defenderDM.move_id])
      : [],
    one(
      'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
      [defenderDM.character_id, defenderDM.move_id]
    ),
  ]);
  const defReasonsBonus = await getReasonsToFightBonus(defenderDM.character_id);
  const defMod = defenderDM.roll_modifier + defRollBonusRow.bonus + defReasonsBonus;

  let blockDice;
  if (defenderDM.roll_type === 'custom' && defenderDM.custom_roll_size != null) {
    blockDice = [
      { slot_name: 'Custom', size: defenderDM.custom_roll_size, bonus: 0, result: rollDie(defenderDM.custom_roll_size) + defMod },
    ];
  } else {
    const slotNames = [...baseSlotRows, ...defensiveSlotRows].map((r) => r.slot_name);
    const resolved = await resolveMoveRollDice(defenderDM.character_id, slotNames, defenderDM.appendage_choice);
    blockDice = resolved.map((d) => ({
      slot_name: d.slot_name,
      size: d.current_size,
      bonus: d.bonus,
      result: rollDie(d.current_size) + d.bonus + defMod,
    }));
  }
  const blockResult = blockDice.reduce((sum, d) => sum + d.result, 0);
  await logRoll(io, {
    characterId: defenderDM.character_id,
    characterName: defenderDM.character_name,
    modifier: defMod,
    dice: blockDice,
  });

  const resolution = resolveDefenseRoll({ attackerResult: total, defenderResult: blockResult });
  await postSystemMessage(
    io,
    resolution.outcome === 'full'
      ? `${defenderDM.character_name} scored a Full ${defenseLabel} — no damage.`
      : `${defenderDM.character_name} scored a Partial ${defenseLabel} — ${resolution.damage} damage.`
  );

  // Attack Target (Change 001): a Successful Block replaces the attacker's
  // effective target with the blocker's own base Stat Roll (never the
  // defensive-only pool).
  const blockEffectiveTargets = expandAttackTargets(
    baseSlotRows.map((r) => r.slot_name),
    defenderDM.appendage_choice
  );
  await run(
    `UPDATE declared_moves SET effective_attack_targets = ?, attack_target_source = 'block' WHERE id = ?`,
    [JSON.stringify(blockEffectiveTargets), row.declaredMoveId]
  );

  await applyMoveInteractions(io, {
    moveId: defenderDM.move_id,
    trigger: 'defense_success',
    selfCharacterId: defenderDM.character_id,
    selfDeclaredMoveId: defenderDM.id,
    opponentCharacterId: row.characterId,
    opponentDeclaredMoveId: row.declaredMoveId,
  });
  const attackerDM = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [row.declaredMoveId]);
  if (attackerDM && !attackerDM.interactions_resolved) {
    await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [row.declaredMoveId]);
    await applyMoveInteractions(io, {
      moveId: row.moveId,
      trigger: 'block',
      selfCharacterId: row.characterId,
      selfDeclaredMoveId: row.declaredMoveId,
      opponentCharacterId: defenderDM.character_id,
      opponentDeclaredMoveId: defenderDM.id,
    });
  }

  // 'too-late': extend the blocker's own Recovery to cover the gap, then
  // handle whatever it collides with. Phase C placeholder (per this
  // module's header comment): auto-resolved as Postpone rather than truly
  // pausing for a Forfeit/Postpone choice — Phase D wires the real pause.
  if (coverage.coverage === 'too-late') {
    const oldRecoveryEndTic =
      defenderDM.reveal_tic + defenderDM.active_tics + defenderDM.recovery_tics + defenderDM.current_extension_tics;
    const newRecoveryEndTic = oldRecoveryEndTic + coverage.extensionTicsNeeded;
    await run('UPDATE declared_moves SET recovery_extension_tics = ? WHERE id = ?', [
      defenderDM.current_extension_tics + coverage.extensionTicsNeeded,
      defenderDM.id,
    ]);
    const colliding = await all(
      'SELECT id, placement_tic, move_id FROM declared_moves WHERE character_id = ? AND id != ? AND placement_tic >= ? AND placement_tic < ?',
      [defenderDM.character_id, defenderDM.id, oldRecoveryEndTic, newRecoveryEndTic]
    );
    for (const collision of colliding) {
      await emitEvent(tic, 'move_conflict_prompt', {
        declaredMoveId: collision.id,
        characterId: defenderDM.character_id,
        blockerDeclaredMoveId: defenderDM.id,
      });
      const collisionMove = await one(
        'SELECT startup_tics, active_tics, recovery_tics FROM moves WHERE id = ?',
        [collision.move_id]
      );
      const newPlacementTic = Math.max(collision.placement_tic, newRecoveryEndTic);
      const { revealTic } = computeMoveFootprint({
        placementTic: newPlacementTic,
        startupTics: collisionMove.startup_tics,
        activeTics: collisionMove.active_tics,
        recoveryTics: collisionMove.recovery_tics,
      });
      await run('UPDATE declared_moves SET placement_tic = ?, reveal_tic = ? WHERE id = ?', [
        newPlacementTic,
        revealTic,
        collision.id,
      ]);
      await emitEvent(tic, 'move_conflict_resolved', {
        declaredMoveId: collision.id,
        blockerDeclaredMoveId: defenderDM.id,
        choice: 'postpone',
        placeholder: true,
      });
    }
  }

  if (resolution.halfDamageSteps > 0) {
    await runInterruptAndDamage(defenderDM.character_id, blockEffectiveTargets, resolution.halfDamageSteps);
  }
}

// §2.2 — processes one absolute Tic for one pair: reveal, then resolve
// every move that just revealed, then Idle-Tic Stamina Regen.
async function processTic(io, { pairIndex, tic, emitEvent }) {
  const justRevealed = await all(
    `SELECT dm.id FROM declared_moves dm
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     WHERE dm.reveal_posted = 0 AND dm.reveal_tic <= ? AND cp.pair_index = ?`,
    [tic, pairIndex]
  );
  if (justRevealed.length) {
    const ids = justRevealed.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    await run(`UPDATE declared_moves SET reveal_posted = 1 WHERE id IN (${marks})`, ids);
    const rows = await all(
      `SELECT dm.id AS declaredMoveId, dm.character_id AS characterId, dm.move_id AS moveId,
              dm.placement_tic AS placementTic, dm.reveal_tic AS revealTic,
              dm.appendage_choice AS appendageChoice, dm.effective_attack_targets AS effectiveAttackTargets,
              m.name AS moveName, m.active_tics AS activeTics, m.roll_type AS rollType,
              m.custom_roll_size AS customRollSize, m.roll_modifier AS rollModifier,
              cp.side AS side, ch.name AS characterName
       FROM declared_moves dm
       JOIN moves m ON m.id = dm.move_id
       JOIN combat_participants cp ON cp.character_id = dm.character_id
       JOIN characters ch ON ch.id = dm.character_id
       WHERE dm.id IN (${marks})`,
      ids
    );
    const rollSlotsByMove = new Map();
    const moveIds = [...new Set(rows.map((r) => r.moveId))];
    if (moveIds.length) {
      const moveMarks = moveIds.map(() => '?').join(',');
      const slotRows = await all(`SELECT move_id, slot_name FROM move_roll_slots WHERE move_id IN (${moveMarks})`, moveIds);
      for (const r of slotRows) {
        if (!rollSlotsByMove.has(r.move_id)) rollSlotsByMove.set(r.move_id, []);
        rollSlotsByMove.get(r.move_id).push(r.slot_name);
      }
    }

    // Deliberately does NOT post a lane_snapshot chat card here the way
    // server/index.js's still-current postMoveReveals does for the manual
    // flow: chat:lane_snapshot's per-reveal spam is explicitly slated for
    // removal in favor of a once-per-round round_summary card (§1.5/§4.2,
    // this overhaul's removal list) — wiring the soon-to-be-removed
    // mechanism into the new engine now, only to tear it back out again in
    // Phase E, isn't worth it. round_events (below) is this engine's own
    // event log and the only reveal record it produces in Phase C.
    for (const row of rows) {
      await emitEvent(tic, 'reveal', { declaredMoveId: row.declaredMoveId, characterId: row.characterId, moveId: row.moveId });
    }
    for (const row of rows) {
      await resolveAttack(io, {
        row: { ...row, rollSlotNames: rollSlotsByMove.get(row.moveId) ?? [] },
        pairIndex,
        tic,
        emitEvent,
      });
    }
  }

  await applyIdleTicStaminaRegen(io, pairIndex, tic);
}

// Mirrors server/index.js's applyIdleTicStaminaRegen (see that function's
// own comment for the full Idle-Tic Stamina Regen rule) — duplicated here
// for the same import-safety reason as this module's other primitives.
async function applyIdleTicStaminaRegen(io, pairIndex, tic) {
  const participants = await all('SELECT * FROM combat_participants WHERE pair_index = ?', [pairIndex]);
  if (!participants.length) return;
  const charIds = participants.map((p) => p.character_id);
  const marks = charIds.map(() => '?').join(',');
  const [charRows, footprintRows, perkRows] = await Promise.all([
    all(`SELECT * FROM characters WHERE id IN (${marks})`, charIds),
    all(
      `SELECT dm.character_id AS characterId, dm.placement_tic AS placementTic,
              dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics AS recoveryEndTic
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
       WHERE dm.character_id IN (${marks})`,
      charIds
    ),
    all(
      `SELECT cp.character_id AS characterId, p.name
       FROM character_perks cp JOIN perks p ON p.id = cp.perk_id
       WHERE cp.character_id IN (${marks})`,
      charIds
    ),
  ]);
  const charById = new Map(charRows.map((c) => [c.id, c]));
  const footprintsByChar = new Map();
  for (const row of footprintRows) {
    if (!footprintsByChar.has(row.characterId)) footprintsByChar.set(row.characterId, []);
    footprintsByChar.get(row.characterId).push(row);
  }
  const perkNamesByChar = new Map();
  for (const row of perkRows) {
    if (!perkNamesByChar.has(row.characterId)) perkNamesByChar.set(row.characterId, []);
    perkNamesByChar.get(row.characterId).push(row.name);
  }

  for (const p of participants) {
    const character = charById.get(p.character_id);
    if (!character || character.current_stamina >= character.max_stamina) continue;
    if (!isTicIdleLocal({ tic, footprints: footprintsByChar.get(p.character_id) ?? [] })) continue;

    const ticsRequired = idleStaminaRegenRate(perkNamesByChar.get(p.character_id) ?? []);
    const progress = p.idle_regen_progress + 1;
    if (progress < ticsRequired) {
      await run('UPDATE combat_participants SET idle_regen_progress = ? WHERE character_id = ?', [progress, p.character_id]);
      continue;
    }
    const newStamina = Math.min(character.max_stamina, character.current_stamina + 1);
    await Promise.all([
      run('UPDATE characters SET current_stamina = ? WHERE id = ?', [newStamina, character.id]),
      run('UPDATE combat_participants SET idle_regen_progress = ? WHERE character_id = ?', [
        progress - ticsRequired,
        p.character_id,
      ]),
    ]);
    io.emit('character:updated', { ...character, current_stamina: newStamina });
  }
}

// Same window test as combatTiming.js's isTicIdle — duplicated locally
// (trivial, 2-line predicate) rather than imported, since importing it
// would pull combatTiming.js's whole export surface in just for this one
// function; kept in sync with combatTiming.js's own isTicIdle by
// server/test/combatTiming.test.js already covering the shared logic.
function isTicIdleLocal({ tic, footprints }) {
  return !footprints.some(({ placementTic, recoveryEndTic }) => tic >= placementTic && tic <= recoveryEndTic);
}

// §2.3 — starts a fresh Declaration phase for exactly one pair (extracted
// from server/index.js's combat:next_round, which now calls this once per
// eligible pair instead of batching every pair's setup together — see that
// handler for why: pairs must be able to start their own next round
// independently, on their own schedule, once this engine drives them). Does
// nothing if this pair currently has no seated participants at all.
async function startPairDeclaration(io, pairIndex) {
  const [state, participants, existing] = await Promise.all([
    one('SELECT * FROM combat_state WHERE id = 1'),
    all('SELECT * FROM combat_participants WHERE pair_index = ?', [pairIndex]),
    one('SELECT * FROM combat_pairs WHERE pair_index = ?', [pairIndex]),
  ]);
  if (!participants.length) return;

  const charIds = participants.map((p) => p.character_id);
  const marks = charIds.map(() => '?').join(',');
  const [charRows, brainDice, staminaDice, speedAttribute] = await Promise.all([
    all(`SELECT * FROM characters WHERE id IN (${marks})`, charIds),
    all(`SELECT * FROM dice WHERE character_id IN (${marks}) AND slot_name = 'Brain'`, charIds),
    all(`SELECT * FROM dice WHERE character_id IN (${marks}) AND slot_name = 'Stamina'`, charIds),
    one("SELECT id FROM attributes WHERE name = 'Speed'"),
  ]);
  const charById = new Map(charRows.map((c) => [c.id, c]));
  const brainByChar = new Map(brainDice.map((d) => [d.character_id, d]));
  const staminaByChar = new Map(staminaDice.map((d) => [d.character_id, d]));
  const stanceIds = charRows.map((c) => c.active_stance_id).filter((id) => id != null);
  const stances = stanceIds.length
    ? await all(`SELECT * FROM stances WHERE id IN (${stanceIds.map(() => '?').join(',')})`, stanceIds)
    : [];
  const stanceById = new Map(stances.map((s) => [s.id, s]));
  const hasSpeedStance = (character) => {
    if (!speedAttribute || character.active_stance_id == null) return false;
    const stance = stanceById.get(character.active_stance_id);
    if (!stance) return false;
    return stance.attribute_a_id === speedAttribute.id || stance.attribute_b_id === speedAttribute.id;
  };

  const nextRoundStartTic = computeNextRoundStartTic({
    phase: existing?.phase ?? null,
    currentTic: existing?.current_tic ?? 0,
    roundStartTic: existing?.round_start_tic ?? 0,
    roundLength: state.round_length,
  });

  const blockedUntilRows = charIds.length
    ? await all(
        `SELECT dm.character_id AS characterId,
                MAX(dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics) AS blockedUntilTic
         FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
         WHERE dm.character_id IN (${marks})
         GROUP BY dm.character_id`,
        charIds
      )
    : [];
  const blockedUntilByChar = new Map(blockedUntilRows.map((r) => [r.characterId, r.blockedUntilTic]));

  // Start Combat (this pair's own very first round) restores its seated
  // characters to full Stamina; every subsequent round instead rolls a
  // Stamina Regen — same split server/index.js's combat:next_round already
  // makes, just scoped to one pair now instead of every eligible pair at
  // once.
  if (!existing) {
    for (const character of charRows) {
      if (character.current_stamina !== character.max_stamina) {
        await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [character.max_stamina, character.id]);
        io.emit('character:updated', { ...character, current_stamina: character.max_stamina });
      }
    }
  } else {
    for (const character of charRows) {
      const die = staminaByChar.get(character.id);
      if (!die || die.status !== 'active') continue;
      const result = rollDie(die.current_size) + die.bonus;
      const currentStamina = clamp(character.current_stamina + result, 0, character.max_stamina);
      await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [currentStamina, character.id]);
      io.emit('character:updated', { ...character, current_stamina: currentStamina });
      await logRoll(io, {
        characterId: character.id,
        characterName: character.name,
        modifier: 0,
        dice: [{ slot_name: 'Stamina', size: die.current_size, bonus: die.bonus, result }],
      });
    }
  }

  const rolls = { left: [], right: [] };
  for (const p of participants) {
    const die = brainByChar.get(p.character_id);
    const character = charById.get(p.character_id);
    if (!die || die.status !== 'active' || !character) continue;
    const modifier =
      (p.reasons_to_fight || 0) -
      computeInitiativeOverflowPenalty({
        blockedUntilTic: blockedUntilByChar.get(p.character_id) ?? null,
        nextRoundStartTic,
      });
    const result = rollDie(die.current_size) + die.bonus + modifier;
    rolls[p.side].push({
      characterId: character.id,
      roll: result,
      currentBrain: die.current_size + die.bonus,
      lockedBrain: die.locked_size + die.locked_bonus,
      hasSpeedStance: hasSpeedStance(character),
    });
    await logRoll(io, {
      characterId: character.id,
      characterName: character.name,
      modifier,
      dice: [{ slot_name: 'Brain', size: die.current_size, bonus: die.bonus, result }],
    });
  }

  const hasLeft = participants.some((p) => p.side === 'left');
  const hasRight = participants.some((p) => p.side === 'right');
  let declaringSide;
  if (hasLeft && hasRight) {
    declaringSide = resolveSideInitiative(rolls).firstToDeclare;
  } else {
    declaringSide = hasLeft ? 'left' : 'right';
  }

  const nextRoundNumber = (existing?.round_number ?? 0) + 1;
  if (existing) {
    await run(
      `UPDATE combat_pairs SET declaring_side = ?, round_number = ?, phase = 'declaration',
       round_start_tic = ?, current_tic = ? WHERE pair_index = ?`,
      [declaringSide, nextRoundNumber, nextRoundStartTic, nextRoundStartTic, pairIndex]
    );
  } else {
    await run(
      `INSERT INTO combat_pairs (pair_index, declaring_side, round_number, phase, round_start_tic, current_tic)
       VALUES (?, ?, ?, 'declaration', ?, ?)`,
      [pairIndex, declaringSide, nextRoundNumber, nextRoundStartTic, nextRoundStartTic]
    );
  }
  await Promise.all(
    participants.map((p) => run('UPDATE combat_participants SET declared_this_round = 0 WHERE character_id = ?', [p.character_id]))
  );
}

// §2.1 — the resumable stepper. Idempotent and re-entrant: safe to call
// redundantly (a no-op unless this pair is actually mid-Resolving), and
// picks up from resolved_through_tic on every call rather than assuming
// it's starting fresh — see this module's header comment for Phase C's
// "no pausing yet" scope (both genuine pause points are auto-resolved with
// a placeholder decision for now, not truly parked).
async function advancePairResolution(pairIndex, io) {
  const pair = await one('SELECT * FROM combat_pairs WHERE pair_index = ?', [pairIndex]);
  if (!pair || pair.phase !== 'resolving') return;

  const state = await one('SELECT round_length FROM combat_state WHERE id = 1');
  const roundLength = state.round_length;

  let resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = ?', [
    pairIndex,
    pair.round_number,
  ]);
  if (!resolution) {
    await run(
      `INSERT INTO pair_round_resolutions
         (pair_index, round_number, round_start_tic, round_length, status, resolved_through_tic)
       VALUES (?, ?, ?, ?, 'running', ?)`,
      [pairIndex, pair.round_number, pair.round_start_tic, roundLength, pair.round_start_tic - 1]
    );
    resolution = await one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = ?', [
      pairIndex,
      pair.round_number,
    ]);
  }
  if (resolution.status === 'complete') return;

  let seq = (
    await one('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM round_events WHERE resolution_id = ?', [resolution.id])
  ).maxSeq;
  const emitEvent = async (tic, type, payload) => {
    seq += 1;
    await run(
      `INSERT INTO round_events (resolution_id, pair_index, round_number, seq, tic, type, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [resolution.id, pairIndex, pair.round_number, seq, tic, type, JSON.stringify(payload)]
    );
    io.emit('combat:round_event', {
      pairIndex,
      roundNumber: pair.round_number,
      resolutionId: resolution.id,
      seq,
      tic,
      type,
      payload,
      timestamp: new Date().toISOString(),
    });
  };

  const roundEndTicExclusive = pair.round_start_tic + roundLength;
  let currentTic = resolution.resolved_through_tic + 1;

  while (currentTic < roundEndTicExclusive) {
    await processTic(io, { pairIndex, tic: currentTic, emitEvent });
    // The DB writes bumping resolved_through_tic/current_tic are the LAST
    // thing that happens for this Tic (see this module's header comment on
    // crash-recovery) — a crash before this point just means the next
    // advancePairResolution call cheaply redoes this Tic from scratch.
    await Promise.all([
      run('UPDATE pair_round_resolutions SET resolved_through_tic = ? WHERE id = ?', [currentTic, resolution.id]),
      run('UPDATE combat_pairs SET current_tic = ? WHERE pair_index = ?', [currentTic, pairIndex]),
    ]);
    currentTic += 1;
  }

  await run(`UPDATE pair_round_resolutions SET status = 'complete', completed_at = datetime('now') WHERE id = ?`, [
    resolution.id,
  ]);
  await emitEvent(roundEndTicExclusive - 1, 'round_complete', { pairIndex, roundNumber: pair.round_number });
  await startPairDeclaration(io, pairIndex);
}

export { advancePairResolution, startPairDeclaration };
