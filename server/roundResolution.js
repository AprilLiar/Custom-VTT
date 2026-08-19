// Combat Automation overhaul, Phases C-D — the automatic round-resolution
// engine (see vttprojectplan.md's "Combat Automation overhaul" subsection,
// under Game mechanic — Combat Automation, for the full decided design this
// implements). advancePairResolution(pairIndex, io) processes one pair's
// currently-open round automatically, Tic by Tic, persisting a round_events
// row per event as it happens, and genuinely pauses (persisting
// pending_dodge_json/pending_conflict_json + status='paused_dodge'/
// 'paused_conflict' on the pair's own pair_round_resolutions row) at either
// of the two real human-decision points: a full-coverage Dodge, or a
// Block-extension move conflict. resolveDodge/resolveMoveConflict (exported
// below) apply the human's answer and resume the engine from exactly where
// it paused; resumeAllPairsOnBoot sweeps every still-'running' resolution
// at server boot, the actual crash-recovery story.
//
// Not yet wired into any live socket handler (still behind the existing
// manual Start Tic Countdown / click-to-step flow in server/index.js) — a
// deliberate scope cut, not an oversight: wiring the automatic trigger into
// combat:character_done_declaring before Phase E's cutscene UI exists for
// a GM to actually see and answer a Dodge prompt would mean either
// building throwaway UI early or silently auto-deciding every Dodge in
// production, a real regression from today's fully-manual flow. The event
// contract this module already implements (combat:round_event,
// combat:dodge_prompt/dodge_resolved, combat:move_conflict_prompt/
// move_conflict_resolved) is ready for Phase E to call directly.
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
// adjustStamina, logRoll, applyMoveInteractions, resolveMoveRollDice) are
// therefore intentionally-parallel duplicates of
// the same-named functions in server/index.js rather than shared imports —
// `io` is taken as an explicit parameter here instead of closed over, which
// is what keeps this module import-safe. Keep both sides' behavior in sync
// if either one changes.

import { all, one, run } from './db.js';
import { rollDie, applyHalfDamage, clamp, stepDie, rollTotal } from './gameLogic.js';
import {
  parseConcreteAttackTargets,
  expandAttackTargets,
  expandRollSlotRows,
  resolveRollSlotNames,
} from './moveLogic.js';
import {
  computeHitDamage,
  resolveDefenseRoll,
  classifyDefenseCoverage,
  computeInterruptBonus,
  clampRecoveryExtension,
  selectAutoDamageTargets,
  selectUnevenCombatTarget,
  selectDefenseMove,
  resolveBlockStamina,
  resolveNoDamageOutcome,
  DEFAULT_SUCCESS_THRESHOLD,
} from './combatDamage.js';
import { carriesBlockTag, carriesNoDamageTag, effectiveTagNames } from './tagAutomations.js';
import {
  DECLINE_FOLLOW_UP,
  DIRECTIONS,
  GUESS_NONE,
  GUESS_RIGHT,
  GUESS_WRONG,
  annotateFollowUps,
  assignedDirections,
  chainRollBonusFor,
  shouldRunMiniGame,
  grapplePenaltyWindowEnd,
  planChainPlacement,
  resolveGrappleContest,
} from './grappleLogic.js';

// A move's Tag names as they apply to ONE character — the template's own tags
// plus/minus whatever Perks have added or removed for them
// (character_move_tags). Tag automation has to read the resolved set, or a
// Perk that grants the Block Tag would show up on the Moves tab and change
// nothing in a fight. Mirrors the effective_tag_ids resolution in
// server/index.js, on names instead of ids (see tagAutomations.js on why
// names).
// Exported for server/index.js's move:declare, which has to ask the same
// question at declaration time (does the move being declared right after
// carry the Feint Tag?) — one resolution of add/remove Perk overrides, not
// two that can drift.
export async function moveTagNamesFor(characterId, moveId) {
  const [own, overrides] = await Promise.all([
    all('SELECT t.name FROM move_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.move_id = ?', [moveId]),
    all(
      `SELECT cmt.action, t.name AS tag_name
       FROM character_move_tags cmt JOIN tags t ON t.id = cmt.tag_id
       WHERE cmt.character_id = ? AND cmt.move_id = ?`,
      [characterId, moveId]
    ),
  ]);
  return effectiveTagNames({ moveTagNames: own.map((r) => r.name), overrides });
}
import {
  computeMoveFootprint,
  computeNextRoundStartTic,
  computeInitiativeOverflowPenalty,
  resolveSideInitiative,
  findInterruptEligibleTic,
  planImposedRecovery,
} from './combatTiming.js';
import { idleStaminaRegenRate } from './perkAutomations.js';
import { getCombatRollBonus, getCombatRollBonusBreakdown, getStanceMatchupBonus } from './combatBonuses.js';

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

// `emitEvent`/`tic` are optional and supplied by in-engine callers, so a
// Stamina change during resolution reaches the cutscene's fighter cards as
// well as the live Arena. Without it the cards showed the value frozen at
// the round's start while the log said Stamina had moved — a number that
// contradicts the sentence above it is worse than no number.
async function adjustStamina(io, characterId, delta, { emitEvent = null, tic = null, reason = null } = {}) {
  const character = await getCharacter(characterId);
  if (!character) return null;
  const change = Math.trunc(Number(delta) || 0);
  if (!change) return character.current_stamina;
  const currentStamina = clamp(character.current_stamina + change, 0, character.max_stamina);
  await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [currentStamina, character.id]);
  io.emit('character:updated', { ...character, current_stamina: currentStamina });
  if (emitEvent && tic != null) {
    await emitEvent(tic, 'stamina_changed', {
      characterId: character.id,
      characterName: character.name,
      // The applied delta, not the requested one — clamping at 0 and at Max
      // means "spend 3" can really be "spend 1".
      delta: currentStamina - character.current_stamina,
      currentStamina,
      maxStamina: character.max_stamina,
      reason,
    });
  }
  return currentStamina;
}

async function logRoll(io, { characterId, characterName, modifier, dice, rollContext = null }) {
  await run(
    'INSERT INTO chat_log (character_id, dice_rolled, modifier, payload) VALUES (?, ?, ?, ?)',
    [characterId, JSON.stringify(dice), modifier, rollContext ? JSON.stringify(rollContext) : null]
  );
  // GM_CHAT_SENTINEL_ID only reaches here through dice:roll_custom's "post as
  // GM" path; the engine always rolls for a real character. Normalizing it
  // back to null on the broadcast matches how GET /api/chat reads a GM-posted
  // row back after a reload, so a live entry and its post-refresh reload
  // render identically instead of one carrying a raw 0 the other doesn't.
  const isGmPost = characterId === GM_CHAT_SENTINEL_ID;
  io.emit('roll:result', {
    kind: 'roll',
    // Spread onto the broadcast rather than nested under its own key, so a
    // live roll and its reload render identically — the same convention
    // kind='lane_snapshot' rows already use for their payload.
    ...(rollContext ?? {}),
    characterId: isGmPost ? null : characterId,
    characterName,
    modifier,
    dice,
    // rollTotal, not a bare sum: a die's own `result` no longer carries the
    // shared modifier (see rollTotal in gameLogic.js), so the total is where
    // that modifier is actually applied — once, to the sum.
    total: rollTotal(dice, modifier),
    timestamp: new Date().toISOString(),
  });
}


// Mirrors server/index.js's resolveMoveRollDice exactly (same helper, same
// name, duplicated for the reasons in the module comment above): resolves
// a list of Roll slot names (concrete or ambiguous Hand/Leg) against one
// character's live dice, via that declared move's own already-stored
// appendage_choice — no dialog to ask again. A slot listed twice means both
// sides (a Straight Block guards with both hands) and ignores the choice
// entirely; see resolveRollSlotNames. Silently drops an incapacitated/
// missing die.
async function resolveMoveRollDice(characterId, slotNames, appendageChoice) {
  if (!slotNames.length) return [];
  const dice = await getDice(characterId);
  const dieBySlot = new Map(dice.map((d) => [d.slot_name, d]));
  const resolved = resolveRollSlotNames(slotNames, appendageChoice)
    .map((slot) => dieBySlot.get(slot))
    .filter(Boolean);
  return resolved.filter((d) => d.status === 'active');
}

const TRIGGER_LABELS = {
  hit: 'On Hit',
  block: 'On Block',
  miss: 'On Miss',
  defense_success: 'On Successful Defense',
  defense_failure: 'On Failed Defense',
};

const IMPOSED_PHASE_PHRASE = {
  startup: 'caught winding up',
  'in-flight': 'caught mid-move',
  idle: 'caught between moves',
};

// The one place the wording for an imposed Recovery is decided, so the Chat
// Log line, the cutscene's own effect list and the round summary can never
// describe the same displacement differently. `plan` is planImposedRecovery's
// result, or null when there was no clock to apply it to (see imposeRecovery).
function describeImposedRecovery(plan, amount, characterName, isOpponent) {
  const arrow = isOpponent ? ` → ${characterName}` : ` (${characterName})`;
  if (!plan || plan.phase === 'none') return `+${amount} Recovery${arrow}`;
  const shifted = plan.updates.filter((u) => u.id !== plan.affectedMoveId).length;
  const tail = shifted ? `, ${shifted} move${shifted === 1 ? '' : 's'} pushed later` : '';
  return `+${amount} Recovery${arrow} (${IMPOSED_PHASE_PHRASE[plan.phase]}${tail})`;
}

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
  // Supplied by every in-engine call site so the effect reaches the
  // cutscene as well as the Chat Log. Automations always DID fire
  // mechanically — Stamina moved, Recovery extended — but they emitted no
  // round_event, so from inside the cutscene they were invisible and the
  // whole feature read as "not automated". Optional only because the
  // signature is shared with the pre-overhaul copy in server/index.js.
  emitEvent = null,
  tic = null,
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

  // Shrinking a Recovery window (`self_recovery` with a negative amount) is
  // still the old, purely-local operation: it touches one declared move's own
  // extension and nothing else. Pulling later moves EARLIER to close the gap
  // would drop them below the placement floors they were declared under, and
  // nobody asked for a move to arrive sooner than it was thrown.
  const shrinkRecovery = async (declaredMoveId, delta) => {
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

  // **Recovery imposed on the clock (decided, new).** Adding Recovery used to
  // be pure bookkeeping on one row; it lands on the timeline now. Where the
  // frames go is decided by what that character is doing at THIS Tic —
  // caught in Startup, caught mid-move, or caught between moves — and
  // everything they had declared after it slides that many Tics later. All
  // the reasoning and all three cases live in planImposedRecovery
  // (combatTiming.js), pure and unit-tested; this is only the read, the
  // write-back and the announcement.
  const imposeRecovery = async (characterId, characterName, tics, atTic) => {
    if (characterId == null) return null;
    // The engine always knows the Tic it is resolving. server/index.js's
    // combat:apply_damage — the chat card's manual Apply button, the one
    // surviving path that fires a trigger from outside the engine — does
    // not, so the clock is read from that character's own pair instead of
    // the effect silently not landing.
    let clockTic = atTic;
    if (!Number.isInteger(clockTic)) {
      const seat = await one(
        `SELECT cpr.current_tic AS tic
         FROM combat_participants cp JOIN combat_pairs cpr ON cpr.pair_index = cp.pair_index
         WHERE cp.character_id = ?`,
        [characterId]
      );
      clockTic = seat?.tic;
    }
    if (!Number.isInteger(clockTic)) return null;
    const rows = await all(
      `SELECT dm.id, dm.placement_tic, dm.reveal_tic, dm.recovery_extension_tics,
              m.active_tics, m.recovery_tics
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
       WHERE dm.character_id = ?
       ORDER BY dm.placement_tic`,
      [characterId]
    );
    const plan = planImposedRecovery({
      moves: rows.map((r) => ({
        id: r.id,
        placementTic: r.placement_tic,
        revealTic: r.reveal_tic,
        activeTics: r.active_tics,
        recoveryTics: r.recovery_tics,
        recoveryExtensionTics: r.recovery_extension_tics,
      })),
      tic: clockTic,
      tics,
    });
    for (const u of plan.updates) {
      await run(
        'UPDATE declared_moves SET placement_tic = ?, reveal_tic = ?, recovery_extension_tics = ? WHERE id = ?',
        [u.placementTic, u.revealTic, u.recoveryExtensionTics, u.id]
      );
    }
    // Only the moves that genuinely MOVED, which is every update except the
    // in-flight one (that one grew rather than moved). The cutscene needs the
    // distinction to animate them differently — see moves_displaced there.
    const shifted = plan.updates.filter((u) => u.id !== plan.affectedMoveId).map((u) => u.id);
    if (plan.phase !== 'none' && emitEvent && tic != null) {
      await emitEvent(tic, 'moves_displaced', {
        characterId,
        characterName,
        tics,
        // 'startup' | 'in-flight' | 'idle' — what they were caught doing.
        phase: plan.phase,
        affectedDeclaredMoveId: plan.affectedMoveId,
        // Ids and a Tic count only. Deliberately NOT the new Active/Recovery
        // ends: a still-unrevealed move's frame lengths are secret, and a
        // round_event is replayed to everyone. "This move moved N Tics later"
        // discloses no more than placementTic already does.
        shiftedDeclaredMoveIds: shifted,
      });
    }
    return plan;
  };

  // Where on the clock an imposed Recovery lands. The engine always knows the
  // Tic it is resolving; server/index.js's manual copy of this function does
  // not, and passes null, in which case nothing is displaced and the effect
  // falls back to the plain extension it always was.

  for (const automation of automations) {
    const amount = Math.trunc(Number(automation?.amount) || 0);
    if (!amount) continue;
    switch (automation?.type) {
      // Both Recovery automations go through the same door now, and the
      // door is the clock rather than a row: `imposeRecovery` decides where
      // the frames land from what that character is doing at this very Tic
      // and slides everything they had declared after it. That is what
      // "applied instantly" means — the effect is on the timeline the
      // moment it fires, not a number that quietly changes a later
      // subtraction.
      //
      // A NEGATIVE self_recovery is the one exception and keeps the old
      // local path (see shrinkRecovery): shortening a window is not a
      // displacement, and nothing should arrive earlier than it was thrown.
      case 'self_recovery': {
        if (amount < 0) {
          const applied = await shrinkRecovery(selfDeclaredMoveId, amount);
          if (applied) effects.push(`−${Math.abs(amount)} Recovery (${selfCharacter.name})`);
          break;
        }
        const plan = await imposeRecovery(selfCharacterId, selfCharacter.name, amount, tic);
        effects.push(describeImposedRecovery(plan, amount, selfCharacter.name, false));
        break;
      }
      case 'opponent_recovery': {
        if (!opponentCharacter) break;
        // No "whichever of their moves ends latest" fallback any more. That
        // existed only because `miss` has no specific opponent move tied to
        // the exchange — but the question was never "which move", it was
        // "what are they doing right now", and the idle case is a real
        // answer rather than a missing one.
        const plan = await imposeRecovery(opponentCharacterId, opponentCharacter.name, amount, tic);
        effects.push(describeImposedRecovery(plan, amount, opponentCharacter.name, true));
        break;
      }
      case 'self_stat_step':
      case 'opponent_stat_step': {
        const isSelf = automation.type === 'self_stat_step';
        const who = isSelf ? selfCharacter : opponentCharacter;
        const whoId = isSelf ? selfCharacterId : opponentCharacterId;
        if (!who || whoId == null) break;
        const stepped = await stepStat(io, {
          characterId: whoId,
          slotName: automation.slot,
          steps: amount,
          emitEvent,
          tic,
          characterName: who.name,
        });
        effects.push(
          stepped
            ? `${automation.slot} ${amount > 0 ? 'down' : 'up'} ${Math.abs(amount)} ${
                Math.abs(amount) === 1 ? 'step' : 'steps'
              } (${who.name})`
            : `(${who.name} has no ${automation.slot} to step)`
        );
        break;
      }
      case 'self_stamina':
        await adjustStamina(io, selfCharacterId, -amount, { emitEvent, tic, reason: 'automation' });
        effects.push(`−${amount} Stamina (${selfCharacter.name})`);
        break;
      case 'opponent_stamina':
        if (!opponentCharacter) break;
        await adjustStamina(io, opponentCharacterId, -amount, { emitEvent, tic, reason: 'automation' });
        effects.push(`−${amount} Stamina → ${opponentCharacter.name}`);
        break;
      default:
        break;
    }
  }

  if (row.text || effects.length) {
    const parts = [row.text, effects.join(', ')].filter(Boolean);
    await postSystemMessage(io, `${move.name} — ${TRIGGER_LABELS[trigger] ?? trigger}: ${parts.join(' — ')}`);
    if (emitEvent && tic != null) {
      await emitEvent(tic, 'automation_fired', {
        moveId,
        moveName: move.name,
        trigger,
        triggerLabel: TRIGGER_LABELS[trigger] ?? trigger,
        characterId: selfCharacterId,
        characterName: selfCharacter.name,
        declaredMoveId: selfDeclaredMoveId ?? null,
        text: row.text || null,
        // Already-rendered phrases ("−2 Stamina (Striker)"), not raw
        // automation rows: the wording is decided here, next to the code
        // that actually applied each one, so the cutscene and the Chat Log
        // can never describe the same effect differently.
        effects,
      });
    }
  }
}

// Applies half-damage steps to EVERY Stat this move attacks (decision #5,
// revised) — selectAutoDamageTargets returns them all, in the move's own
// already-canonical order.
//
// `stepsBySlot` gives a Stat its own figure when its defence was resolved
// separately (a Block that held against one line and not the other); anything
// not named there takes the flat `steps`. A Stat whose figure comes out at 0
// is skipped entirely rather than written back unchanged — that is a Stat the
// guard stopped, and "took 0 damage to Body" reads as a bug rather than a rule.
//
// Returns one entry per Stat actually damaged, empty when the attack landed on
// nothing.
async function applyAutoDamage(io, { targetCharacterId, effectiveAttackTargets, steps, stepsBySlot = null, firstOnly = false, attackerName }) {
  const dice = await getDice(targetCharacterId);
  let targets = selectAutoDamageTargets({ effectiveAttackTargets, dice });
  // `firstOnly` is the Successful Block redirect and nothing else: that rule
  // replaces the attack's target with "the blocker's own Stat", singular, and
  // the list it is handed is the blocker's whole Roll rather than a move's
  // authored Attack Target. Spreading the leftover across every Stat the
  // blocker happens to roll would be a different rule nobody asked for.
  if (firstOnly) targets = targets.slice(0, 1);
  if (!targets.length) return [];
  const character = await getCharacter(targetCharacterId);
  const applied = [];

  for (const die of targets) {
    const own = stepsBySlot ? stepsBySlot[die.slot_name] ?? 0 : steps;
    if (!(own > 0)) continue;
    let next = {
      current_size: die.current_size,
      bonus: die.bonus,
      status: die.status,
      half_damage: Boolean(die.half_damage),
    };
    for (let i = 0; i < own; i++) next = applyHalfDamage(next);
    await run('UPDATE dice SET current_size = ?, bonus = ?, status = ?, half_damage = ? WHERE id = ?', [
      next.current_size,
      next.bonus,
      next.status,
      next.half_damage ? 1 : 0,
      die.id,
    ]);
    io.emit('die:updated', diePayload({ ...die, ...next, half_damage: next.half_damage ? 1 : 0 }));
    // Before/after are carried out so the cutscene can animate the die
    // actually stepping down on the target's card, and so a replay watched
    // later shows the same step — by then the die is at a completely
    // different size (§0's self-contained rule).
    applied.push({
      slotName: die.slot_name,
      steps: own,
      character,
      sizeBefore: die.current_size,
      bonusBefore: die.bonus,
      statusBefore: die.status,
      sizeAfter: next.current_size,
      bonusAfter: next.bonus,
      statusAfter: next.status,
    });
  }

  // One sentence for the whole attack rather than one per Stat: a move that
  // hits three Stats would otherwise fill the log with three near-identical
  // lines for a single blow.
  if (character && applied.length) {
    const each = applied.map((a) => `${a.steps * 0.5} damage to ${a.slotName}`);
    const list = each.length === 1 ? each[0] : `${each.slice(0, -1).join(', ')} and ${each[each.length - 1]}`;
    await postSystemMessage(
      io,
      `${character.name} took ${list}${attackerName ? ` from ${attackerName}` : ''}.`
    );
  }
  return applied;
}

// Steps one named Stat by `steps` half-damage steps (negative steps it back
// up). Shares applyAutoDamage's machinery, but targets a Stat the move's
// author named rather than one the Attack Target rules picked — this is
// what lets an authored On Hit say "and it wrecks their Right Hand" without
// a human applying it afterwards. Emits the same damage_applied shape so
// the cutscene's fighter cards animate it identically.
async function stepStat(io, { characterId, slotName, steps, emitEvent, tic, characterName }) {
  const dice = await getDice(characterId);
  const die = dice.find((d) => d.slot_name === slotName);
  if (!die) return false;
  let next = {
    current_size: die.current_size,
    bonus: die.bonus,
    status: die.status,
    half_damage: Boolean(die.half_damage),
  };
  for (let i = 0; i < Math.abs(steps); i++) {
    next = steps > 0 ? applyHalfDamage(next) : stepDie({ ...next, status: next.status }, 'up');
  }
  await run('UPDATE dice SET current_size = ?, bonus = ?, status = ?, half_damage = ? WHERE id = ?', [
    next.current_size,
    next.bonus,
    next.status,
    next.half_damage ? 1 : 0,
    die.id,
  ]);
  io.emit('die:updated', diePayload({ ...die, ...next, half_damage: next.half_damage ? 1 : 0 }));
  if (emitEvent && tic != null) {
    // **Its own event type, not `damage_applied` (bugfix).** A stat step is
    // signed: positive damages, negative steps the Stat back UP. Borrowing the
    // damage event made the log narrate a step up as "−1 steps of damage to
    // Stamina" — reported as "stat stepping looks weird" — and left the step
    // masquerading as an anonymous hit with no attacker and no move behind it,
    // duplicating the `automation_fired` line that already described it
    // properly. `stat_stepped` says what actually happened, in both directions,
    // and the cutscene animates it as the Stat moving rather than as a blow
    // landing.
    await emitEvent(tic, 'stat_stepped', {
      characterId,
      characterName: characterName ?? null,
      slotName,
      // Signed, deliberately: the direction is the whole point, and the
      // renderer picks its wording from it rather than from a separate flag
      // that could disagree.
      steps,
      sizeBefore: die.current_size,
      bonusBefore: die.bonus,
      statusBefore: die.status,
      sizeAfter: next.current_size,
      bonusAfter: next.bonus,
      statusAfter: next.status,
    });
  }
  return true;
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

  // The whole footprint and display identity come along, not just the ids:
  // an Interrupted move is deleted below, so by the time anything reads this
  // event — a live cutscene a beat later, or a replay days later — the row it
  // describes no longer exists to be looked up (§0's self-contained rule).
  // The move's NAME is deliberately not among them; see the emit below.
  const startupDM = await one(
    `SELECT dm.*, m.stamina_cost, m.roll_type, m.custom_roll_size, m.roll_modifier,
            m.active_tics, m.recovery_tics, m.defense_frame_positions,
            ch.name AS character_name, ch.character_type, cp.side AS side
     FROM declared_moves dm
     JOIN moves m ON m.id = dm.move_id
     JOIN characters ch ON ch.id = dm.character_id
     LEFT JOIN combat_participants cp ON cp.character_id = dm.character_id
     WHERE dm.id = ?`,
    [eligible.declaredMoveId]
  );
  if (!startupDM) return;
  const [rollSlotRows, rollBonusRow] = await Promise.all([
    all('SELECT slot_name, count FROM move_roll_slots WHERE move_id = ?', [startupDM.move_id]),
    one(
      'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
      [targetCharacterId, startupDM.move_id]
    ),
  ]);
  const bonus = computeInterruptBonus({ revealTic: attackerRevealTic, currentTic: eligible.tic });
  // The move being interrupted is the one rolling, so its Combat Style is
  // the one that joins the matchup here.
  const bonusMods = await getCombatRollBonus(targetCharacterId, { moveId: startupDM.move_id, tic });
  const mod = bonus + bonusMods + startupDM.roll_modifier + rollBonusRow.bonus;

  // Decision #8: the interrupted character rolls their own Startup move's
  // Roll if it has one, otherwise Body (generic toughness) instead of
  // skipping the check.
  let die;
  if (startupDM.roll_type === 'custom' && startupDM.custom_roll_size != null) {
    die = { slot_name: 'Custom', current_size: startupDM.custom_roll_size, bonus: 0 };
  } else if (rollSlotRows.length) {
    const dice = await resolveMoveRollDice(targetCharacterId, expandRollSlotRows(rollSlotRows), startupDM.appendage_choice);
    die = dice[0] ?? null;
  }
  if (!die) {
    const bodyDice = await getDice(targetCharacterId);
    die = bodyDice.find((d) => d.slot_name === 'Body' && d.status === 'active') ?? null;
  }
  if (!die) return;

  // The die's own line carries face + its own bonus; the shared modifier is
  // applied once, to the roll (rollTotal in gameLogic.js). `result` is what
  // the mechanic below compares against, so it is the total, not the face.
  const face = rollDie(die.current_size) + (die.bonus ?? 0);
  const dice = [{ slot_name: die.slot_name, size: die.current_size, bonus: die.bonus ?? 0, result: face }];
  const result = rollTotal(dice, mod);
  await logRoll(io, {
    characterId: targetCharacterId,
    characterName: startupDM.character_name,
    modifier: mod,
    dice,
  });

  // (Needs confirmation, per the plan's own 4.4 note): threshold assumed to
  // be `roll >= damage taken` — the attack's own halfDamageSteps, threaded
  // in by the caller (this only ever runs once damage is about to land).
  const interrupted = result >= halfDamageSteps;
  const activeEndTic = startupDM.reveal_tic + startupDM.active_tics;
  await emitEvent(tic, 'interrupt_resolved', {
    startupDeclaredMoveId: startupDM.id,
    // Also under the key every other footprint-bearing event uses, so the
    // cutscene can key this move's bar the same way it keys a reveal's.
    declaredMoveId: startupDM.id,
    interrupted,
    result,
    halfDamageSteps,
    characterId: startupDM.character_id,
    characterName: startupDM.character_name,
    characterType: startupDM.character_type,
    side: startupDM.side,
    // The footprint the move WOULD have had, so the cutscene can draw the
    // Tics it had reserved and strike them out. Without this an Interrupted
    // move left no trace at all on the board: it dies in Startup, so it
    // never reveals, so it never got a bar in the first place — the log
    // announced an Interruption of something nobody had ever seen.
    placementTic: startupDM.placement_tic,
    revealTic: startupDM.reveal_tic,
    activeEndTic,
    recoveryEndTic: activeEndTic + startupDM.recovery_tics + (startupDM.recovery_extension_tics ?? 0),
    defenseFramePositions: JSON.parse(startupDM.defense_frame_positions ?? '[]'),
    // NO moveName, deliberately. An Interrupted move never reached its
    // reveal Tic, and Combat Timing's secrecy rule makes a move public at
    // that Tic and not before — being destroyed early is not a reveal. The
    // timing was always public (footprints ride combat:updated to everyone
    // regardless of reveal state); the identity stays the owner's. The
    // cutscene labels the struck-out bar "Interrupted" instead.
  });
  if (!interrupted) return;

  await run('DELETE FROM declared_moves WHERE id = ?', [startupDM.id]);
  const refund = startupDM.stamina_committed ? Math.trunc(startupDM.stamina_cost / 2) : 0;
  if (refund) await adjustStamina(io, startupDM.character_id, refund, { emitEvent, tic, reason: 'interrupt-refund' });
  await postSystemMessage(
    io,
    refund
      ? `${startupDM.character_name}'s move was Interrupted — ${refund} Stamina refunded.`
      : `${startupDM.character_name}'s move was Interrupted.`
  );
}

// A move carrying the **No Damage Tag** resolving against its target. It has
// no damage to apply and no Interruption to check (Interruption is gated on
// damage actually having been dealt), so the only question left is whether
// the roll reached the move's own **Success Threshold**.
//
// **Success fires On Hit.** The move connected and did what it was for — the
// same reasoning that makes Insignificant Damage fire On Hit rather than On
// Miss, and the reason a No Damage move is worth authoring at all: On Hit is
// where its automations hang.
//
// **Failure fires nothing** (flagged in vttprojectplan.md, not invented here).
// On Miss would be wrong — the ruleset is explicit that a Miss is an attack
// the target *evaded*, which means a successful Dodge and nothing else. A
// grab that closed on empty air was not dodged; it just wasn't good enough.
// If the table wants a trigger for that, it wants a new one.
async function resolveNoDamage(io, {
  declaredMoveId,
  moveId,
  attackerCharacterId,
  attackerCharacterName,
  result,
  targetCharacterId,
  tic,
  emitEvent,
}) {
  const move = await one('SELECT name, success_threshold FROM moves WHERE id = ?', [moveId]);
  const { threshold, succeeded } = resolveNoDamageOutcome({
    result,
    successThreshold: move?.success_threshold ?? DEFAULT_SUCCESS_THRESHOLD,
  });
  const moveName = move?.name ?? 'attack';

  await postSystemMessage(
    io,
    succeeded
      ? `${attackerCharacterName}'s ${moveName} succeeded — rolled ${result} against a Threshold of ${threshold}. It deals no damage.`
      : `${attackerCharacterName}'s ${moveName} failed — rolled ${result}, short of its Threshold of ${threshold}.`
  );
  // Names and numbers, not ids (§0's self-contained-payload rule): a replay
  // months from now has to read without any live combat state to look up.
  await emitEvent(tic, 'no_damage_resolved', {
    declaredMoveId,
    characterId: attackerCharacterId,
    characterName: attackerCharacterName,
    moveName,
    total: result,
    threshold,
    succeeded,
  });

  // Set on BOTH paths. processTic re-selects any revealed move still at
  // interactions_resolved = 0 forever, so a branch that returns without
  // setting it hangs the round — see resolveAttack's own bookkeeping.
  const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [declaredMoveId]);
  if (dm && !dm.interactions_resolved) {
    await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [declaredMoveId]);
    if (succeeded) {
      await applyMoveInteractions(io, {
        moveId,
        trigger: 'hit',
        emitEvent,
        tic,
        selfCharacterId: attackerCharacterId,
        selfDeclaredMoveId: declaredMoveId,
        opponentCharacterId: targetCharacterId,
      });
    }
  }
}

// Applies damage + the Interruption check for one attacking move landing on
// one target character — shared by the plain-Hit path, the Failed-defense
// fallback, a Successful Block/Dodge's own reduced damage, and (Phase D)
// the Dodge-resolved resume path, so all four apply damage/fire 'hit'/
// check-interrupt identically instead of four near-copies.
async function runInterruptAndDamage(io, {
  declaredMoveId,
  moveId,
  attackerCharacterId,
  attackerCharacterName,
  attackerResult,
  targetCharacterId,
  effectiveAttackTargets,
  steps,
  // Per-Stat figures, when the defence was resolved Stat by Stat (decided,
  // new — see resolveAttack's defence loop). Null means "the same `steps`
  // everywhere", which is every undefended path.
  stepsBySlot = null,
  // Successful Block redirect only — see applyAutoDamage.
  firstOnly = false,
  attackActiveStart,
  attackerActiveTics,
  tic,
  emitEvent,
  effectiveResult,
}) {
  // The No Damage Tag (decided, new — the second Tag automation). Checked
  // FIRST, ahead of Insignificant Damage, because the two would otherwise
  // both claim the same weak roll and the wrong one would win: a No Damage
  // move that came up short did not do "insignificant damage", it *failed*,
  // and it fires nothing.
  //
  // This is the one funnel every damaging path in the engine goes through, so
  // suppressing damage here suppresses it everywhere — the plain Hit, a
  // Failed defence, a Partial Block's leftovers, and the Dodge resume path
  // alike, with no fifth near-copy to keep in step.
  //
  // A **Full** Block or Dodge never reaches this function at all (the caller
  // skips it at 0 steps and fires `block`/`miss` itself), which is the right
  // answer for a No Damage move too: the defender stopped it, and that is a
  // different outcome from failing to reach the threshold on your own.
  const attackerTagNames = await moveTagNamesFor(attackerCharacterId, moveId);
  if (carriesNoDamageTag(attackerTagNames)) {
    await resolveNoDamage(io, {
      declaredMoveId,
      moveId,
      attackerCharacterId,
      attackerCharacterName,
      // What the move actually brought to bear, after any defence took its
      // cut — not the raw roll. A shove that was half-blocked has half as
      // much left to reach the threshold with, exactly as it would have had
      // half as much damage. Defaults to the raw result for the undefended
      // paths, which pass no reduced figure because nothing reduced it.
      result: effectiveResult ?? attackerResult,
      targetCharacterId,
      tic,
      emitEvent,
    });
    return;
  }

  // Insignificant Damage (decided, revised) — an attack that landed and did
  // too little to matter.
  //
  // **It is never a Miss.** A Miss is an attack the target *evaded*, which
  // means exactly one thing: a successful Dodge (applySuccessfulDodge fires
  // `miss`). A weak swing still connected, so it fires the move's own
  // **On Hit** — the trigger that matches what actually happened — and never
  // On Miss.
  //
  // **It is decided here, not before defence resolution.** This check used
  // to sit in resolveAttack immediately after the attacker's roll and
  // `return` outright, which skipped target selection and the whole defence
  // step: a sub-5 attack could not be blocked or dodged at all, so On Block,
  // On Successful Defense and On Failed Defense never fired against one, and
  // a defender who had correctly timed a guard saw nothing happen. An
  // insignificant attack now runs the identical flow as any other and only
  // reaches this point once it has actually landed — undefended, or through
  // a defence that failed.
  //
  // It deliberately never reaches applyAutoDamage: stepping a die zero times
  // rewrites the row unchanged and posts "took 0 damage to Body", which
  // reads as a bug rather than as a rule.
  if (steps === 0) {
    // The move's name isn't threaded through every caller (the Dodge resume
    // path rebuilds its arguments from persisted JSON), and this is the only
    // branch that needs it — so it's fetched here rather than added to a
    // payload that would then have to migrate.
    const move = await one('SELECT name FROM moves WHERE id = ?', [moveId]);
    const moveName = move?.name ?? null;
    await postSystemMessage(
      io,
      `${attackerCharacterName}'s ${moveName ?? 'attack'} did insignificant damage (rolled ${attackerResult}).`
    );
    await emitEvent(tic, 'insignificant_damage', {
      declaredMoveId,
      characterId: attackerCharacterId,
      characterName: attackerCharacterName,
      moveName,
      total: attackerResult,
    });
    const weak = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [declaredMoveId]);
    if (weak && !weak.interactions_resolved) {
      await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [declaredMoveId]);
      await applyMoveInteractions(io, {
        moveId,
        trigger: 'hit',
        emitEvent,
        tic,
        selfCharacterId: attackerCharacterId,
        selfDeclaredMoveId: declaredMoveId,
        opponentCharacterId: targetCharacterId,
      });
    }
    // No Interruption check either — checkInterrupt is gated on damage
    // actually having been applied, and none was.
    return;
  }

  const applied = await applyAutoDamage(io, {
    targetCharacterId,
    effectiveAttackTargets,
    steps,
    stepsBySlot,
    firstOnly,
    attackerName: attackerCharacterName,
  });
  // Names, not just ids: the cutscene log states outcomes as sentences now,
  // and a replay must be readable without any live combat state to look them
  // up in (§0's self-contained-payload rule).
  const target = await getCharacter(targetCharacterId);
  // **One event per damaged Stat**, rather than one event carrying a list: the
  // cutscene already animates a `damage_applied` as a single die stepping down
  // on the target's card, so a multi-Stat attack plays as several beats with no
  // change to the client at all — and a stored replay keeps the same shape it
  // has always had (§0).
  //
  // An attack that landed on nothing still emits one blank event, exactly as
  // before, so the log says the blow arrived and found nowhere to land.
  for (const hit of applied.length ? applied : [null]) {
    await emitEvent(tic, 'damage_applied', {
      declaredMoveId,
      targetCharacterId,
      targetCharacterName: target?.name ?? null,
      attackerCharacterName,
      slotName: hit?.slotName ?? null,
      steps: hit?.steps ?? steps,
      sizeBefore: hit?.sizeBefore ?? null,
      bonusBefore: hit?.bonusBefore ?? null,
      sizeAfter: hit?.sizeAfter ?? null,
      bonusAfter: hit?.bonusAfter ?? null,
      statusAfter: hit?.statusAfter ?? null,
    });
  }
  const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [declaredMoveId]);
  if (dm && !dm.interactions_resolved) {
    await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [declaredMoveId]);
    await applyMoveInteractions(io, {
      moveId,
      trigger: 'hit',
      emitEvent,
      tic,
      selfCharacterId: attackerCharacterId,
      selfDeclaredMoveId: declaredMoveId,
      opponentCharacterId: targetCharacterId,
    });
  }
  // One Interruption check for the blow, not one per Stat — being hit in two
  // places at once is still one blow, and the check reads the total damage
  // taken. Uses the heaviest Stat's figure, which is `steps` in every case
  // except a per-Stat defence that held better in one place than another.
  if (applied.length) {
    await checkInterrupt(io, {
      targetCharacterId,
      attackerRevealTic: attackActiveStart,
      attackerActiveTics,
      halfDamageSteps: Math.max(...applied.map((a) => a.steps)),
      emitEvent,
      tic,
    });
  }
}

// Writes the Dodge pause and raises the prompt for whichever Stat is next in
// line. Shared by the first pause and by every re-pause resolveDodge makes as
// it works down `remainingStats`, so the two can never drift into asking
// different questions.
//
// `targetSlotName` is null for a move with no Attack Target of its own — one
// question about the attack as a whole, which is what a Dodge prompt has always
// been.
async function persistDodgePause(io, { pairIndex, pending, emitEvent, resolutionId = null }) {
  const targetSlotName = pending.remainingStats?.[0] ?? null;
  await run(
    resolutionId != null
      ? `UPDATE pair_round_resolutions SET status = 'paused_dodge', pending_dodge_json = ? WHERE id = ?`
      : `UPDATE pair_round_resolutions SET status = 'paused_dodge', pending_dodge_json = ?
         WHERE pair_index = ? AND status = 'running'`,
    [JSON.stringify(pending), resolutionId != null ? resolutionId : pairIndex]
  );
  await emitEvent(pending.tic, 'dodge_prompt', {
    attackerDeclaredMoveId: pending.attackerDeclaredMoveId,
    attackerCharacterName: pending.attackerCharacterName,
    attackerMoveName: pending.attackerMoveName ?? null,
    defenderDeclaredMoveId: pending.defenderDeclaredMoveId,
    defenderCharacterName: pending.defenderCharacterName ?? null,
    defenderMoveName: pending.defenderMoveName ?? null,
    attackerResult: pending.attackerResult,
    // Which line of attack this particular question is about, and how many are
    // still to come after it — so the GM can see they are part-way through a
    // multi-Stat attack rather than being asked the same thing twice.
    targetSlotName,
    remainingStats: pending.remainingStats ?? [],
  });
}

// Which of a move's Attack Target Stats this particular target can actually be
// hit in — the same list applyAutoDamage will damage, resolved up front so the
// defence can be settled one Stat at a time against it (decided, new).
//
// Empty for a move with no Attack Target of its own: nothing is being attacked
// by name, so there is exactly one line of attack and the defence is resolved
// once, as it always was.
async function attackedStatsOf(targetCharacterId, effectiveAttackTargets) {
  if (!effectiveAttackTargets?.length) return [];
  const dice = await getDice(targetCharacterId);
  return selectAutoDamageTargets({ effectiveAttackTargets, dice }).map((d) => d.slot_name);
}

// A Failed defense (too-early coverage for either kind, or Dodge's own
// too-short-has-no-partial-case rule) — falls straight through to a plain
// Hit, exactly as if there'd been no Defense Frame at all. Shared by the
// live path and (Phase D) the Dodge-resolved resume path.
async function applyFailedDefense(io, {
  defenderDM,
  defenseLabel,
  attackerDeclaredMoveId,
  attackerMoveId,
  attackerCharacterId,
  attackerCharacterName,
  attackerResult,
  targetCharacterId,
  effectiveAttackTargets,
  halfDamageSteps,
  // Per-Stat figures when the defence was answered Stat by Stat — a Dodge that
  // got clear of one line and not the other (decided, new).
  stepsBySlot = null,
  attackActiveStart,
  attackerActiveTics,
  tic,
  emitEvent,
}) {
  await postSystemMessage(io, `${defenderDM.character_name}'s ${defenseLabel} has failed.`);
  await applyMoveInteractions(io, {
    moveId: defenderDM.move_id,
    trigger: 'defense_failure',
    emitEvent,
    tic,
    selfCharacterId: defenderDM.character_id,
    selfDeclaredMoveId: defenderDM.id,
    opponentCharacterId: attackerCharacterId,
    opponentDeclaredMoveId: attackerDeclaredMoveId,
  });
  await runInterruptAndDamage(io, {
    declaredMoveId: attackerDeclaredMoveId,
    moveId: attackerMoveId,
    attackerCharacterId,
    attackerCharacterName,
    attackerResult,
    targetCharacterId,
    effectiveAttackTargets,
    steps: halfDamageSteps,
    stepsBySlot,
    attackActiveStart,
    attackerActiveTics,
    tic,
    emitEvent,
  });
}

// A Successful Dodge. **Dodge is binary (decided, revised — this replaces the
// original "identical math and identical interaction-firing rules to Block").**
//
// You either get out of the way or you don't. Once the GM answers Successful,
// the attack does not land: no damage, no roll-off, no Partial. There is no
// third outcome, and "the dodge covered only part of the attack" is not one —
// that is a *failed* dodge, and `classifyDefenseCoverage` already routes it
// there ('too-short' is auto-Failed for Dodge, no prompt).
//
// What this used to do, and why both halves were wrong: it rolled the
// defender's dice, ran `resolveDefenseRoll` (Block's opposed math), and on
// anything short of out-rolling the attacker produced a "Partial Dodge" that
// put damage through *and* fired the attacker's **On Block** trigger. So a
// dodge the GM had just called successful could both hurt the dodger and fire
// the wrong interaction. Block keeps that math — a guard genuinely absorbs
// part of a hit — but a dodge has nothing to absorb with.
//
// **No defender roll at all.** With no partial case the roll cannot change the
// outcome, and leaving it in would show a contest in the log that decides
// nothing — exactly the kind of phantom mechanic that made "Partial Dodge"
// unexplainable at the table.
//
// Only ever reached from the Phase D resume path (resolveDodge below) — a
// Block is never paused, so its Successful path stays inline in resolveAttack.
async function applySuccessfulDodge(io, {
  defenderDM,
  attackerDeclaredMoveId,
  attackerMoveId,
  attackerCharacterId,
  tic,
  emitEvent,
}) {
  // No round_event of its own: `resolveDodge` already emitted
  // `dodge_resolved` for both outcomes before branching here, and the cutscene
  // narrates it ("The GM called the Dodge Successful") with a MISS burst.
  // Emitting a second one would double-log the same fact.
  await postSystemMessage(io, `${defenderDM.character_name} dodged it — no damage.`);

  await applyMoveInteractions(io, {
    moveId: defenderDM.move_id,
    trigger: 'defense_success',
    emitEvent,
    tic,
    selfCharacterId: defenderDM.character_id,
    selfDeclaredMoveId: defenderDM.id,
    opponentCharacterId: attackerCharacterId,
    opponentDeclaredMoveId: attackerDeclaredMoveId,
  });

  const attackerDM = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [attackerDeclaredMoveId]);
  if (attackerDM && !attackerDM.interactions_resolved) {
    await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [attackerDeclaredMoveId]);
    // **Always On Miss, never On Block.** A Miss is an attack evaded with a
    // Dodge, and a successful Dodge is the only thing in the game that
    // evades — so this is still the single source of 'miss', it just no
    // longer has a branch that can pick 'block' instead. Exactly one trigger
    // fires per attack; they all hang off interactions_resolved.
    await applyMoveInteractions(io, {
      moveId: attackerMoveId,
      trigger: 'miss',
      emitEvent,
      tic,
      selfCharacterId: attackerCharacterId,
      selfDeclaredMoveId: attackerDeclaredMoveId,
      opponentCharacterId: defenderDM.character_id,
      opponentDeclaredMoveId: defenderDM.id,
    });
  }
}

// Resolves one revealed attacking move's full consequences (§2.2 steps
// 2-8): auto-roll, target-character selection, defense-move auto-
// selection, Block/Dodge/Hit branching, and the Interruption check. `row`
// is one entry from the enriched revealed-rows query in processTic below.
// Returns `{ paused: true }` if this move hit a genuine pause point (a
// full-coverage Dodge) — the caller (processTic) must stop processing this
// pair's Tic immediately when it sees this, without marking the Tic done.
// Roll one move's dice for one character and log it, returning the total.
// Extracted because a grapple rolls twice — the grappler's move and the
// target's Resist Roll — and both must go through the same modifier stack and
// the same chat/timeline logging the attack roll already uses, or a grapple's
// dice would quietly obey different rules from everyone else's.
// Every named piece a roll's single `modifier` number is made of, in reading
// order, zeroes dropped. Carried on the roll event so the cutscene log can lay
// the total out as terms rather than as one figure nobody can account for —
// which is what a Combat Style looked like before it had a name attached
// (decided, new). `modifier` itself is unchanged and still the whole sum, so
// every existing consumer (the chat roll card above all) is untouched.
function rollModifierBreakdown({ rollModifier = 0, moveRollBonus = 0, terms = [], chainRollBonus = 0 }) {
  return [
    { key: 'move', label: "The move's own modifier", amount: rollModifier ?? 0 },
    { key: 'move_bonus', label: 'Perk bonus on this move', amount: moveRollBonus ?? 0 },
    ...terms,
    // The grapple read is not one of the always-on bonuses — it belongs to this
    // one declared move and rides the total separately (see chain_roll_bonus) —
    // so it is appended here rather than coming out of getCombatRollBonus.
    { key: 'chain', label: 'Read on the grab', amount: chainRollBonus ?? 0 },
  ].filter((t) => t.amount !== 0);
}

async function rollFor(io, { characterId, characterName, moveId, moveName, slotNames, rollType, customRollSize, rollModifier, appendageChoice, tic, declaredMoveId, emitEvent, defensive = false, chainRollBonus = 0 }) {
  const hasRoll = rollType === 'custom' ? customRollSize != null : slotNames.length > 0;
  if (!hasRoll) return { total: 0, dice: [], mod: 0 };

  const [rollBonusRow, bonus] = await Promise.all([
    one(
      'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
      [characterId, moveId]
    ),
    getCombatRollBonusBreakdown(characterId, { moveId, tic }),
  ]);
  const mod = (rollModifier ?? 0) + rollBonusRow.bonus + bonus.total;
  const modifierBreakdown = rollModifierBreakdown({
    rollModifier,
    moveRollBonus: rollBonusRow.bonus,
    terms: bonus.terms,
    chainRollBonus,
  });

  let dice;
  if (rollType === 'custom') {
    dice = [{ slot_name: 'Custom', size: customRollSize, bonus: 0, result: rollDie(customRollSize) }];
  } else {
    const resolved = await resolveMoveRollDice(characterId, slotNames, appendageChoice);
    dice = resolved.map((d) => ({
      slot_name: d.slot_name,
      size: d.current_size,
      bonus: d.bonus,
      result: rollDie(d.current_size) + d.bonus,
    }));
  }
  // The chain swing rides the total, once, exactly as resolveAttack applies it
  // (see declared_moves.chain_roll_bonus). Kept out of `mod` so the cutscene can
  // still show the ±5 as its own line rather than folding it into the move's own
  // modifier; the arithmetic is identical either way.
  const total = rollTotal(dice, mod + chainRollBonus);
  await logRoll(io, { characterId, characterName, modifier: mod, dice });
  await emitEvent(tic, 'roll', {
    declaredMoveId,
    characterId,
    characterName,
    moveName,
    dice,
    modifier: mod,
    total,
    chainRollBonus,
    modifierBreakdown,
    ...(defensive ? { defensive: true, defenseType: 'resist' } : {}),
  });
  return { total, dice, mod };
}

// A grab, start to finish (Grappling — see vttprojectplan.md).
//
// **It never enters the attack flow.** A grapple has no damage to apply, no
// Interruption to check and no Block to resolve — it has a contest, and the
// contest decides one thing: does the chained move happen.
//
// Order matters and is the reason this lives before the roll rather than
// after it: the direction mini-game (G5) has to run *before* anyone rolls, so
// the read happens on a blind grab rather than on a number both sides can
// already see. G4 stubs the mini-game to "skipped" — nobody guesses, nobody
// gets ±5 — and the shape around it is already the shape G5 fills in.
async function resolveGrapple(io, { row, pairIndex, tic, emitEvent }) {
  const done = async () => {
    const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [row.declaredMoveId]);
    if (dm && !dm.interactions_resolved) {
      await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [row.declaredMoveId]);
      return true;
    }
    return false;
  };

  const targetCharacterId = await selectTargetCharacter({
    pairIndex,
    side: row.side,
    allowedConcreteTargets: parseConcreteAttackTargets(row.effectiveAttackTargets),
  });
  if (targetCharacterId == null) {
    // Nobody on the other side to grab. Still terminal for this move —
    // processTic re-selects anything left at interactions_resolved = 0 forever.
    await done();
    return;
  }
  const target = await getCharacter(targetCharacterId);
  const targetName = target?.name ?? 'their opponent';

  const attackActiveStart = row.revealTic;
  const attackActiveEnd = row.revealTic + row.activeTics;

  // **Dodge can evade a grapple; Block cannot** (decided). A Block is not
  // consulted at all — you cannot guard your way out of being grabbed, you
  // have to not be there. A Dodge has to cover the whole grab, the same
  // 'full' coverage an ordinary Dodge needs; anything less and the grab
  // closes anyway.
  //
  // Note this never pauses for the GM the way an ordinary full Dodge does.
  // The grapple's own contest is the roll that decides it, so there is
  // nothing left for a human to call.
  const defenderMoveRows = await all(
    `SELECT dm.id AS declaredMoveId, dm.placement_tic AS placementTic,
            m.defense_frame_positions AS defenseFramePositions, m.defense_kind AS defenseKind,
            m.name AS moveName
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
     WHERE dm.character_id = ? ORDER BY dm.queue_order`,
    [targetCharacterId]
  );
  const dodgeMoves = defenderMoveRows
    .filter((r) => r.defenseKind === 'dodge')
    .map((r) => ({
      declaredMoveId: r.declaredMoveId,
      placementTic: r.placementTic,
      moveName: r.moveName,
      defenseFramePositions: JSON.parse(r.defenseFramePositions ?? '[]'),
    }));
  const dodgeMatch = selectDefenseMove({
    defenderMoves: dodgeMoves,
    attackActiveStart,
    attackActiveEnd,
  });
  const dodgeCoverage = dodgeMatch
    ? classifyDefenseCoverage({ attackActiveStart, attackActiveEnd, defenseTics: dodgeMatch.defenseTics })
    : null;

  if (dodgeCoverage?.coverage === 'full') {
    const evaded = dodgeMoves.find((m) => m.declaredMoveId === dodgeMatch.declaredMoveId);
    await postSystemMessage(
      io,
      `${targetName} slips out of ${row.characterName}'s ${row.moveName} — the grab closes on nothing.`
    );
    await emitEvent(tic, 'grapple_resolved', {
      declaredMoveId: row.declaredMoveId,
      characterId: row.characterId,
      characterName: row.characterName,
      moveName: row.moveName,
      targetCharacterId,
      targetCharacterName: targetName,
      success: false,
      reason: 'dodged',
      dodgeMoveName: evaded?.moveName ?? null,
    });
    // A Dodge that evades is a Miss, and a Miss is exactly this: an attack
    // the target got out of the way of (see applySuccessfulDodge).
    if (await done()) {
      await applyMoveInteractions(io, {
        moveId: row.moveId,
        trigger: 'miss',
        emitEvent,
        tic,
        selfCharacterId: row.characterId,
        selfDeclaredMoveId: row.declaredMoveId,
        opponentCharacterId: targetCharacterId,
      });
    }
    return;
  }

  // **The contest happens FIRST now (decided, revised).** It used to run the
  // direction mini-game before any dice, on the theory that the read should be
  // made on a blind grab. In play that meant the grappler was asked to commit
  // to a follow-up before knowing whether the grab even worked, and the ±5
  // decided the grab itself. The order is now the one the fight actually has:
  // find out if you have them, and only then choose what to do with them.
  const contest = await runGrappleContest(io, { row, targetCharacterId, targetName, tic, emitEvent });

  if (!contest.success) {
    // **Nothing to undo.** No follow-up was created and no placement shifted —
    // a failed grab leaves the round exactly as it found it, and fires nothing.
    await done();
    return;
  }

  // Both of these are owed the moment the grab lands, independent of whatever
  // follow-up comes next — so they happen before any prompt, and a chain that
  // ends in "nothing" still leaves the hold and its interactions intact.
  //
  // The −2 window is set only AFTER the contest, so the Resist Roll above was
  // unpenalised: the grab hadn't landed yet when it was rolled.
  const penaltyUntilTic = grapplePenaltyWindowEnd({ revealTic: row.revealTic, activeTics: row.activeTics });
  if (penaltyUntilTic != null) {
    await run('UPDATE combat_participants SET grapple_penalty_until_tic = ? WHERE character_id = ?', [
      penaltyUntilTic,
      targetCharacterId,
    ]);
  }
  if (await done()) {
    await applyMoveInteractions(io, {
      moveId: row.moveId,
      trigger: 'grapple_success',
      emitEvent,
      tic,
      selfCharacterId: row.characterId,
      selfDeclaredMoveId: row.declaredMoveId,
      opponentCharacterId: targetCharacterId,
    });
  }

  const directionRows = await loadFollowUps(row.moveId);
  if (!directionRows.length) return; // a grab that chains into nothing by design

  const [grapplerChar, ownedMoveIds] = await Promise.all([
    getCharacter(row.characterId),
    ownedMoveIdsFor(row.characterId),
  ]);
  const annotated = annotateFollowUps(directionRows, {
    ownedMoveIds,
    currentStamina: grapplerChar?.current_stamina ?? 0,
  });

  // **`shouldRunMiniGame` now gates only the GUESS**, not whether the grappler
  // is asked. The grappler always chooses their own follow-up (that is the new
  // flow); what a single direction or an all-NPC pair removes is the *read* —
  // there is nothing to guess between one option, and the GM would be guessing
  // against themselves. Without a guess there is no ±5.
  const guessRuns = shouldRunMiniGame({
    assignedDirectionCount: directionRows.length,
    grapplerIsNpc: grapplerChar?.character_type === 'npc',
    targetIsNpc: target?.character_type === 'npc',
  });

  // An all-NPC grapple is never prompted at all — the GM would be answering
  // both halves — so it takes the first available direction and chains.
  if (grapplerChar?.character_type === 'npc' && target?.character_type === 'npc') {
    const auto = annotated.find((d) => d.available) ?? null;
    if (auto) await chainFollowUp(io, { row, moveId: auto.moveId, chainRollBonus: 0, tic, emitEvent });
    return;
  }

  await run(
    `UPDATE pair_round_resolutions SET status = 'paused_grapple', pending_grapple_json = ?
     WHERE pair_index = ? AND status = 'running'`,
    [
      JSON.stringify({
        // 'choice' first, then 'guess' — two sequential pauses rather than one
        // simultaneous two-party wait. The grappler answers, then the defender
        // is asked; the defender still sees blank arrows, so sequencing costs
        // them no information beyond knowing a pick has been made.
        phase: 'choice',
        guessRuns,
        grapplerDeclaredMoveId: row.declaredMoveId,
        grapplerCharacterId: row.characterId,
        grapplerCharacterName: row.characterName,
        grapplerMoveName: row.moveName,
        targetCharacterId,
        targetCharacterName: targetName,
        directions: annotated.map((d) => ({
          direction: d.direction,
          moveId: d.moveId,
          moveName: d.moveName,
          staminaCost: d.staminaCost,
          available: d.available,
          reason: d.reason,
        })),
        tic,
        grapplerChoice: null,
        targetGuess: null,
      }),
      pairIndex,
    ]
  );
  // Carries NO move names: round_events are replayed to everyone, and a replay
  // that leaked the options would give the mini-game away to anyone scrubbing
  // back through it.
  await emitEvent(tic, 'grapple_prompt', {
    declaredMoveId: row.declaredMoveId,
    characterName: row.characterName,
    moveName: row.moveName,
    targetCharacterName: targetName,
    directionCount: directionRows.length,
    availableCount: annotated.filter((d) => d.available).length,
  });
  await postSystemMessage(
    io,
    `${row.characterName}'s ${row.moveName} has ${targetName} — waiting on ${row.characterName} to pick where it goes.`
  );
  return { paused: true };
}

// A grapple's authored follow-ups, with everything the availability rules and
// the prompt need. Ordered by DIRECTIONS via assignedDirections, so the cross
// always renders the same way round.
async function loadFollowUps(grappleMoveId) {
  return assignedDirections(
    await all(
      `SELECT gd.direction, gd.target_move_id AS targetMoveId, m.name AS targetMoveName,
              m.stamina_cost AS staminaCost, m.is_default AS isDefault
       FROM move_grapple_directions gd JOIN moves m ON m.id = gd.target_move_id
       WHERE gd.move_id = ?`,
      [grappleMoveId]
    )
  ).map((d) => ({
    direction: d.direction,
    moveId: d.targetMoveId,
    moveName: d.targetMoveName,
    staminaCost: d.staminaCost ?? 0,
    isDefault: d.isDefault ?? 0,
  }));
}

// Which non-Default moves this character actually has. Default moves are
// available to everyone and are handled by annotateFollowUps' own isDefault
// check, so they deliberately aren't listed here.
async function ownedMoveIdsFor(characterId) {
  return (await all('SELECT move_id FROM character_moves WHERE character_id = ?', [characterId])).map(
    (r) => r.move_id
  );
}

// Look the chosen move up and put it on the board. Split out because it is
// reached three ways — an all-NPC auto-chain, a resumed pick with a guess, and
// a resumed pick without one — and all three must place it identically.
async function chainFollowUp(io, { row, moveId, chainRollBonus, tic, emitEvent }) {
  const chained = await one('SELECT id, name FROM moves WHERE id = ?', [moveId]);
  if (!chained) return null;
  return declareChainedMove(io, { row, chained, tic, emitEvent, chainRollBonus });
}

// Everything after the mini-game: the two rolls, the contest, and what a win
// does. Split out because it is reached two ways — straight through when no
// mini-game runs, and from resumeGrapple once both answers are in — and the
// contest must be identical either way.
async function runGrappleContest(io, { row, targetCharacterId, targetName, tic, emitEvent }) {
  // Both rolls, grappler then target. The target's Resist Roll is authored on
  // the GRAPPLING move, not on anything the target declared — a headlock and
  // an ankle pick are resisted with different Stats, and which one you are in
  // is the grappler's choice, not yours.
  const grapplerRoll = await rollFor(io, {
    characterId: row.characterId,
    characterName: row.characterName,
    moveId: row.moveId,
    moveName: row.moveName,
    slotNames: row.rollSlotNames,
    rollType: row.rollType,
    customRollSize: row.customRollSize,
    rollModifier: row.rollModifier,
    appendageChoice: row.appendageChoice,
    tic,
    declaredMoveId: row.declaredMoveId,
    emitEvent,
    // **A grapple chained off a won grapple keeps its ±5 (bugfix).** Every
    // ordinary follow-up got this through resolveAttack, but a follow-up that
    // is itself a Grappling move never enters the attack flow — it comes
    // straight here — so the read the defender just made on the first grab
    // silently evaporated on the second one. Reading a grab right has to make
    // the grab that follows harder, or the mini-game stops meaning anything the
    // moment a chain goes grapple-into-grapple.
    chainRollBonus: row.chainRollBonus ?? 0,
  });

  const resistSlots = expandRollSlotRows(
    await all('SELECT slot_name, count FROM move_resist_roll_slots WHERE move_id = ?', [row.moveId])
  );
  // An empty Resist Roll is legal and means the target cannot contest the grab
  // at all (decided) — it then only has to clear its own Threshold.
  const targetRoll = resistSlots.length
    ? await rollFor(io, {
        characterId: targetCharacterId,
        characterName: targetName,
        moveId: row.moveId,
        moveName: `resisting ${row.moveName}`,
        slotNames: resistSlots,
        rollType: 'stat',
        customRollSize: null,
        rollModifier: 0,
        appendageChoice: null,
        tic,
        declaredMoveId: row.declaredMoveId,
        emitEvent,
        defensive: true,
      })
    : { total: 0 };

  // No guessOutcome: the read hasn't happened yet and no longer touches this.
  const contest = resolveGrappleContest({
    grapplerTotal: grapplerRoll.total,
    targetTotal: targetRoll.total,
    successThreshold: row.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD,
  });

  await postSystemMessage(
    io,
    contest.success
      ? `${row.characterName}'s ${row.moveName} takes hold of ${targetName} — ${contest.grapplerFinal} against ${contest.targetFinal}.`
      : contest.reason === 'below-threshold'
        ? `${row.characterName}'s ${row.moveName} never closes — rolled ${contest.grapplerFinal}, short of ${row.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD}.`
        : `${targetName} muscles out of ${row.characterName}'s ${row.moveName} — ${contest.targetFinal} against ${contest.grapplerFinal}.`
  );
  await emitEvent(tic, 'grapple_resolved', {
    declaredMoveId: row.declaredMoveId,
    characterId: row.characterId,
    characterName: row.characterName,
    moveName: row.moveName,
    targetCharacterId,
    targetCharacterName: targetName,
    grapplerTotal: contest.grapplerFinal,
    targetTotal: contest.targetFinal,
    threshold: row.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD,
    success: contest.success,
    reason: contest.reason,
  });

  // Direction, follow-up and ±5 are deliberately absent from this event: none
  // of them exist yet. They arrive on grapple_guessed / grapple_chained.
  return contest;
}

// Puts the won direction's move into the grappler's own queue, immediately
// after the grab's footprint, pushing anything they had queued there forward.
//
// **Not `move:declare`.** That handler hard-rejects a pair mid-resolution, and
// rightly so — this is the engine declaring on the grappler's behalf, which is
// a different act from a player choosing during the declaration phase.
//
// **Only ever called on a grapple that has already won**, so every write here
// is terminal: there is no half-created move to roll back and no original
// placement to restore. Stamina is charged now rather than committed and
// refunded, for the same reason — there is no failure path left to refund on.
async function declareChainedMove(io, { row, chained, tic, emitEvent, chainRollBonus = 0 }) {
  const move = await one(
    'SELECT startup_tics, active_tics, recovery_tics, stamina_cost, attack_targets FROM moves WHERE id = ?',
    [chained.id]
  );
  if (!move) return null;

  // **The chain ends by itself when it cannot be paid for (decided.)** Checked
  // here rather than only at the prompt, because the prompt's affordability
  // read happens before this move's own Stamina has been charged — in a long
  // chain each link spends, so the last affordable-looking link can stop being
  // affordable by the time it is reached.
  const grappler = await getCharacter(row.characterId);
  const cost = move.stamina_cost ?? 0;
  if (cost > 0 && (grappler?.current_stamina ?? 0) - cost < 0) {
    await postSystemMessage(
      io,
      `${row.characterName} has hold of them but nothing left to spend — ${chained.name} never comes.`
    );
    await emitEvent(tic, 'grapple_chain_ended', {
      sourceDeclaredMoveId: row.declaredMoveId,
      characterId: row.characterId,
      characterName: row.characterName,
      moveName: chained.name,
      reason: 'unaffordable',
      staminaNeeded: cost,
      staminaHeld: grappler?.current_stamina ?? 0,
    });
    return null;
  }

  const footprint = move.startup_tics + move.active_tics + move.recovery_tics;
  const grappleEnd = row.revealTic + row.activeTics; // Recovery is the grappler's own to spend

  // Only moves that have not yet revealed may be shifted — one already
  // resolved is a fact, not a plan.
  const laterMoves = (
    await all(
      `SELECT dm.id AS declaredMoveId, dm.placement_tic AS placementTic,
              (m.startup_tics + m.active_tics + m.recovery_tics) AS footprintTics
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
       WHERE dm.character_id = ? AND dm.reveal_posted = 0 AND dm.placement_tic >= ?`,
      [row.characterId, grappleEnd]
    )
  ).map((r) => ({ ...r }));

  const { placementTic, shifted } = planChainPlacement({
    grappleFootprintEnd: grappleEnd,
    chainedFootprintTics: footprint,
    laterMoves,
  });
  for (const s of shifted) {
    await run('UPDATE declared_moves SET placement_tic = ?, reveal_tic = reveal_tic + ? WHERE id = ?', [
      s.to,
      s.to - s.from,
      s.declaredMoveId,
    ]);
  }

  const pairRound = await one(
    `SELECT pr.round_number AS roundNumber, dm.queue_order AS queueOrder
     FROM declared_moves dm
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     JOIN combat_pairs pr ON pr.pair_index = cp.pair_index
     WHERE dm.id = ?`,
    [row.declaredMoveId]
  );

  const result = await run(
    `INSERT INTO declared_moves
       (character_id, move_id, round_number, placement_tic, reveal_tic, queue_order,
        stamina_committed, reveal_posted, interactions_resolved, effective_attack_targets,
        grapple_source_declared_move_id, chain_roll_bonus)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`,
    [
      row.characterId,
      chained.id,
      pairRound?.roundNumber ?? 1,
      placementTic,
      placementTic + move.startup_tics,
      (pairRound?.queueOrder ?? 0) + 1,
      move.attack_targets ?? '[]',
      row.declaredMoveId,
      chainRollBonus,
    ]
  );

  if (move.stamina_cost) {
    await adjustStamina(io, row.characterId, -move.stamina_cost, {
      emitEvent,
      tic,
      reason: `chained ${chained.name}`,
    });
  }

  await emitEvent(tic, 'grapple_chained', {
    declaredMoveId: Number(result.lastInsertRowid),
    sourceDeclaredMoveId: row.declaredMoveId,
    characterId: row.characterId,
    characterName: row.characterName,
    moveName: chained.name,
    placementTic,
    revealTic: placementTic + move.startup_tics,
    shifted: shifted.length,
    chainRollBonus,
  });
  // The declaration is now on the board and everyone sees it as a Tell, the
  // same as any declared move — the only difference is that it arrived
  // mid-resolution rather than during Declaration. Returned so the caller can
  // tell "chained" from "chain ended".
  return { declaredMoveId: Number(result.lastInsertRowid), placementTic };
}

// Which character on the other side this move is coming for. Shared by the
// attack flow and the grapple flow so both pick the same person by the same
// rule (decision #6: deterministic under Uneven Combat, trivial at 1v1).
//
// A move with no Attack Target of its own still needs someone: for an attack
// that is how a Successful Block's "replace the target with the blocker's own
// Stat" rule is ever reached, and for a grapple it is the normal case, since
// a grab takes a *person* rather than a Stat. Both fall back to the lowest
// character_id among the opponents.
async function selectTargetCharacter({ pairIndex, side, allowedConcreteTargets }) {
  const opposingSide = side === 'left' ? 'right' : 'left';
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
  const candidates = [...candidatesByChar.entries()].map(([characterId, dice]) => ({ characterId, dice }));
  if (allowedConcreteTargets.length === 0) {
    return candidates.map((c) => c.characterId).sort((a, b) => a - b)[0] ?? null;
  }
  return selectUnevenCombatTarget({ candidates, allowedConcreteTargets });
}

async function resolveAttack(io, { row, pairIndex, tic, emitEvent }) {
  // Grappling (decided) — a grab is not an attack and does not run the attack
  // flow. It is resolved entirely by resolveGrapple and returns here, so none
  // of the damage/defence machinery below ever sees it.
  //
  // Checked FIRST, ahead of even the defence-pure and Roll-less guards: a
  // grappling move with no Roll still has a contest to lose (it rolls 0 and
  // fails its Threshold), and one that is also Defensive is still a grab.
  if (row.isGrappling) {
    // Propagates `{ paused: true }` when the mini-game takes a pause, exactly
    // as the Dodge branch below does. Without it processTic keeps walking the
    // Tic's remaining moves, re-selects this grapple (still
    // interactions_resolved = 0), prompts a second time and then finishes the
    // round straight through the pause.
    return await resolveGrapple(io, { row, pairIndex, tic, emitEvent });
  }

  // A Defensive move with no Attack Target is defence-pure: it exists to be
  // *selected as a defender* when someone attacks into it (step 4 below,
  // driven by the attacker's own resolution), and it never attacks on its
  // own account. It must not run the attack flow at all — doing so rolled
  // it a second time (it already rolls as part of the attacker's Block
  // resolution) and then reported "no eligible target", which is exactly
  // the spurious notification a pure block used to produce. Having no
  // Attack Target is the *correct* authoring for such a move, not an
  // oversight, so this is a normal outcome and says nothing to chat.
  //
  // A Defensive move that DOES carry Attack Targets is a counter-attack —
  // it defends and attacks — and falls through to the normal flow.
  const attackTargets = parseConcreteAttackTargets(row.effectiveAttackTargets);
  if (row.isDefensive && attackTargets.length === 0) {
    await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [row.declaredMoveId]);
    return;
  }

  const hasRoll = row.rollType === 'custom' ? row.customRollSize != null : row.rollSlotNames.length > 0;
  if (!hasRoll) {
    // A Roll-less move never enters the damage/defense flow (see Attack
    // Target mechanic) — trivially "resolved" (nothing more will ever
    // happen for it), so it must be marked done here too, or processTic's
    // own "still unresolved" query below would keep re-selecting it on
    // every future Tic for the rest of combat.
    await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [row.declaredMoveId]);
    return;
  }

  // Step 2 — auto-roll the attacker's own move.
  const [rollBonusRow, bonus] = await Promise.all([
    one(
      'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
      [row.characterId, row.moveId]
    ),
    getCombatRollBonusBreakdown(row.characterId, { moveId: row.moveId, tic }),
  ]);
  const mod = row.rollModifier + rollBonusRow.bonus + bonus.total;
  let dice;
  if (row.rollType === 'custom') {
    dice = [{ slot_name: 'Custom', size: row.customRollSize, bonus: 0, result: rollDie(row.customRollSize) }];
  } else {
    const resolved = await resolveMoveRollDice(row.characterId, row.rollSlotNames, row.appendageChoice);
    dice = resolved.map((d) => ({
      slot_name: d.slot_name,
      size: d.current_size,
      bonus: d.bonus,
      result: rollDie(d.current_size) + d.bonus,
    }));
  }
  // The chain swing rides the same total-level rule every modifier now
  // follows (rollTotal in gameLogic.js) — added once to the summed roll. It
  // is kept out of `mod` only so the ±5 stays its own line in the cutscene
  // rather than disappearing into the move's own modifier; the arithmetic is
  // identical either way now that `mod` is total-level too. (It had to be
  // separate when `mod` was applied per die: a ±5 in there paid out per die
  // and a three-die follow-up was worth ±15.) Non-zero only on a move the
  // engine declared retroactively off a won grapple (see
  // declared_moves.chain_roll_bonus).
  const chainRollBonus = row.chainRollBonus ?? 0;
  const total = rollTotal(dice, mod + chainRollBonus);
  await logRoll(io, { characterId: row.characterId, characterName: row.characterName, modifier: mod, dice });
  // characterName rides along for the same §0 reason every other payload
  // carries one: the cutscene names the roller in its own sentence, and a
  // replay has no live combat state left to look the id up in.
  await emitEvent(tic, 'roll', {
    declaredMoveId: row.declaredMoveId,
    characterId: row.characterId,
    characterName: row.characterName,
    moveName: row.moveName,
    dice,
    modifier: mod,
    total,
    // Surfaced so the cutscene can show the swing as its own line rather than
    // leaving the sum looking like arithmetic that doesn't add up — the same
    // defect the Reasons to Fight modifier had before it was passed through.
    chainRollBonus,
    modifierBreakdown: rollModifierBreakdown({
      rollModifier: row.rollModifier,
      moveRollBonus: rollBonusRow.bonus,
      terms: bonus.terms,
      chainRollBonus,
    }),
  });

  // A sub-5 roll is Insignificant Damage, and that is decided at the END of
  // this flow, not here (see runInterruptAndDamage). This used to bail out
  // on the spot, which meant a weak attack skipped target selection and the
  // whole defence step: it could not be blocked or dodged at all, so no
  // On Block / On Successful Defense / On Failed Defense ever fired against
  // one, and a defender who timed a guard correctly watched nothing happen.
  // An insignificant attack is still an attack and runs the identical flow;
  // only what it does on landing differs.
  const { halfDamageSteps } = computeHitDamage(total);

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
  const allowedConcreteTargets = attackTargets;
  const candidates = [...candidatesByChar.entries()].map(([characterId, dice]) => ({ characterId, dice }));
  // An attack with no Attack Target of its own is still a real attack (see
  // the Attack Target mechanic): a Successful Block replaces its effective
  // target with the blocker's own Stat, which is the documented way such a
  // move ever lands. Selecting by die-eligibility would return null here
  // and bail before defence resolution ever ran, making that rule
  // unreachable and silently skipping the Block entirely — so fall back to
  // the same deterministic "lowest character_id among opponents" rule
  // decision #6 uses, and let defence decide what happens next.
  const targetCharacterId =
    allowedConcreteTargets.length === 0
      ? (candidates.map((c) => c.characterId).sort((a, b) => a - b)[0] ?? null)
      : selectUnevenCombatTarget({ candidates, allowedConcreteTargets });
  if (targetCharacterId == null) {
    // Nothing eligible to hit — this move's own resolution is nonetheless
    // complete (nothing more will ever happen for it), so it must still
    // count as done for resume purposes (see processTic below, which only
    // re-attempts moves still interactions_resolved = 0).
    await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [row.declaredMoveId]);
    await emitEvent(tic, 'damage_applied', { declaredMoveId: row.declaredMoveId, result: 'no-eligible-target' });
    return;
  }

  const attackActiveStart = row.revealTic;
  const attackActiveEnd = row.revealTic + row.activeTics;

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
    // A defender who declared a defensive move that simply doesn't reach this
    // attack used to get *nothing at all* — no event, no chat line, the
    // attack just landed. From the table that is indistinguishable from the
    // engine ignoring the Block, which is exactly how it was reported ("Block
    // still does not work; it was not rolled at all"). Placing a Block on the
    // same Tic as the attack is not enough on its own: what matters is where
    // its Defense Frames sit inside its own footprint, and a frame on the
    // Block's Startup square lands a Tic *before* the attacker's Active
    // window opens. Say so, rather than resolving in silence.
    const framed = defenderMoves.filter((m) => m.defenseFramePositions.length > 0);
    if (framed.length) {
      // Tics are quoted the way the Tic Counter labels them — 1-based within
      // the pair's own current round — not as the absolute timeline numbers
      // used internally, which would stop matching the strip from round 2 on.
      const [target, pair] = await Promise.all([
        getCharacter(targetCharacterId),
        one('SELECT round_start_tic AS roundStartTic FROM combat_pairs WHERE pair_index = ?', [pairIndex]),
      ]);
      const label = (t) => t - (pair?.roundStartTic ?? 0) + 1;
      const covered = framed.flatMap((m) => m.defenseFramePositions.map((p) => m.placementTic + p));
      const active = Array.from({ length: attackActiveEnd - attackActiveStart }, (_, i) => attackActiveStart + i);
      await emitEvent(tic, 'defense_resolved', {
        attackerDeclaredMoveId: row.declaredMoveId,
        defenderDeclaredMoveId: null,
        defenseType: null,
        coverage: 'no-overlap',
        defenseTics: covered,
        attackActiveStart,
        attackActiveEnd,
      });
      await postSystemMessage(
        io,
        `${target?.name ?? 'The defender'}'s Defense Frames don't cover ${row.characterName}'s ${row.moveName} ` +
          `(guarding Tic${covered.length === 1 ? '' : 's'} ${covered.map(label).join(', ')}, ` +
          `attack is Active on ${active.map(label).join(', ')}) — no defence.`
      );
    }
    // Step 7 — plain Hit, no defending move at all.
    await runInterruptAndDamage(io, {
      declaredMoveId: row.declaredMoveId,
      moveId: row.moveId,
      attackerCharacterId: row.characterId,
      attackerCharacterName: row.characterName,
      attackerResult: total,
      targetCharacterId,
      effectiveAttackTargets: allowedConcreteTargets,
      steps: halfDamageSteps,
      attackActiveStart,
      attackerActiveTics: row.activeTics,
      tic,
      emitEvent,
    });
    return;
  }

  const defenderDM = await one(
    `SELECT dm.id, dm.character_id, dm.placement_tic, dm.reveal_tic, dm.appendage_choice,
            dm.recovery_extension_tics AS current_extension_tics,
            m.id AS move_id, m.name AS move_name, m.active_tics, m.recovery_tics, m.is_defensive, m.defense_kind,
            m.roll_type, m.custom_roll_size, m.roll_modifier, m.stamina_modifier,
            ch.name AS character_name
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

  const failedDefenseArgs = {
    defenderDM,
    defenseLabel,
    attackerDeclaredMoveId: row.declaredMoveId,
    attackerMoveId: row.moveId,
    attackerCharacterId: row.characterId,
    attackerCharacterName: row.characterName,
    attackerResult: total,
    targetCharacterId,
    effectiveAttackTargets: allowedConcreteTargets,
    halfDamageSteps,
    attackActiveStart,
    attackerActiveTics: row.activeTics,
    tic,
    emitEvent,
  };

  // 'too-early' is auto-Failed for both Block and Dodge — falls straight
  // through to a plain Hit exactly as if there'd been no Defense Frame at
  // all (matches the manual combat:resolve_defense's own force-override).
  if (coverage.coverage === 'too-early') {
    await applyFailedDefense(io, failedDefenseArgs);
    return;
  }

  if (defenderDM.defense_kind === 'dodge') {
    // Decision #2 — the one genuine human decision. 'full' coverage pauses
    // for real: persist enough to resume without re-rolling the attacker
    // (already rolled above); this attacking move's own
    // interactions_resolved stays 0 until resolveDodge (exported below)
    // applies the GM's answer and finishes it.
    if (coverage.coverage === 'full') {
      // **One question per Stat the attack names (decided, new).** A dodge
      // that got the head out of the way did not necessarily get the body out
      // of the way, and asking once for a two-Stat attack silently made the
      // second Stat free. The remaining Stats are carried on the pause and
      // asked for one at a time; resolveDodge re-pauses until the list is
      // empty. A move with no Attack Target is one question, as before.
      const dodgeLines = await attackedStatsOf(targetCharacterId, allowedConcreteTargets);
      await persistDodgePause(io, {
        pairIndex,
        pending: {
          attackerDeclaredMoveId: row.declaredMoveId,
          attackerMoveId: row.moveId,
          attackerCharacterId: row.characterId,
          attackerCharacterName: row.characterName,
          attackerMoveName: row.moveName,
          defenderDeclaredMoveId: defenderDM.id,
          defenderCharacterName: defenderDM.character_name,
          defenderMoveName: defenderDM.move_name,
          attackerResult: total,
          targetCharacterId,
          allowedConcreteTargets,
          halfDamageSteps,
          attackActiveStart,
          attackerActiveTics: row.activeTics,
          tic,
          remainingStats: dodgeLines,
          stepsBySlot: {},
        },
        emitEvent,
      });
      return { paused: true };
    }
    // 'too-short' has no partial case for Dodge — also auto-Failed, no prompt.
    await applyFailedDefense(io, failedDefenseArgs);
    return;
  }

  // defense_kind === 'block', coverage 'full' or 'too-short' — fully
  // automatic (decision #1). Roll the defending move's own Roll (base +
  // defensive pool if is_defensive), same math as the manual
  // combat:resolve_defense.
  const [baseSlotRows, defensiveSlotRows, defRollBonusRow] = await Promise.all([
    all('SELECT slot_name, count FROM move_roll_slots WHERE move_id = ?', [defenderDM.move_id]),
    defenderDM.is_defensive
      ? all('SELECT slot_name, count FROM move_defensive_roll_slots WHERE move_id = ?', [defenderDM.move_id])
      : [],
    one(
      'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
      [defenderDM.character_id, defenderDM.move_id]
    ),
  ]);
  const defBonusMods = await getCombatRollBonus(defenderDM.character_id, { moveId: defenderDM.move_id, tic });
  const defMod = defenderDM.roll_modifier + defRollBonusRow.bonus + defBonusMods;

  // **The guard is rolled once per Stat the attack names (decided, new).** A
  // move that comes at two Stats is two lines of attack, and one roll cannot
  // answer both — asking it to made the second Stat free. Each line gets its
  // own roll, its own outcome, and its own Stamina bill; what gets through on
  // each is added up, and the Successful Block rule below then puts the whole
  // of it onto the arm that held.
  //
  // A move with no Attack Target of its own has no named line to split, so it
  // resolves in exactly one pass, as it always did.
  const blockLines = await attackedStatsOf(targetCharacterId, allowedConcreteTargets);
  const lines = blockLines.length ? blockLines : [null];

  const rollTheGuard = async () => {
    let blockDice;
    if (defenderDM.roll_type === 'custom' && defenderDM.custom_roll_size != null) {
      blockDice = [
        { slot_name: 'Custom', size: defenderDM.custom_roll_size, bonus: 0, result: rollDie(defenderDM.custom_roll_size) },
      ];
    } else {
      const slotNames = expandRollSlotRows([...baseSlotRows, ...defensiveSlotRows]);
      const resolved = await resolveMoveRollDice(defenderDM.character_id, slotNames, defenderDM.appendage_choice);
      blockDice = resolved.map((d) => ({
        slot_name: d.slot_name,
        size: d.current_size,
        bonus: d.bonus,
        result: rollDie(d.current_size) + d.bonus,
      }));
    }
    const blockResult = rollTotal(blockDice, defMod);
    await logRoll(io, {
      characterId: defenderDM.character_id,
      characterName: defenderDM.character_name,
      modifier: defMod,
      dice: blockDice,
    });
    // See the note on the Dodge branch's own roll event: without this the
    // defender's dice never appear on the timeline at all.
    await emitEvent(tic, 'roll', {
      declaredMoveId: defenderDM.id,
      characterId: defenderDM.character_id,
      characterName: defenderDM.character_name,
      dice: blockDice,
      modifier: defMod,
      total: blockResult,
      defensive: true,
      defenseType: defenderDM.defense_kind ?? 'block',
    });
    return blockResult;
  };

  // Block Stamina (decided, new — the Block Tag's automation). A move
  // carrying the **Block Tag** pays no up-front Stamina Cost and instead
  // spends here, for exactly as much of the attack as its guard absorbed,
  // scaled by the move's own Stamina Modifier — and can only hold as much as
  // it can pay for. A defensive move WITHOUT the tag is untouched by all of
  // this and keeps the old flat-cost behaviour: the Tag is the switch, not
  // the Block/Dodge toggle (see server/tagAutomations.js).
  const defenderTagNames = await moveTagNamesFor(defenderDM.character_id, defenderDM.move_id);
  const blockTagged = carriesBlockTag(defenderTagNames);

  let leftoverSteps = 0;
  let leftoverResult = 0;
  for (const line of lines) {
    const blockResult = await rollTheGuard();
    const against = line ? ` against the strike to ${line}` : '';
    let lineOutcome;
    let blockStamina = null;
    if (blockTagged) {
      // Re-read inside the loop: each line's absorption is paid for as it
      // happens, so a guard that spent everything holding the first Stat
      // genuinely has nothing left for the second.
      const blocker = await getCharacter(defenderDM.character_id);
      blockStamina = resolveBlockStamina({
        attackerResult: total,
        defenderResult: blockResult,
        staminaModifier: defenderDM.stamina_modifier ?? 1,
        availableStamina: blocker?.current_stamina ?? 0,
      });
      lineOutcome = blockStamina;
    } else {
      lineOutcome = resolveDefenseRoll({ attackerResult: total, defenderResult: blockResult });
    }
    leftoverSteps += lineOutcome.halfDamageSteps;
    leftoverResult += lineOutcome.netResult ?? 0;

    await postSystemMessage(
      io,
      lineOutcome.outcome === 'full'
        ? `${defenderDM.character_name} scored a Full ${defenseLabel}${against} — no damage.`
        : `${defenderDM.character_name} scored a Partial ${defenseLabel}${against} — ${lineOutcome.damage} damage.`
    );
    if (blockStamina) {
      // Spent after the outcome line so the log reads "what happened, then what
      // it cost". adjustStamina emits its own stamina_changed round_event, so
      // the cutscene animates the drop on the blocker's card without any extra
      // event type here.
      if (blockStamina.staminaCost > 0) {
        await adjustStamina(io, defenderDM.character_id, -blockStamina.staminaCost, {
          emitEvent,
          tic,
          reason: `${defenderDM.move_name} absorbed ${blockStamina.absorbed}`,
        });
      }
      // Only worth a sentence when the guard was actually cut short — otherwise
      // the Stamina line above already says everything.
      if (blockStamina.capped) {
        await postSystemMessage(
          io,
          `${defenderDM.character_name} ran out of Stamina mid-${defenseLabel}${against} — the guard held only ` +
            `${blockStamina.absorbed} of ${Math.min(total, blockResult)}, and the rest got through.`
        );
      }
    }
  }
  // One figure for everything the guard failed to hold, across every line.
  const resolution = {
    halfDamageSteps: leftoverSteps,
    netResult: leftoverResult,
    outcome: leftoverSteps > 0 ? 'partial' : 'full',
  };

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
    emitEvent,
    tic,
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
      emitEvent,
      tic,
      selfCharacterId: row.characterId,
      selfDeclaredMoveId: row.declaredMoveId,
      opponentCharacterId: defenderDM.character_id,
      opponentDeclaredMoveId: defenderDM.id,
    });
  }

  // Apply this Block's own damage (if any) before checking for a
  // downstream conflict — the two concern different declared moves, so
  // ordering between them doesn't matter functionally.
  if (resolution.halfDamageSteps > 0) {
    await runInterruptAndDamage(io, {
      declaredMoveId: row.declaredMoveId,
      moveId: row.moveId,
      attackerCharacterId: row.characterId,
      attackerCharacterName: row.characterName,
      attackerResult: total,
      targetCharacterId: defenderDM.character_id,
      effectiveAttackTargets: blockEffectiveTargets,
      // The redirect names "the blocker's own Stat", singular — see
      // applyAutoDamage's own note on this flag.
      firstOnly: true,
      steps: resolution.halfDamageSteps,
      attackActiveStart,
      attackerActiveTics: row.activeTics,
      tic,
      emitEvent,
      // What got past the guard, which is what a No Damage move has left to
      // reach its Threshold with. The damage steps below already come from
      // this same figure; this only names it for the branch that needs the
      // number rather than the step count.
      effectiveResult: resolution.netResult,
    });
  }

  // 'too-short': extend the blocker's own Recovery to cover the gap, then a
  // real pause (decision #3, kept exactly as Forfeit/Postpone, now driven
  // by this engine's own pause/resume instead of a GM dialog) for the
  // FIRST move it now collides with — matches pending_conflict_json's
  // single-slot shape; a further collision (if any) gets its own turn once
  // resolveMoveConflict (exported below) applies this one and re-checks —
  // the same recursive cascade the original manual
  // combat:resolve_move_conflict already had.
  if (coverage.coverage === 'too-short') {
    const oldRecoveryEndTic =
      defenderDM.reveal_tic + defenderDM.active_tics + defenderDM.recovery_tics + defenderDM.current_extension_tics;
    const newRecoveryEndTic = oldRecoveryEndTic + coverage.extensionTicsNeeded;
    await run('UPDATE declared_moves SET recovery_extension_tics = ? WHERE id = ?', [
      defenderDM.current_extension_tics + coverage.extensionTicsNeeded,
      defenderDM.id,
    ]);
    // Announce it, don't ask (decided). Extending Recovery is a rule, not a
    // choice — decision #1 puts Block fully outside the prompt loop — but it
    // silently changed how long the blocker is committed for, which is
    // exactly the sort of thing a table needs told. The matching
    // round_event gives the cutscene enough to paint those extra Tics in the
    // Block's own colour (see isExtendedRecoveryTic client-side), so the
    // announcement and the timeline agree.
    //
    // Phrased as the success it is. This used to read "blocked late", which
    // told the table a correct Block had gone wrong: catching an attack's
    // opening frame and holding it is exactly how a Block is meant to work,
    // and the extension is the rule doing its job, not a penalty.
    const tics = coverage.extensionTicsNeeded;
    await postSystemMessage(
      io,
      `${defenderDM.character_name}'s ${defenderDM.move_name} catches ${row.characterName}'s ${row.moveName} — ` +
        `Recovery extended by ${tics} Tic${tics === 1 ? '' : 's'} to hold the guard through it.`
    );
    await emitEvent(tic, 'recovery_extended', {
      declaredMoveId: defenderDM.id,
      characterId: defenderDM.character_id,
      characterName: defenderDM.character_name,
      moveName: defenderDM.move_name,
      defenseKind: defenderDM.defense_kind ?? 'block',
      extensionTics: tics,
      // Half-open [extendedFromTic, recoveryEndTic), the same convention
      // phaseAt uses — the client needs both to know which squares are the
      // extension rather than the move's own authored Recovery.
      extendedFromTic: oldRecoveryEndTic,
      recoveryEndTic: newRecoveryEndTic,
      attackerCharacterName: row.characterName,
      attackerMoveName: row.moveName,
    });
    const collision = await one(
      'SELECT id, character_id FROM declared_moves WHERE character_id = ? AND id != ? AND placement_tic >= ? AND placement_tic < ? ORDER BY id LIMIT 1',
      [defenderDM.character_id, defenderDM.id, oldRecoveryEndTic, newRecoveryEndTic]
    );
    if (collision) {
      await run(
        `UPDATE pair_round_resolutions SET status = 'paused_conflict', pending_conflict_json = ?
         WHERE pair_index = ? AND status = 'running'`,
        [
          JSON.stringify({
            declaredMoveId: collision.id,
            blockerDeclaredMoveId: defenderDM.id,
            characterId: collision.character_id,
          }),
          pairIndex,
        ]
      );
      await emitEvent(tic, 'move_conflict_prompt', {
        declaredMoveId: collision.id,
        characterId: collision.character_id,
        blockerDeclaredMoveId: defenderDM.id,
      });
      return { paused: true };
    }
  }
}

// §2.2 — processes one absolute Tic for one pair: reveal, then resolve
// every move that just revealed, then Idle-Tic Stamina Regen. Returns
// `{ paused: true }` the moment any move's resolution hits a genuine pause
// point (see resolveAttack) — the caller (advancePairResolution) must stop
// immediately when it sees this, without marking the Tic done, so a later
// resume call re-enters this SAME Tic rather than skipping ahead.
//
// Resumability (Phase D): revealing a move (reveal_posted) and finishing
// its resolution (interactions_resolved) are tracked as two separate
// steps specifically so a pause-then-resume mid-Tic works correctly —
// re-entering this function after a pause must NOT re-reveal (and
// therefore re-roll/re-post-to-chat) a move that already revealed on an
// earlier call this same Tic, but it MUST still resolve any of this Tic's
// revealed moves that a prior call didn't get to before pausing. The
// "which moves still need resolving" query below (reveal_posted = 1 AND
// interactions_resolved = 0) covers exactly that — see resolveAttack's own
// interactions_resolved bookkeeping for why every one of its return paths
// leaves that flag in a state this query can trust.
// A declared move that hasn't reached its reveal Tic yet is already on the
// board — the wind-up is happening, everyone at the table can see the
// fighter loading something up — but until this event existed the cutscene
// drew nothing at all for it, so a move simply materialised out of empty
// space at its reveal Tic with no build-up.
//
// The payload deliberately carries ONLY the character and two Tics. No
// moveId, no name, and no Active/Recovery lengths: the client renders the
// Startup window and a `???`, and there is nothing else in the stored row
// to leak. That is stronger than sending the whole footprint and asking the
// client to hide most of it, which is what a replay — public to anyone,
// decision #11 — would otherwise be carrying around.
//
// `alreadyEmitted` is the idempotency guard. `processTic` is re-entrant by
// design: a pause on one move's defence lands mid-Tic and the resume
// re-enters the same Tic, which would otherwise post a second wind-up for
// every other move that started on it.
async function emitWindups(emitEvent, anchorTic, rows, alreadyEmitted) {
  for (const r of rows) {
    if (alreadyEmitted.has(r.id)) continue;
    alreadyEmitted.add(r.id);
    await emitEvent(anchorTic, 'windup', {
      declaredMoveId: r.id,
      characterId: r.character_id,
      characterName: r.character_name,
      characterType: r.character_type,
      side: r.side,
      placementTic: r.placement_tic,
      revealTic: r.reveal_tic,
    });
  }
}

// Every declared move this resolution has already announced as a wind-up.
async function emittedWindupIds(resolutionId) {
  const rows = await all("SELECT payload FROM round_events WHERE resolution_id = ? AND type = 'windup'", [
    resolutionId,
  ]);
  return new Set(rows.map((r) => JSON.parse(r.payload).declaredMoveId));
}

async function processTic(io, { pairIndex, tic, emitEvent, resolutionId }) {
  // Anyone whose wind-up starts on this exact Tic. Emitted before the
  // reveals below so a 0-Startup move — placed and revealed on the same
  // Tic — is filtered out by `reveal_tic > tic` rather than flashing a
  // `???` for one beat and immediately replacing it.
  const starting = await all(
    `SELECT dm.id, dm.character_id, dm.placement_tic, dm.reveal_tic,
            ch.name AS character_name, ch.character_type, cp.side AS side
     FROM declared_moves dm
     JOIN characters ch ON ch.id = dm.character_id
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     WHERE cp.pair_index = ? AND dm.reveal_posted = 0
       AND dm.placement_tic = ? AND dm.reveal_tic > ?`,
    [pairIndex, tic, tic]
  );
  if (starting.length) {
    await emitWindups(emitEvent, tic, starting, await emittedWindupIds(resolutionId));
  }

  const toReveal = await all(
    `SELECT dm.id FROM declared_moves dm
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     WHERE dm.reveal_posted = 0 AND dm.reveal_tic <= ? AND cp.pair_index = ?`,
    [tic, pairIndex]
  );
  if (toReveal.length) {
    const ids = toReveal.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    await run(`UPDATE declared_moves SET reveal_posted = 1 WHERE id IN (${marks})`, ids);
    // Deliberately does NOT post a lane_snapshot chat card here the way
    // server/index.js's still-current postMoveReveals does for the manual
    // flow: chat:lane_snapshot's per-reveal spam is explicitly slated for
    // removal in favor of a once-per-round round_summary card (§1.5/§4.2,
    // this overhaul's removal list) — wiring the soon-to-be-removed
    // mechanism into the new engine now, only to tear it back out again in
    // Phase E, isn't worth it. round_events (below) is this engine's own
    // event log and the only reveal record it produces so far.
    // The reveal event carries the move's whole footprint and display
    // identity, not just its ids — this is what makes a stored replay
    // self-contained (§0: the client plays back a log it did not compute,
    // and a replay watched days later must render identically to the live
    // cutscene without re-deriving anything from current combat state,
    // which by then describes a completely different round).
    const revealRows = await all(
      `SELECT dm.id, dm.character_id, dm.move_id, dm.placement_tic, dm.reveal_tic,
              dm.recovery_extension_tics, dm.appendage_choice,
              m.name AS move_name, m.active_tics, m.recovery_tics, m.defense_frame_positions,
              m.is_defensive, m.defense_kind, m.stamina_cost,
              ch.name AS character_name, ch.character_type,
              cp.side AS side
       FROM declared_moves dm
       JOIN moves m ON m.id = dm.move_id
       JOIN characters ch ON ch.id = dm.character_id
       LEFT JOIN combat_participants cp ON cp.character_id = dm.character_id
       WHERE dm.id IN (${marks})`,
      ids
    );
    for (const r of revealRows) {
      const activeEndTic = r.reveal_tic + r.active_tics;
      await emitEvent(tic, 'reveal', {
        declaredMoveId: r.id,
        characterId: r.character_id,
        characterName: r.character_name,
        characterType: r.character_type,
        side: r.side,
        moveId: r.move_id,
        moveName: r.move_name,
        appendageChoice: r.appendage_choice,
        isDefensive: Boolean(r.is_defensive),
        defenseKind: r.defense_kind,
        // What this move cost to declare. Carried on the reveal so the
        // cutscene can flash it as the move comes out — and so a replay
        // watched later still knows it, per §0's self-contained rule (the
        // move's stamina_cost could be edited in the Compendium afterwards).
        staminaCost: r.stamina_cost ?? 0,
        placementTic: r.placement_tic,
        revealTic: r.reveal_tic,
        activeEndTic,
        recoveryEndTic: activeEndTic + r.recovery_tics + (r.recovery_extension_tics ?? 0),
        defenseFramePositions: JSON.parse(r.defense_frame_positions ?? '[]'),
      });
    }
  }

  const toResolve = await all(
    `SELECT dm.id AS declaredMoveId, dm.character_id AS characterId, dm.move_id AS moveId,
            dm.placement_tic AS placementTic, dm.reveal_tic AS revealTic,
            dm.appendage_choice AS appendageChoice, dm.effective_attack_targets AS effectiveAttackTargets,
            dm.chain_roll_bonus AS chainRollBonus,
            m.name AS moveName, m.active_tics AS activeTics, m.roll_type AS rollType,
            m.is_defensive AS isDefensive, m.is_grappling AS isGrappling,
            m.success_threshold AS successThreshold,
            m.custom_roll_size AS customRollSize, m.roll_modifier AS rollModifier,
            cp.side AS side, ch.name AS characterName
     FROM declared_moves dm
     JOIN moves m ON m.id = dm.move_id
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     JOIN characters ch ON ch.id = dm.character_id
     WHERE dm.reveal_posted = 1 AND dm.interactions_resolved = 0 AND dm.reveal_tic <= ? AND cp.pair_index = ?
     ORDER BY dm.id`,
    [tic, pairIndex]
  );
  if (toResolve.length) {
    const moveIds = [...new Set(toResolve.map((r) => r.moveId))];
    const moveMarks = moveIds.map(() => '?').join(',');
    const slotRows = await all(`SELECT move_id, slot_name, count FROM move_roll_slots WHERE move_id IN (${moveMarks})`, moveIds);
    const rollSlotsByMove = new Map();
    for (const r of slotRows) {
      if (!rollSlotsByMove.has(r.move_id)) rollSlotsByMove.set(r.move_id, []);
      rollSlotsByMove.get(r.move_id).push(...expandRollSlotRows([r]));
    }

    for (const row of toResolve) {
      const result = await resolveAttack(io, {
        row: { ...row, rollSlotNames: rollSlotsByMove.get(row.moveId) ?? [] },
        pairIndex,
        tic,
        emitEvent,
      });
      if (result?.paused) return { paused: true };
    }
  }

  await applyIdleTicStaminaRegen(io, pairIndex, tic, emitEvent);
  return { paused: false };
}

// Mirrors server/index.js's applyIdleTicStaminaRegen (see that function's
// own comment for the full Idle-Tic Stamina Regen rule) — duplicated here
// for the same import-safety reason as this module's other primitives.
async function applyIdleTicStaminaRegen(io, pairIndex, tic, emitEvent = null) {
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
    // Idle regen was the last Stamina movement with no trace in the round
    // log at all — the cutscene's fighter cards would drift below the real
    // value over a quiet round. `stamina_regen` already had a label and a
    // narration client-side waiting for an emitter.
    if (emitEvent) {
      await emitEvent(tic, 'stamina_regen', {
        characterId: character.id,
        characterName: character.name,
        amount: newStamina - character.current_stamina,
        currentStamina: newStamina,
        maxStamina: character.max_stamina,
      });
    }
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
    // "Fresh" (decided, new) gates the full restore, same as
    // combat:next_round's own copy in server/index.js. Off by default, so a
    // pair's first round starts on whatever Stamina they were carrying.
    const combatState = await one('SELECT fresh_start FROM combat_state WHERE id = 1');
    if (combatState?.fresh_start) {
      for (const character of charRows) {
        if (character.current_stamina !== character.max_stamina) {
          await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [character.max_stamina, character.id]);
          io.emit('character:updated', { ...character, current_stamina: character.max_stamina });
        }
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
    // Reasons to Fight AND the Stance matchup both apply to an Initiative
    // roll — the matchup is defined as "behaves exactly like Reasons to
    // Fight", so it rides along wherever that does.
    //
    // **This is a bugfix.** There are two copies of the Initiative roll —
    // combat:next_round in server/index.js opens a fight's first round, this
    // one opens every round after it — and only the first had learned the
    // Stance matchup. From round 2 on, a fighter's stance advantage silently
    // stopped counting toward who declares first. Both now read the same
    // helpers, so the next modifier added to one cannot go missing from the
    // other.
    const modifier =
      (p.reasons_to_fight || 0) +
      (await getStanceMatchupBonus(p.character_id, { includeMoveStyles: false })) -
      computeInitiativeOverflowPenalty({
        blockedUntilTic: blockedUntilByChar.get(p.character_id) ?? null,
        nextRoundStartTic,
      });
    const brainDice = [
      { slot_name: 'Brain', size: die.current_size, bonus: die.bonus, result: rollDie(die.current_size) + die.bonus },
    ];
    const result = rollTotal(brainDice, modifier);
    rolls[p.side].push({
      characterId: character.id,
      roll: result,
      currentBrain: die.current_size + die.bonus,
      lockedBrain: die.locked_size + die.locked_bonus,
      hasSpeedStance: hasSpeedStance(character),
    });
    await logRoll(io, { characterId: character.id, characterName: character.name, modifier, dice: brainDice });
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

// §1.5 — the once-per-pair-per-round chat card that replaces
// chat:lane_snapshot's per-reveal spam, posted exactly once as a pair's
// resolution flips to 'complete'. It carries only what the card itself
// renders ("Watch Round N between X and Y") plus the resolutionId the
// replay endpoint keys off; the events themselves are NOT copied into the
// payload, so a later replay and the live cutscene are guaranteed to be the
// same round_events rows by construction rather than two representations
// kept in sync.
//
// Unfiltered broadcast, unlike the round_events above: by the time this
// posts, the round is fully-resolved public history, and the replay is
// explicitly watchable by anyone (decision #11) — including players who
// weren't in this fight.
async function postRoundSummary(io, { pairIndex, roundNumber, resolutionId }) {
  const rows = await all(
    `SELECT cp.side AS side, ch.name AS name
     FROM combat_participants cp JOIN characters ch ON ch.id = cp.character_id
     WHERE cp.pair_index = ? ORDER BY cp.id`,
    [pairIndex]
  );
  const payload = {
    pairIndex,
    roundNumber,
    resolutionId,
    leftNames: rows.filter((r) => r.side === 'left').map((r) => r.name),
    rightNames: rows.filter((r) => r.side === 'right').map((r) => r.name),
  };
  await run(
    `INSERT INTO chat_log (kind, character_id, dice_rolled, payload) VALUES ('round_summary', ?, '[]', ?)`,
    [GM_CHAT_SENTINEL_ID, JSON.stringify(payload)]
  );
  io.emit('chat:round_summary', { kind: 'round_summary', ...payload, timestamp: new Date().toISOString() });
}

// §3 — who is entitled to watch this pair's cutscene: always the GM, and a
// Player only when their own character is seated in this pair. A direct
// extension of server/index.js's isRevealedToViewer, scoped to *pair
// membership* rather than *move ownership*. No further per-event redaction
// is needed on top of this: every round_event fires at-or-after its own
// move's reveal_tic, so anyone entitled to watch this pair at all is
// entitled to every event in its log.
//
// Fails closed — a socket that hasn't sent identity:set yet sees nothing,
// rather than falling back to a broadcast. This is a secrecy boundary, and
// an unidentified connection has no claim to any pair's fight.
function emitToPairAudience(io, seatedCharacterIds, event, payload) {
  for (const viewerSocket of io.sockets.sockets.values()) {
    const viewer = viewerSocket.data?.identity;
    if (!viewer) continue;
    if (viewer.role === 'gm' || (viewer.role === 'player' && seatedCharacterIds.has(viewer.characterId))) {
      viewerSocket.emit(event, payload);
    }
  }
}

function emitToGMs(io, event, payload) {
  for (const viewerSocket of io.sockets.sockets.values()) {
    if (viewerSocket.data?.identity?.role === 'gm') viewerSocket.emit(event, payload);
  }
}

// Builds this resolution's own emitEvent(tic, type, payload) closure —
// shared by advancePairResolution (continuing the loop) and
// resolveDodge/resolveMoveConflict below (posting the resume's own event
// outside the loop) so both persist to the same round_events sequence and
// broadcast the same shape. seq picks up from whatever's already stored,
// so calling this fresh each time (rather than holding one instance across
// a pause) is safe.
async function makeEmitEvent(io, resolution, pairIndex, roundNumber) {
  const [seqRow, seatedRows] = await Promise.all([
    one('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM round_events WHERE resolution_id = ?', [resolution.id]),
    all('SELECT character_id FROM combat_participants WHERE pair_index = ?', [pairIndex]),
  ]);
  let seq = seqRow.maxSeq;
  // Read once per advancePairResolution call rather than per event — a
  // pair's seating cannot change while it's mid-resolution (seating is a
  // Declaration-phase action), and this is on the hot path of every Tic.
  const seatedIds = new Set(seatedRows.map((r) => r.character_id));

  return async (tic, type, payload) => {
    seq += 1;
    await run(
      `INSERT INTO round_events (resolution_id, pair_index, round_number, seq, tic, type, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [resolution.id, pairIndex, roundNumber, seq, tic, type, JSON.stringify(payload)]
    );
    const envelope = {
      pairIndex,
      roundNumber,
      resolutionId: resolution.id,
      seq,
      tic,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };
    emitToPairAudience(io, seatedIds, 'combat:round_event', envelope);
    // §3 — the Dodge prompt additionally goes to every GM socket
    // unconditionally, regardless of which pair that GM happens to be
    // watching: it's a blocking decision only they can make, so it has to
    // reach them wherever they are in the app (the client delivers it
    // through CombatHeaderBar's global dialog queue). Sent from here, off
    // the single dodge_prompt round_event, so the stored log and the live
    // prompt can never disagree about what's being asked.
    if (type === 'dodge_prompt') {
      emitToGMs(io, 'combat:dodge_prompt', { ...envelope.payload, resolutionId: resolution.id, pairIndex, roundNumber, tic });
    }
    // The move-conflict prompt keeps its pre-overhaul event name, payload
    // shape and delivery (decision #3): a plain broadcast that the client
    // filters down to whoever actually controls the affected character
    // (see CombatHeaderBar's own ownership gate). Unlike the Dodge prompt
    // this is the *affected player's* call, not the GM's, and the engine is
    // now its only source — the manual path that used to emit it went away
    // with combat:resolve_defense.
    if (type === 'move_conflict_prompt') {
      io.emit('combat:move_conflict', {
        declaredMoveId: payload.declaredMoveId,
        blockerDeclaredMoveId: payload.blockerDeclaredMoveId,
        characterId: payload.characterId,
      });
    }
  };
}

// §2.1 — the resumable stepper. Idempotent and re-entrant: safe to call
// redundantly (a no-op unless this pair is actually mid-Resolving), and
// picks up from resolved_through_tic on every call rather than assuming
// it's starting fresh. Returns (without doing anything) while genuinely
// paused — resolveDodge/resolveMoveConflict below are the only way past a
// pending decision; both call this again once they've applied it.
async function advancePairResolution(pairIndex, io) {
  const pair = await one('SELECT * FROM combat_pairs WHERE pair_index = ?', [pairIndex]);
  if (!pair || pair.phase !== 'resolving') return;

  const state = await one('SELECT round_length, fight_number FROM combat_state WHERE id = 1');
  const roundLength = state.round_length;
  // Finished fights leave their completed resolutions behind so their
  // replays stay watchable (see server/db.js's fight_number migration), and
  // a new fight restarts each pair at round 1 — so "this pair's round N" is
  // only unambiguous within the current fight.
  const fightNumber = state.fight_number ?? 1;

  const findResolution = () =>
    one('SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND round_number = ? AND fight_number = ?', [
      pairIndex,
      pair.round_number,
      fightNumber,
    ]);

  let resolution = await findResolution();
  const isNewResolution = !resolution;
  if (!resolution) {
    await run(
      `INSERT INTO pair_round_resolutions
         (pair_index, round_number, fight_number, round_start_tic, round_length, status, resolved_through_tic)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      [pairIndex, pair.round_number, fightNumber, pair.round_start_tic, roundLength, pair.round_start_tic - 1]
    );
    resolution = await findResolution();
  }
  // §2.1: nothing to do while genuinely paused — only resolveDodge/
  // resolveMoveConflict (below) may advance past a pending decision.
  //
  // **Tested by exclusion, not by enumeration (bugfix).** This used to name
  // the three statuses it refused — 'complete', 'paused_dodge',
  // 'paused_conflict' — which quietly meant any status added afterwards was
  // treated as runnable. `paused_defense` already shipped in the schema and
  // already fell through this guard; a pair sitting in it would have been
  // advanced straight past its own pending decision, resolving the round
  // twice. Grappling adds a fourth pause and would have hit the same hole.
  // Only 'running' may advance, so every future pause is safe by
  // construction rather than by remembering to edit this line.
  if (resolution.status !== 'running') {
    return;
  }

  const emitEvent = await makeEmitEvent(io, resolution, pairIndex, pair.round_number);

  const roundEndTicExclusive = pair.round_start_tic + roundLength;

  // A move that started in an earlier round and is still running through
  // this one is part of this round's board, but it never emits a `reveal`
  // here — it already revealed, last round — so the cutscene had no way to
  // know it existed and simply drew nothing for it. It now gets a `carryover`
  // event at the head of the round: the same footprint payload a reveal
  // carries, so the client renders it as an ordinary move bar in ordinary
  // phase colours (§0's self-contained rule — a replay watched later can't
  // go looking for a move that belonged to a different round).
  //
  // Emitted only when the resolution row is first created, so a resume after
  // a pause or a crash doesn't stack duplicates.
  if (isNewResolution) {
    const carried = await all(
      `SELECT dm.id, dm.character_id, dm.move_id, dm.placement_tic, dm.reveal_tic,
              dm.recovery_extension_tics, dm.appendage_choice,
              m.name AS move_name, m.active_tics, m.recovery_tics, m.defense_frame_positions,
              m.is_defensive, m.defense_kind, m.stamina_cost,
              ch.name AS character_name, ch.character_type,
              cp.side AS side
       FROM declared_moves dm
       JOIN moves m ON m.id = dm.move_id
       JOIN characters ch ON ch.id = dm.character_id
       JOIN combat_participants cp ON cp.character_id = dm.character_id
       WHERE cp.pair_index = ? AND dm.reveal_posted = 1
         AND dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics > ?`,
      [pairIndex, pair.round_start_tic]
    );
    for (const r of carried) {
      const activeEndTic = r.reveal_tic + r.active_tics;
      await emitEvent(pair.round_start_tic, 'carryover', {
        declaredMoveId: r.id,
        characterId: r.character_id,
        characterName: r.character_name,
        characterType: r.character_type,
        side: r.side,
        moveId: r.move_id,
        moveName: r.move_name,
        appendageChoice: r.appendage_choice,
        isDefensive: Boolean(r.is_defensive),
        defenseKind: r.defense_kind,
        staminaCost: r.stamina_cost ?? 0,
        placementTic: r.placement_tic,
        revealTic: r.reveal_tic,
        activeEndTic,
        recoveryEndTic: activeEndTic + r.recovery_tics + (r.recovery_extension_tics ?? 0),
        defenseFramePositions: JSON.parse(r.defense_frame_positions ?? '[]'),
      });
    }

    // The fighters themselves, so the cutscene can show who is in this
    // round and what shape they are in — the theater window had the board
    // and the log and a great deal of nothing else, and a hit landing on
    // "Body" meant nothing without a Body to watch it land on.
    //
    // Self-contained per §0: dice sizes and Stamina are captured as they
    // stand at the round's start, because by the time a replay is watched
    // they describe a completely different fight. Portraits are
    // deliberately NOT included — they are base64 blobs and this row is
    // stored forever; the cards use the same initial-letter placeholder
    // the rest of the app already falls back to.
    const seated = await all(
      `SELECT cp.character_id AS characterId, cp.side AS side,
              ch.name AS name, ch.character_type AS characterType,
              ch.current_stamina AS currentStamina, ch.max_stamina AS maxStamina
       FROM combat_participants cp JOIN characters ch ON ch.id = cp.character_id
       WHERE cp.pair_index = ? ORDER BY cp.side, ch.id`,
      [pairIndex]
    );
    if (seated.length) {
      const diceRows = await all(
        `SELECT d.character_id AS characterId, d.slot_name AS slotName, d.current_size AS size,
                d.bonus AS bonus, d.status AS status
         FROM dice d JOIN combat_participants cp ON cp.character_id = d.character_id
         WHERE cp.pair_index = ?`,
        [pairIndex]
      );
      const byChar = new Map();
      for (const d of diceRows) {
        if (!byChar.has(d.characterId)) byChar.set(d.characterId, []);
        byChar.get(d.characterId).push({ slotName: d.slotName, size: d.size, bonus: d.bonus, status: d.status });
      }
      await emitEvent(pair.round_start_tic, 'roster', {
        participants: seated.map((p) => ({ ...p, dice: byChar.get(p.characterId) ?? [] })),
      });
    }

    // The same problem one step earlier in a move's life: a long Startup
    // declared last round can still be winding up when this round opens.
    // Its placement Tic belongs to the previous round, so the Tic loop
    // below never reaches it and no `windup` would fire — the fighter would
    // stand there with an empty row until the move suddenly revealed.
    // Anchored to the round's own first Tic, alongside the carryovers.
    const stillWinding = await all(
      `SELECT dm.id, dm.character_id, dm.placement_tic, dm.reveal_tic,
              ch.name AS character_name, ch.character_type, cp.side AS side
       FROM declared_moves dm
       JOIN characters ch ON ch.id = dm.character_id
       JOIN combat_participants cp ON cp.character_id = dm.character_id
       WHERE cp.pair_index = ? AND dm.reveal_posted = 0
         AND dm.placement_tic < ? AND dm.reveal_tic >= ?`,
      [pairIndex, pair.round_start_tic, pair.round_start_tic]
    );
    if (stillWinding.length) {
      await emitWindups(emitEvent, pair.round_start_tic, stillWinding, await emittedWindupIds(resolution.id));
    }
  }

  let currentTic = resolution.resolved_through_tic + 1;

  while (currentTic < roundEndTicExclusive) {
    const result = await processTic(io, { pairIndex, tic: currentTic, emitEvent, resolutionId: resolution.id });
    // A genuine pause (Dodge/conflict) stops here without marking this Tic
    // done — status/pending_*_json were already persisted by resolveAttack
    // itself before it returned the pause signal (see that function). The
    // next advancePairResolution call (from resolveDodge/resolveMoveConflict
    // once the human answers) re-enters this SAME Tic and picks up exactly
    // where it left off — see processTic's own resumability comment.
    if (result?.paused) return;
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
  await postRoundSummary(io, { pairIndex, roundNumber: pair.round_number, resolutionId: resolution.id });
  await startPairDeclaration(io, pairIndex);
}

// Phase D — the GM's answer to a full-coverage Dodge prompt. A no-op if
// this pair isn't actually paused_dodge (a stale/duplicate click from a
// second tab, or the round already moved on) — rejects rather than
// re-applying, matching the plan's own "rejects a stale/duplicate click"
// requirement for this event.
async function resolveDodge(pairIndex, { outcome, attackerDeclaredMoveId }, io) {
  if (!['successful', 'failed'].includes(outcome)) return;
  const resolution = await one(
    `SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND status = 'paused_dodge'`,
    [pairIndex]
  );
  if (!resolution || !resolution.pending_dodge_json) return;
  const pending = JSON.parse(resolution.pending_dodge_json);
  // Reject a stale/duplicate click from a second GM tab: the prompt being
  // answered must be the one actually pending right now. The status check
  // above already catches "this pause is over"; this additionally catches
  // "the round paused again on a DIFFERENT Dodge before the stale click
  // landed", which status alone can't distinguish. Optional (so a caller
  // that doesn't track it still works), mirroring how resolveMoveConflict
  // validates its own pending declaredMoveId.
  if (attackerDeclaredMoveId != null && pending.attackerDeclaredMoveId !== attackerDeclaredMoveId) return;

  const defenderDM = await one(
    `SELECT dm.id, dm.character_id, dm.reveal_tic, dm.appendage_choice,
            m.id AS move_id, m.active_tics, m.recovery_tics, m.is_defensive, m.roll_type, m.custom_roll_size, m.roll_modifier,
            ch.name AS character_name
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id JOIN characters ch ON ch.id = dm.character_id
     WHERE dm.id = ?`,
    [pending.defenderDeclaredMoveId]
  );
  if (!defenderDM) {
    // The defending declared move vanished from under the pause (e.g.
    // deleted via some other path) — clear the pause so the pair isn't
    // stuck, but there's nothing left to resolve.
    await run(`UPDATE pair_round_resolutions SET status = 'running', pending_dodge_json = NULL WHERE id = ?`, [resolution.id]);
    await advancePairResolution(pairIndex, io);
    return;
  }

  const emitEvent = await makeEmitEvent(io, resolution, pairIndex, resolution.round_number);

  // The Stat this particular answer is about, popped off the queue. Null for a
  // move with no Attack Target of its own, which is a single question.
  const answeredStat = pending.remainingStats?.[0] ?? null;
  const remainingStats = (pending.remainingStats ?? []).slice(1);
  const stepsBySlot = { ...(pending.stepsBySlot ?? {}) };
  if (answeredStat) {
    // A dodged line takes nothing; a failed one takes the attack's full weight.
    stepsBySlot[answeredStat] = outcome === 'failed' ? pending.halfDamageSteps : 0;
  }

  await run(`UPDATE pair_round_resolutions SET status = 'running', pending_dodge_json = NULL WHERE id = ?`, [resolution.id]);
  await emitEvent(pending.tic, 'dodge_resolved', {
    attackerDeclaredMoveId: pending.attackerDeclaredMoveId,
    defenderDeclaredMoveId: pending.defenderDeclaredMoveId,
    outcome,
    // Which line of the attack was just answered, so the log and a replay read
    // as "the strike to the Body was dodged" rather than as the same sentence
    // repeated once per Stat.
    targetSlotName: answeredStat,
  });

  // More Stats to ask about — pause again on the next one rather than resolving
  // anything yet. Nothing has been applied at this point, so a re-pause is a
  // clean continuation of the same decision, not a partial commit.
  if (remainingStats.length) {
    await persistDodgePause(io, {
      pairIndex,
      pending: { ...pending, remainingStats, stepsBySlot },
      emitEvent,
      resolutionId: resolution.id,
    });
    return;
  }

  // Every line answered. The attack as a whole counts as evaded only if the
  // dodge got clear of ALL of it — anything that got through is a failed
  // defence for the attack, and each Stat then takes exactly what its own
  // answer earned it.
  const anyLanded = answeredStat
    ? Object.values(stepsBySlot).some((v) => v > 0)
    : outcome === 'failed';

  if (anyLanded) {
    await applyFailedDefense(io, {
      defenderDM,
      defenseLabel: 'Dodge',
      attackerDeclaredMoveId: pending.attackerDeclaredMoveId,
      attackerMoveId: pending.attackerMoveId,
      attackerCharacterId: pending.attackerCharacterId,
      attackerCharacterName: pending.attackerCharacterName,
      attackerResult: pending.attackerResult,
      targetCharacterId: pending.targetCharacterId,
      effectiveAttackTargets: pending.allowedConcreteTargets,
      halfDamageSteps: pending.halfDamageSteps,
      stepsBySlot: answeredStat ? stepsBySlot : null,
      attackActiveStart: pending.attackActiveStart,
      attackerActiveTics: pending.attackerActiveTics,
      tic: pending.tic,
      emitEvent,
    });
  } else {
    // No attackerResult/attackerCharacterName: a successful Dodge no longer
    // compares rolls or applies damage, so it needs neither.
    await applySuccessfulDodge(io, {
      defenderDM,
      attackerDeclaredMoveId: pending.attackerDeclaredMoveId,
      attackerMoveId: pending.attackerMoveId,
      attackerCharacterId: pending.attackerCharacterId,
      tic: pending.tic,
      emitEvent,
    });
  }

  await advancePairResolution(pairIndex, io);
}

// Phase D — the player's Forfeit/Postpone choice for a move a Block's
// Recovery extension just collided with (decision #3, unchanged math from
// the pre-overhaul manual combat:resolve_move_conflict — only the trigger
// path is new). A no-op if this pair isn't actually paused_conflict, or if
// this specific declaredMoveId isn't the one currently pending (a stale
// click from a second tab).
async function resolveMoveConflict(pairIndex, { declaredMoveId, choice }, io) {
  if (!['forfeit', 'postpone'].includes(choice)) return;
  const resolution = await one(
    `SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND status = 'paused_conflict'`,
    [pairIndex]
  );
  if (!resolution || !resolution.pending_conflict_json) return;
  const pending = JSON.parse(resolution.pending_conflict_json);
  if (pending.declaredMoveId !== declaredMoveId) return;

  const emitEvent = await makeEmitEvent(io, resolution, pairIndex, resolution.round_number);
  const row = await one(
    `SELECT dm.*, m.startup_tics, m.active_tics, m.recovery_tics, m.stamina_cost
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
     WHERE dm.id = ?`,
    [declaredMoveId]
  );
  if (!row) {
    await run(`UPDATE pair_round_resolutions SET status = 'running', pending_conflict_json = NULL WHERE id = ?`, [resolution.id]);
    await advancePairResolution(pairIndex, io);
    return;
  }

  let postponedTo = null;
  if (choice === 'forfeit') {
    await run('DELETE FROM declared_moves WHERE id = ?', [row.id]);
    if (row.stamina_committed && row.stamina_cost) {
      await adjustStamina(io, row.character_id, row.stamina_cost);
      await postSystemMessage(io, `A declared move was Forfeited — ${row.stamina_cost} Stamina refunded.`);
    }
  } else {
    // Postpone: recompute the blocker's own current Recovery end fresh
    // from the DB (not trusted from whenever the prompt first fired), and
    // floor this move's placement there.
    const blocker = await one(
      `SELECT dm.reveal_tic, dm.recovery_extension_tics, m.active_tics, m.recovery_tics
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
       WHERE dm.id = ?`,
      [pending.blockerDeclaredMoveId]
    );
    if (blocker) {
      const blockerRecoveryEndTic =
        blocker.reveal_tic + blocker.active_tics + blocker.recovery_tics + blocker.recovery_extension_tics;
      const newPlacementTic = Math.max(row.placement_tic, blockerRecoveryEndTic);
      const { revealTic } = computeMoveFootprint({
        placementTic: newPlacementTic,
        startupTics: row.startup_tics,
        activeTics: row.active_tics,
        recoveryTics: row.recovery_tics,
      });
      await run('UPDATE declared_moves SET placement_tic = ?, reveal_tic = ? WHERE id = ?', [newPlacementTic, revealTic, row.id]);
      postponedTo = { placementTic: newPlacementTic, revealTic };
    }
  }

  // Say where it went. A Postpone used to report only that it happened, and
  // the move then simply stopped being on screen: if its new placement lands
  // past this round's last Tic it reveals in the NEXT round's cutscene, which
  // reads at the table as the move having been quietly eaten. The payload now
  // carries the move, its owner, and where it landed, so the log can name all
  // three — see the narration client-side.
  const moveRow = await one('SELECT m.name AS move_name, ch.name AS character_name FROM declared_moves dm JOIN moves m ON m.id = dm.move_id JOIN characters ch ON ch.id = dm.character_id WHERE dm.id = ?', [declaredMoveId]).catch(() => null);
  await emitEvent(pending.tic ?? resolution.resolved_through_tic + 1, 'move_conflict_resolved', {
    declaredMoveId,
    blockerDeclaredMoveId: pending.blockerDeclaredMoveId,
    choice,
    moveName: moveRow?.move_name ?? null,
    characterName: moveRow?.character_name ?? null,
    ...(postponedTo
      ? {
          newPlacementTic: postponedTo.placementTic,
          newRevealTic: postponedTo.revealTic,
          // Whether it left this round entirely — the case that looked like
          // the move disappearing.
          intoNextRound: postponedTo.placementTic >= resolution.round_start_tic + resolution.round_length,
        }
      : {}),
  });

  // Recursive cascade: a Postponed move might now collide with yet another
  // already-declared move of this same character — re-check and pause
  // again if so, exactly as the original manual flow's own recursion did.
  if (choice === 'postpone') {
    const updatedRow = await one('SELECT reveal_tic, recovery_extension_tics FROM declared_moves WHERE id = ?', [row.id]);
    if (updatedRow) {
      const recoveryEndTic = updatedRow.reveal_tic + row.active_tics + row.recovery_tics + updatedRow.recovery_extension_tics;
      const stillColliding = await one(
        'SELECT id, character_id FROM declared_moves WHERE character_id = ? AND id != ? AND placement_tic >= ? AND placement_tic < ? ORDER BY id LIMIT 1',
        [row.character_id, row.id, updatedRow.reveal_tic, recoveryEndTic]
      );
      if (stillColliding) {
        await run(
          `UPDATE pair_round_resolutions SET status = 'paused_conflict', pending_conflict_json = ? WHERE id = ?`,
          [
            JSON.stringify({
              declaredMoveId: stillColliding.id,
              blockerDeclaredMoveId: row.id,
              characterId: stillColliding.character_id,
            }),
            resolution.id,
          ]
        );
        await emitEvent(pending.tic ?? resolution.resolved_through_tic + 1, 'move_conflict_prompt', {
          declaredMoveId: stillColliding.id,
          characterId: stillColliding.character_id,
          blockerDeclaredMoveId: row.id,
        });
        return;
      }
    }
  }

  await run(`UPDATE pair_round_resolutions SET status = 'running', pending_conflict_json = NULL WHERE id = ?`, [resolution.id]);
  await advancePairResolution(pairIndex, io);
}

// Phase D — the boot-time resume sweep: every pair whose own resolution
// was genuinely mid-Tic ('running', not a human-decision pause) when the
// server last stopped just picks back up — the crash-safety story this
// module's header comment describes, actually exercised at boot instead
// of only asserted in a test. A 'paused_dodge'/'paused_conflict' row is
// left alone (nothing to do until the pending decision arrives) and a
// 'complete' one is already done — only 'running' rows need a nudge.
async function resumeAllPairsOnBoot(io) {
  const rows = await all(`SELECT DISTINCT pair_index FROM pair_round_resolutions WHERE status = 'running'`);
  for (const row of rows) {
    await advancePairResolution(row.pair_index, io);
  }
}

// One answer in the grapple's follow-up sequence, from whoever owns that side.
//
// **Two sequential phases, not one simultaneous wait (decided, revised).** The
// grappler is asked first — the grab has already landed, so what is left is
// their choice of follow-up — and only then, if a read is happening at all, is
// the defender asked to guess. `ready` means "resumeGrapple should run now",
// which is true after the choice when no guess is coming and after the guess
// when one was.
//
// Ownership is checked by the caller (server/index.js), which is the only place
// that knows who a socket is. A stale or duplicate answer is a no-op: the pause
// must still be open, in the right phase, and for the same grapple.
async function answerGrapple(pairIndex, { half, direction, grapplerDeclaredMoveId }, io) {
  // DECLINE_FOLLOW_UP is the grappler's explicit "take nothing" — a real answer
  // rather than a missing one, so it is accepted where a direction would be.
  if (direction !== DECLINE_FOLLOW_UP && !DIRECTIONS.includes(direction)) {
    return { pending: null, ready: false };
  }
  const resolution = await one(
    `SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND status = 'paused_grapple'`,
    [pairIndex]
  );
  if (!resolution?.pending_grapple_json) return { pending: null, ready: false };
  const pending = JSON.parse(resolution.pending_grapple_json);
  if (grapplerDeclaredMoveId != null && pending.grapplerDeclaredMoveId !== grapplerDeclaredMoveId) {
    return { pending: null, ready: false };
  }
  // An answer for the phase that isn't open is ignored outright — this is what
  // stops a defender's guess arriving before the grappler has even picked.
  const phase = pending.phase ?? 'choice';
  if ((half === 'choice') !== (phase === 'choice')) return { pending, ready: false };

  // The grappler may only take a direction that carries a move they can
  // actually use; the target may guess any of the four, including an empty one
  // — guessing at a direction the grab was never going to take is a wrong
  // guess, not invalid input.
  if (half === 'choice' && direction !== DECLINE_FOLLOW_UP) {
    const picked = pending.directions.find((d) => d.direction === direction);
    if (!picked || !picked.available) return { pending, ready: false };
  }
  // First answer wins: a second click from another tab must not overwrite a
  // choice already made and possibly already acted on.
  if (half === 'choice' && pending.grapplerChoice != null) return { pending, ready: false };
  if (half === 'guess' && pending.targetGuess != null) return { pending, ready: false };

  if (half === 'choice') {
    pending.grapplerChoice = direction;
    // A read only happens if there was something to read AND the grappler
    // actually took a direction. Declining ends it here.
    const guessComing = pending.guessRuns && direction !== DECLINE_FOLLOW_UP;
    pending.phase = guessComing ? 'guess' : 'done';
    await run('UPDATE pair_round_resolutions SET pending_grapple_json = ? WHERE id = ?', [
      JSON.stringify(pending),
      resolution.id,
    ]);
    if (guessComing) {
      await postSystemMessage(
        io,
        `${pending.grapplerCharacterName} has chosen. ${pending.targetCharacterName} — which way is it going?`
      );
    }
    return { pending, ready: !guessComing, resolutionId: resolution.id, roundNumber: resolution.round_number };
  }

  pending.targetGuess = direction;
  pending.phase = 'done';
  await run('UPDATE pair_round_resolutions SET pending_grapple_json = ? WHERE id = ?', [
    JSON.stringify(pending),
    resolution.id,
  ]);
  return { pending, ready: true, resolutionId: resolution.id, roundNumber: resolution.round_number };
}

// The sequence is answered — score the read if there was one, put the follow-up
// on the board, and let the round carry on.
async function resumeGrapple(pairIndex, io) {
  const resolution = await one(
    `SELECT * FROM pair_round_resolutions WHERE pair_index = ? AND status = 'paused_grapple'`,
    [pairIndex]
  );
  if (!resolution?.pending_grapple_json) return;
  const pending = JSON.parse(resolution.pending_grapple_json);
  if (pending.grapplerChoice == null) return;
  if (pending.guessRuns && pending.grapplerChoice !== DECLINE_FOLLOW_UP && pending.targetGuess == null) return;

  const row = await loadResolutionRow(pending.grapplerDeclaredMoveId);
  const emitEvent = await makeEmitEvent(io, resolution, pairIndex, resolution.round_number);
  await run(
    `UPDATE pair_round_resolutions SET status = 'running', pending_grapple_json = NULL WHERE id = ?`,
    [resolution.id]
  );
  if (!row) {
    // The grabbing move vanished from under the pause. Nothing left to chain
    // from; clearing the pause above is what keeps the pair from sticking.
    await advancePairResolution(pairIndex, io);
    return;
  }

  if (pending.grapplerChoice === DECLINE_FOLLOW_UP) {
    await postSystemMessage(
      io,
      `${pending.grapplerCharacterName} holds ${pending.targetCharacterName} and takes it no further.`
    );
    await emitEvent(pending.tic, 'grapple_chain_ended', {
      sourceDeclaredMoveId: pending.grapplerDeclaredMoveId,
      characterId: pending.grapplerCharacterId,
      characterName: pending.grapplerCharacterName,
      reason: 'declined',
    });
    await advancePairResolution(pairIndex, io);
    return;
  }

  const guessOutcome = !pending.guessRuns
    ? GUESS_NONE
    : pending.targetGuess === pending.grapplerChoice
      ? GUESS_RIGHT
      : GUESS_WRONG;
  const chainRollBonus = chainRollBonusFor(guessOutcome);
  const chosen = pending.directions.find((d) => d.direction === pending.grapplerChoice);

  if (guessOutcome !== GUESS_NONE) {
    await postSystemMessage(
      io,
      guessOutcome === GUESS_RIGHT
        ? `${pending.targetCharacterName} reads it — ${pending.grapplerChoice}. −5 on what comes next.`
        : `${pending.targetCharacterName} guesses ${pending.targetGuess}; it went ${pending.grapplerChoice}. +5 on what comes next.`
    );
    await emitEvent(pending.tic, 'grapple_guessed', {
      declaredMoveId: pending.grapplerDeclaredMoveId,
      characterName: pending.grapplerCharacterName,
      targetCharacterName: pending.targetCharacterName,
      // Safe to replay now: the read is over, so nothing is left to spoil.
      chosen: pending.grapplerChoice,
      guess: pending.targetGuess,
      guessOutcome,
      chainRollBonus,
    });
  }

  if (chosen) {
    await chainFollowUp(io, {
      row,
      moveId: chosen.moveId,
      chainRollBonus,
      tic: pending.tic,
      emitEvent,
    });
  }

  await advancePairResolution(pairIndex, io);
}

// The same row shape processTic builds, for one declared move. Used by the
// grapple resume path, which comes back to a move the engine had already
// selected and must see it exactly as resolveGrapple first did.
async function loadResolutionRow(declaredMoveId) {
  const r = await one(
    `SELECT dm.id AS declaredMoveId, dm.character_id AS characterId, dm.move_id AS moveId,
            dm.placement_tic AS placementTic, dm.reveal_tic AS revealTic,
            dm.appendage_choice AS appendageChoice, dm.effective_attack_targets AS effectiveAttackTargets,
            dm.chain_roll_bonus AS chainRollBonus,
            m.name AS moveName, m.active_tics AS activeTics, m.roll_type AS rollType,
            m.is_defensive AS isDefensive, m.is_grappling AS isGrappling,
            m.success_threshold AS successThreshold,
            m.custom_roll_size AS customRollSize, m.roll_modifier AS rollModifier,
            cp.side AS side, ch.name AS characterName
     FROM declared_moves dm
     JOIN moves m ON m.id = dm.move_id
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     JOIN characters ch ON ch.id = dm.character_id
     WHERE dm.id = ?`,
    [declaredMoveId]
  );
  if (!r) return null;
  const slots = expandRollSlotRows(
    await all('SELECT slot_name, count FROM move_roll_slots WHERE move_id = ?', [r.moveId])
  );
  return { ...r, rollSlotNames: slots };
}

export {
  advancePairResolution,
  startPairDeclaration,
  resolveDodge,
  resolveMoveConflict,
  answerGrapple,
  resumeGrapple,
  resumeAllPairsOnBoot,
  // Shared with server/index.js rather than duplicated there (decided,
  // revised). These four used to exist twice — once here, once in index.js —
  // with a comment on both saying they had to be kept in sync by hand. They
  // drifted twice: index.js's copy never learned the stat-step automations,
  // and this one never learned index.js's GM-sentinel normalisation. This
  // module is import-safe by design (it pulls in no module that starts a
  // server), which is exactly what makes it the right single home.
  postSystemMessage,
  adjustStamina,
  logRoll,
  applyMoveInteractions,
};
