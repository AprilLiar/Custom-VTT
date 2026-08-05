import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { db, all, one, run, initDb } from './db.js';
import {
  DICE_TEMPLATE,
  DIE_SIZES,
  clamp,
  clampModifier,
  computeMaxStamina,
  rollDie,
  stepDie,
  applyRankPenalty,
  applyHalfDamage,
} from './gameLogic.js';
import {
  clampFrame,
  validFrames,
  normalizeInteractions,
  clampRollBonus,
  clampStaminaCost,
  sanitizeRollSlots,
  hasAmbiguousRollSlot,
  sanitizeDefensePositions,
  AMBIGUOUS_ROLL_SLOTS,
  sanitizeRollType,
  sanitizeCustomRollSize,
  sanitizeAttackTargets,
  expandAttackTargets,
  parseConcreteAttackTargets,
} from './moveLogic.js';
import { effectiveFrames, PERK_HOOKS, idleStaminaRegenRate } from './perkAutomations.js';
import {
  resolveSideInitiative,
  computePlacementTic,
  computeMoveFootprint,
  isMoveRevealedTo,
  relativeTic,
  computeNextRoundStartTic,
  isTicIdle,
  overlapsRoundWindow,
  computeInitiativeOverflowPenalty,
} from './combatTiming.js';
import {
  computeHitDamage,
  resolveDefenseRoll,
  classifyDefenseCoverage,
  computeInterruptBonus,
  clampRecoveryExtension,
} from './combatDamage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '3mb' })); // portraits arrive as base64 JSON
const httpServer = createServer(app);
// Exported so a future server/perkAutomations.js PERK_HOOKS entry can
// broadcast (die:updated/character:updated/etc.) after a manual effect.
// maxHttpBufferSize raised from Socket.io's 1MB default: chat GIFs are sent
// raw/unresized (to keep their animation) up to a 4MB client-side cap, which
// is ~5.3MB once base64-encoded — the default would reject that payload.
export const io = new Server(httpServer, { maxHttpBufferSize: 8 * 1024 * 1024 });

// ---------- shared lookups ----------

const getCharacter = (id) => one('SELECT * FROM characters WHERE id = ?', [id]);

// Mobile readiness (Change 002) §12: vitruvian_image_data is only ever read
// on a character's OWN Core Stats tab (CoreStatsTab.jsx, via a single-
// character getCharacter fetch) — never in a roster/list view. Any endpoint
// returning MULTIPLE characters at once strips it before responding, so a
// phone on a slow connection isn't downloading a full base64 backdrop image
// per character just to render name-and-portrait cards.
const omitVitruvianArt = ({ vitruvian_image_data, vitruvian_image_mime_type, ...rest }) => rest;
const getDice = (characterId) =>
  all('SELECT * FROM dice WHERE character_id = ? ORDER BY id', [characterId]);
const getInventory = (characterId) =>
  all('SELECT * FROM inventory_items WHERE character_id = ? ORDER BY id', [characterId]);
const getInjuries = (characterId) =>
  all('SELECT * FROM injuries WHERE character_id = ? ORDER BY id', [characterId]);
const VALID_INJURY_SLOTS = new Set(DICE_TEMPLATE.map((d) => d.slot_name));
// Bounds how many ranks a single Injury can dock — well past the 5 needed to
// fully incapacitate a bare d12 (rank 4), so it's a sanity clamp, not a
// meaningful design limit.
const clampInjuryPenalty = (value) => clamp(Math.trunc(Number(value) || 0), 0, 20);
const getStaminaDie = (characterId) =>
  one("SELECT * FROM dice WHERE character_id = ? AND slot_name = 'Stamina'", [characterId]);
const getStances = (characterId) =>
  all('SELECT * FROM stances WHERE character_id = ? ORDER BY id', [characterId]);
const getRoleplay = (characterId) =>
  all('SELECT * FROM roleplay_entries WHERE character_id = ? ORDER BY id', [characterId]);
const getCounters = (characterId) =>
  all('SELECT * FROM counters WHERE character_id = ? ORDER BY id', [characterId]);

// Attach parsed interaction rows + tag ids to each move in the list. The
// three lookups are independent of each other — fired concurrently so this
// costs one network round-trip (to Turso in production), not three.
async function attachInteractions(moves) {
  if (!moves.length) return moves;
  const ids = moves.map((m) => m.id);
  const marks = ids.map(() => '?').join(',');
  const [rows, tagRows, rollSlotRows] = await Promise.all([
    all(`SELECT * FROM move_interactions WHERE move_id IN (${marks}) ORDER BY id`, ids),
    all(`SELECT * FROM move_tags WHERE move_id IN (${marks}) ORDER BY id`, ids),
    all(`SELECT * FROM move_roll_slots WHERE move_id IN (${marks}) ORDER BY id`, ids),
  ]);
  const byMove = new Map();
  for (const row of rows) {
    if (!byMove.has(row.move_id)) byMove.set(row.move_id, []);
    byMove.get(row.move_id).push({
      trigger: row.trigger,
      text: row.text,
      automations: JSON.parse(row.automations),
    });
  }
  const tagsByMove = new Map();
  for (const row of tagRows) {
    if (!tagsByMove.has(row.move_id)) tagsByMove.set(row.move_id, []);
    tagsByMove.get(row.move_id).push(row.tag_id);
  }
  const rollSlotsByMove = new Map();
  for (const row of rollSlotRows) {
    if (!rollSlotsByMove.has(row.move_id)) rollSlotsByMove.set(row.move_id, []);
    rollSlotsByMove.get(row.move_id).push(row.slot_name);
  }
  return moves.map((m) => ({
    ...m,
    interactions: byMove.get(m.id) ?? [],
    tag_ids: tagsByMove.get(m.id) ?? [],
    roll_slots: rollSlotsByMove.get(m.id) ?? [],
    defense_frame_positions: JSON.parse(m.defense_frame_positions ?? '[]'),
    attack_targets: sanitizeAttackTargets(JSON.parse(m.attack_targets ?? '[]')),
  }));
}

// A character can learn/use a styled move only via a stance with that style
const characterHasStyle = async (characterId, styleAttributeId) => {
  const row = await one(
    'SELECT id FROM stances WHERE character_id = ? AND (attribute_a_id = ? OR attribute_b_id = ?) LIMIT 1',
    [characterId, styleAttributeId, styleAttributeId]
  );
  return Boolean(row);
};

const getMove = async (id) => {
  const move = await one('SELECT * FROM moves WHERE id = ?', [id]);
  return move ? (await attachInteractions([move]))[0] : null;
};

// A character's full move list: all defaults + everything granted to them,
// with Perk-granted per-character overrides folded in (effective frame
// data, effective tags, and any roll bonus) — "the move copy on the
// character," distinct from the shared Compendium template.
async function getMovesFor(characterId) {
  const moves = await all(
    `SELECT m.*, CASE WHEN cm.id IS NULL THEN 0 ELSE 1 END AS is_granted
     FROM moves m
     LEFT JOIN character_moves cm ON cm.move_id = m.id AND cm.character_id = ?
     WHERE m.is_default = 1 OR cm.id IS NOT NULL
     ORDER BY m.is_default DESC, m.id`,
    [characterId]
  );
  const withBase = await attachInteractions(moves);
  if (!withBase.length) return withBase;

  const ids = withBase.map((m) => m.id);
  const marks = ids.map(() => '?').join(',');

  // Four independent lookups — fired concurrently rather than one after
  // another, since none of them depend on each other's results.
  const [overrideRows, tagOverrideRows, bonusRows, dice] = await Promise.all([
    all(
      `SELECT * FROM character_move_overrides WHERE character_id = ? AND move_id IN (${marks})`,
      [characterId, ...ids]
    ),
    all(
      `SELECT * FROM character_move_tags WHERE character_id = ? AND move_id IN (${marks})`,
      [characterId, ...ids]
    ),
    all(
      `SELECT * FROM character_move_roll_bonuses WHERE character_id = ? AND move_id IN (${marks})`,
      [characterId, ...ids]
    ),
    // Live dice, keyed by body-part slot below, to resolve each move's Roll
    // to the character's actual current dice (not the shared template).
    getDice(characterId),
  ]);

  const overrideByMove = new Map();
  for (const row of overrideRows) {
    const acc = overrideByMove.get(row.move_id) ?? { startup: 0, active: 0, recovery: 0 };
    acc.startup += row.startup_delta;
    acc.active += row.active_delta;
    acc.recovery += row.recovery_delta;
    overrideByMove.set(row.move_id, acc);
  }

  const tagOverridesByMove = new Map();
  for (const row of tagOverrideRows) {
    if (!tagOverridesByMove.has(row.move_id)) tagOverridesByMove.set(row.move_id, []);
    tagOverridesByMove.get(row.move_id).push(row);
  }

  const bonusByMove = new Map();
  for (const row of bonusRows) {
    bonusByMove.set(row.move_id, (bonusByMove.get(row.move_id) ?? 0) + row.amount);
  }

  const dieBySlot = new Map(dice.map((d) => [d.slot_name, d]));

  return withBase.map((move) => {
    const deltas = overrideByMove.get(move.id) ?? { startup: 0, active: 0, recovery: 0 };
    const effective = effectiveFrames(move, deltas);
    const tagOverrides = tagOverridesByMove.get(move.id) ?? [];
    const addedIds = tagOverrides.filter((o) => o.action === 'add').map((o) => o.tag_id);
    const removedIds = new Set(
      tagOverrides.filter((o) => o.action === 'remove').map((o) => o.tag_id)
    );
    const effectiveTagIds = [
      ...new Set([...move.tag_ids.filter((id) => !removedIds.has(id)), ...addedIds]),
    ];
    const rollBonus = bonusByMove.get(move.id) ?? 0;
    const hasOverrides =
      deltas.startup !== 0 || deltas.active !== 0 || deltas.recovery !== 0 ||
      tagOverrides.length > 0 || rollBonus !== 0;

    // Resolve the move's configured Roll slots to this character's actual
    // dice, and fold the move's own roll_modifier together with any
    // Perk-granted per-move roll_bonus into one suggested modifier — the
    // "specified bonus" the Roll dialog pre-fills, editable manually from there.
    const toDieInfo = (d) => ({
      dieId: d.id,
      slot_name: d.slot_name,
      current_size: d.current_size,
      bonus: d.bonus,
      status: d.status,
    });
    const concreteSlots = move.roll_slots.filter((s) => !(s in AMBIGUOUS_ROLL_SLOTS));
    const rollDice = concreteSlots.map((s) => dieBySlot.get(s)).filter(Boolean).map(toDieInfo);
    const ambiguousSlots = move.roll_slots.filter((s) => s in AMBIGUOUS_ROLL_SLOTS);
    // Not resolved to one die — the player picks Left or Right at roll time
    // (see plan: Move Roll's Left/Right Hand/Leg choice), so both sides'
    // dice are sent and the client asks before rolling.
    const rollChoice = ambiguousSlots.length
      ? {
          left: ambiguousSlots
            .map((s) => dieBySlot.get(AMBIGUOUS_ROLL_SLOTS[s][0]))
            .filter(Boolean)
            .map(toDieInfo),
          right: ambiguousSlots
            .map((s) => dieBySlot.get(AMBIGUOUS_ROLL_SLOTS[s][1]))
            .filter(Boolean)
            .map(toDieInfo),
        }
      : null;

    return {
      ...move,
      effective_startup_tics: effective.startup_tics,
      effective_active_tics: effective.active_tics,
      effective_recovery_tics: effective.recovery_tics,
      effective_tag_ids: effectiveTagIds,
      roll_bonus: rollBonus,
      has_perk_overrides: hasOverrides,
      roll_dice: rollDice,
      roll_choice: rollChoice,
      effective_roll_modifier: move.roll_modifier + rollBonus,
    };
  });
}

async function getPerk(id) {
  return one('SELECT * FROM perks WHERE id = ?', [id]);
}

// A character's granted Perks (id, name, description, picture — automation
// is now manual per-Perk code, not stored data, see perkAutomations.js).
async function getCharacterPerks(characterId) {
  const rows = await all(
    `SELECT p.*, cp.id AS character_perk_id
     FROM character_perks cp JOIN perks p ON p.id = cp.perk_id
     WHERE cp.character_id = ? ORDER BY cp.id`,
    [characterId]
  );
  return rows.map((r) => ({
    id: r.id,
    character_perk_id: r.character_perk_id,
    name: r.name,
    description: r.description,
    image_data: r.image_data,
    image_mime_type: r.image_mime_type,
  }));
}

// Superset of the plan's die:updated payload: locked_* is included because the
// current-vs-locked tint can't update after Lock/Revert without it.
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

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC
const sqliteToIso = (ts) =>
  ts && !ts.includes('T') ? new Date(ts.replace(' ', 'T') + 'Z').toISOString() : ts;

// Every currently-public (reveal_posted = 1) move belonging to a character
// seated in `pairIndex`, clipped to whichever moves' footprints still
// overlap the CURRENT round's own Tic window (see overlapsRoundWindow) —
// exactly what the live Tic Counter itself would show for that lane right
// now. Called once per newly-revealed move (see postMoveReveals below), so
// each lane_snapshot chat card is a full cumulative picture as of that
// specific reveal, not a delta — "a new snapshot every reveal" is what
// gives the chat log a full history of how the lane's Tic Counter filled in
// over the round. `full` is embedded per move (not re-fetched at GET time)
// so a historical row stays self-contained even after the move itself is
// edited or deleted later.
async function buildLaneSnapshotPayload({ pairIndex, roundNumber, roundStartTic, roundLength }) {
  const rows = await all(
    `SELECT dm.id AS declared_move_id, dm.character_id, dm.placement_tic, dm.reveal_tic,
            dm.recovery_extension_tics,
            m.id AS move_id, m.name AS move_name, m.image_data, m.image_mime_type,
            m.active_tics, m.recovery_tics, m.defense_frame_positions, m.description, m.stamina_cost,
            ch.name AS character_name, ch.character_type,
            cp.side AS side
     FROM declared_moves dm
     JOIN moves m ON m.id = dm.move_id
     JOIN characters ch ON ch.id = dm.character_id
     JOIN combat_participants cp ON cp.character_id = dm.character_id
     WHERE cp.pair_index = ? AND dm.reveal_posted = 1
     ORDER BY dm.id`,
    [pairIndex]
  );
  const moves = [];
  for (const row of rows) {
    const activeEndTic = row.reveal_tic + row.active_tics;
    // + recovery_extension_tics (Combat Automation, sub-phase 3) — see
    // fetchDeclaredMoveRows' own identical comment above.
    const recoveryEndTic = activeEndTic + row.recovery_tics + row.recovery_extension_tics;
    if (!overlapsRoundWindow({ placementTic: row.placement_tic, recoveryEndTic, roundStartTic, roundLength })) {
      continue;
    }
    const full = await getMove(row.move_id);
    moves.push({
      declaredMoveId: row.declared_move_id,
      characterId: row.character_id,
      characterName: row.character_name,
      characterType: row.character_type,
      side: row.side,
      moveId: row.move_id,
      moveName: row.move_name,
      imageData: row.image_data,
      imageMimeType: row.image_mime_type,
      placementTic: row.placement_tic,
      revealTic: row.reveal_tic,
      activeEndTic,
      recoveryEndTic,
      defenseFramePositions: JSON.parse(row.defense_frame_positions ?? '[]'),
      description: row.description,
      staminaCost: row.stamina_cost,
      full,
    });
  }
  return { pairIndex, roundNumber, roundStartTic, roundLength, moves };
}

// Posts a lane_snapshot chat card the instant the Tic counter reaches a
// declared move's reveal_tic — automatic, per the plan's Combat Timing
// section (only the Roll itself is manual, unchanged, via the existing
// Roll button/dialog — this never touches rolling). reveal_posted makes
// this idempotent: only ever fires once per declared move, even if the GM
// steps the Tic counter back and forth across the same threshold — see
// combat:tic_forward, the only caller (tic_backward never advances current_tic,
// so it can never newly cross a reveal_tic). `roundNumber`/`roundStartTic`/
// `roundLength` are the round ACTIVE AT THE TIME of this reveal (from the
// caller's own already-fetched combat_state row) — they decide the Tic
// window each snapshot is drawn against (see buildLaneSnapshotPayload).
async function postMoveReveals(newTic, { roundNumber, roundStartTic, roundLength }) {
  const rows = await all(
    'SELECT dm.id, dm.character_id FROM declared_moves dm WHERE dm.reveal_posted = 0 AND dm.reveal_tic <= ?',
    [newTic]
  );
  for (const row of rows) {
    await run('UPDATE declared_moves SET reveal_posted = 1 WHERE id = ?', [row.id]);
    const participant = await one('SELECT pair_index FROM combat_participants WHERE character_id = ?', [
      row.character_id,
    ]);
    if (!participant) continue; // character left the arena between declaring and revealing
    const payload = await buildLaneSnapshotPayload({
      pairIndex: participant.pair_index,
      roundNumber,
      roundStartTic,
      roundLength,
    });
    await run(
      "INSERT INTO chat_log (kind, character_id, dice_rolled, payload) VALUES ('lane_snapshot', ?, '[]', ?)",
      [row.character_id, JSON.stringify(payload)]
    );
    io.emit('chat:lane_snapshot', { kind: 'lane_snapshot', ...payload, timestamp: new Date().toISOString() });
  }
}

// Every declared move, Tell always included (never secret) but move_id/
// move_name withheld from anyone who isn't entitled to see it early (see
// isRevealedToViewer below). Split in two: the DB round-trip happens once
// per broadcast regardless of how many sockets are watching (fetchDeclaredMoveRows),
// then each connected socket's own view is a cheap in-memory map
// (mapDeclaredMovesForViewer) — see emitCombatUpdated.
async function fetchDeclaredMoveRows() {
  return all(`
    SELECT dm.id, dm.character_id, dm.round_number, dm.queue_order,
           dm.placement_tic, dm.reveal_tic, dm.stamina_committed, dm.appendage_choice,
           dm.recovery_extension_tics,
           m.id AS move_id, m.name AS move_name, m.tell_id, m.right_tell_id,
           m.left_tell_id, m.active_tics, m.recovery_tics, m.stamina_cost,
           m.defense_frame_positions, ch.character_type
    FROM declared_moves dm
    JOIN moves m ON m.id = dm.move_id
    JOIN characters ch ON ch.id = dm.character_id
    ORDER BY dm.id
  `);
}

// GET /api/combat has no socket to carry an identity, so the client sends
// it as query params instead — same shape as identity:set's payload.
function viewerFromQuery(query) {
  if (query?.role === 'gm') return { role: 'gm' };
  const characterId = Number(query?.characterId);
  if (query?.role === 'player' && Number.isInteger(characterId)) {
    return { role: 'player', characterId };
  }
  return null;
}

// A viewer is `{ role: 'gm' }`, `{ role: 'player', characterId }`, or null
// (not yet identified — see identity:set). A move is revealed early to:
// the player who's logged in as the declaring character (their own move),
// or the GM for any NPC's move (the GM effectively declared it) — but
// never the GM for a Player's move, "for fairness" (decided): the GM is an
// adversarial party in this game, not an omniscient narrator, so a Player's
// secret stays secret from the GM exactly like it does from other Players.
function isRevealedToViewer(row, viewer) {
  if (!viewer) return false;
  if (viewer.role === 'player') return viewer.characterId === row.character_id;
  if (viewer.role === 'gm') return row.character_type === 'npc';
  return false;
}

function mapDeclaredMovesForViewer(rows, currentTic, viewer, phase, roundNumber) {
  return rows.map((row) => {
    const viewerIsOwner = isRevealedToViewer(row, viewer);
    // Natural (non-owner) reveal only applies once this row's own round has
    // actually entered Tic Countdown. Without this, a 0-Startup move placed
    // at the round's very first Tic already satisfies currentTic >=
    // revealTic the instant it's declared — while still in Declaration
    // Phase, before the other side has even finished declaring — leaking
    // its identity to everyone early. A row from an earlier round is
    // always safe to check live: round_start_tic/current_tic only ever
    // move forward, so this can't un-reveal something already legitimately
    // shown.
    const ticCountdownRanForThisRow = row.round_number < roundNumber || phase === 'tic_countdown';
    const isRevealed =
      viewerIsOwner ||
      (ticCountdownRanForThisRow &&
        isMoveRevealedTo({ revealTic: row.reveal_tic, currentTic, viewerIsOwner: false }));
    return {
      id: row.id,
      characterId: row.character_id,
      roundNumber: row.round_number,
      queueOrder: row.queue_order,
      placementTic: row.placement_tic,
      revealTic: row.reveal_tic,
      activeEndTic: row.reveal_tic + row.active_tics,
      // + recovery_extension_tics (Combat Automation, sub-phase 3): 0 for
      // every move untouched by a Block's Recovery extension — see the
      // column's own comment in db.js and combat:resolve_defense below.
      recoveryEndTic: row.reveal_tic + row.active_tics + row.recovery_tics + row.recovery_extension_tics,
      // Same frame-timing precedent as activeEndTic/recoveryEndTic above:
      // fine to disclose regardless of reveal status, since it's structure
      // (when the defensive windows land), not identity. Positions are
      // 0-based into the move's own frame sequence — add placementTic to
      // get the absolute Tic, same scheme moveLogic.js's
      // sanitizeDefensePositions stores them in.
      defenseFramePositions: JSON.parse(row.defense_frame_positions ?? '[]'),
      tellId: row.tell_id,
      rightTellId: row.right_tell_id,
      leftTellId: row.left_tell_id,
      appendageChoice: row.appendage_choice,
      isRevealed,
      moveId: isRevealed ? row.move_id : null,
      moveName: isRevealed ? row.move_name : null,
      // Fine to disclose whenever the move itself is: either it's really
      // this viewer's own still-secret pending move (the only case where
      // this actually matters — it drives the Arena's pending-Stamina
      // preview), or the move's identity is already public knowledge via
      // reveal_tic, in which case its cost is just a Compendium lookup away
      // anyway.
      staminaCost: isRevealed ? row.stamina_cost : null,
      staminaCommitted: Boolean(row.stamina_committed),
    };
  });
}

// Sum of Stamina Cost across a character's declared-but-not-yet-committed
// moves — moves only stay uncommitted until this character themselves
// presses "done declaring" (combat:character_done_declaring commits them
// all at once), so this is also exactly "how much is currently pending."
async function getPendingStaminaCost(characterId) {
  const row = await one(
    `SELECT COALESCE(SUM(m.stamina_cost), 0) AS pending
     FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
     WHERE dm.character_id = ? AND dm.stamina_committed = 0`,
    [characterId]
  );
  return row.pending;
}

// Broadcasts the Combat Arena's full current state — seating/toggle plus
// (Phase 7) the round/Tic timing state and every declared move — called
// from the combat:*/move:declare socket handlers below and from character
// delete (a seated character leaving the roster needs the arena to drop
// them too). Always the full state, not a delta, same pattern `participants`
// already used before Phase 7. declaredMoves' visibility depends on who's
// watching (see isRevealedToViewer above), so this is a per-socket emit
// rather than one io.emit — the DB round-trip still only happens once.
async function emitCombatUpdated() {
  const [state, participants, pairs, declaredMoveRows] = await Promise.all([
    one('SELECT * FROM combat_state WHERE id = 1'),
    all('SELECT * FROM combat_participants ORDER BY side, pair_index, id'),
    all('SELECT * FROM combat_pairs ORDER BY pair_index'),
    fetchDeclaredMoveRows(),
  ]);
  const tic = relativeTic({
    tic: state.current_tic,
    roundStartTic: state.round_start_tic,
    roundLength: state.round_length,
  });
  const base = {
    unevenCombatEnabled: Boolean(state.uneven_combat_enabled),
    phase: state.phase,
    roundNumber: state.round_number,
    currentTic: state.current_tic,
    roundStartTic: state.round_start_tic,
    roundLength: state.round_length,
    relativeTic: tic.relative,
    isOverflow: tic.isOverflow,
    overflowBy: tic.overflowBy,
    // Phase 9 combat redesign: declaration runs independently per pair now
    // (see combat_pairs in db.js) — pairs[].declaring_side is whichever side
    // of that pair may currently call move:declare (null once both sides of
    // it are done); participants[].declared_this_round is the per-character
    // status the GM's declaration table renders (see Combat Timing above).
    pairs,
    participants,
  };
  for (const viewerSocket of io.sockets.sockets.values()) {
    viewerSocket.emit('combat:updated', {
      ...base,
      declaredMoves: mapDeclaredMovesForViewer(
        declaredMoveRows,
        state.current_tic,
        viewerSocket.data.identity,
        state.phase,
        state.round_number
      ),
    });
  }
}

// "Reasons to Fight" (see combat_participants.reasons_to_fight): +1 to all
// of a seated character's rolls per point, only while a fight is actually
// underway (combat_state.phase set — seating for an about-to-start fight
// doesn't count yet). Folded straight into the roll's modifier at the point
// each roll actually executes (die:roll/pool:roll) rather than as a
// client-side pre-fill, so it can't be bypassed by whatever a roll dialog
// happened to pre-fill.
async function getReasonsToFightBonus(characterId) {
  const state = await one('SELECT phase FROM combat_state WHERE id = 1');
  if (!state || state.phase == null) return 0;
  const participant = await one(
    'SELECT reasons_to_fight FROM combat_participants WHERE character_id = ?',
    [characterId]
  );
  return participant?.reasons_to_fight ?? 0;
}

// Idle-Tic Stamina Regen (see plan + combatTiming.js's isTicIdle,
// perkAutomations.js's idleStaminaRegenRate): called once for every Tic as
// it becomes current (both from combat:start_tic_countdown, for the round's
// first Tic, and from combat:tic_forward for every Tic after) — the same
// call sites/timing postMoveReveals already uses, so every Tic gets
// evaluated exactly once as it's reached, never on the way back (stepping
// backward doesn't claw the Stamina back, same one-directional asymmetry
// postMoveReveals already has for chat cards). A seated character who's
// already at full Stamina is skipped entirely rather than silently banking
// progress they can't spend.
async function applyIdleTicStaminaRegen(tic) {
  const participants = await all('SELECT * FROM combat_participants');
  if (!participants.length) return;
  const charIds = participants.map((p) => p.character_id);
  const marks = charIds.map(() => '?').join(',');
  const [charRows, footprintRows, perkRows] = await Promise.all([
    all(`SELECT * FROM characters WHERE id IN (${marks})`, charIds),
    all(
      // + dm.recovery_extension_tics (Combat Automation, sub-phase 3) — see
      // the column's own comment in db.js.
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
    if (!isTicIdle({ tic, footprints: footprintsByChar.get(p.character_id) ?? [] })) continue;

    const ticsRequired = idleStaminaRegenRate(perkNamesByChar.get(p.character_id) ?? []);
    const progress = p.idle_regen_progress + 1;
    if (progress < ticsRequired) {
      await run('UPDATE combat_participants SET idle_regen_progress = ? WHERE character_id = ?', [
        progress,
        p.character_id,
      ]);
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

// Combat Automation (Phase 9, sub-phase 3 — see vttprojectplan.md): when a
// roll is for a declared move's own reveal-time Roll, the caller passes
// `declaredMoveId` back to this helper (see pool:roll/dice:roll_custom
// below) and this resolves it into the documented chat_log.payload roll-
// context shape — `{ declaredMoveId, moveId, pairIndex, side,
// targetCandidateIds }` (see the payload column's own comment in db.js).
// targetCandidateIds is every character currently seated on the opposing
// side of the roller's own pair — trivially one id for a normal 1-on-1
// pair, more than one under Uneven Combat. Returns null (no context — a
// bare roll) if the declared move can't be resolved to this character or
// they're not currently seated, rather than rejecting the roll outright;
// the roll itself always still happens, this only ever gates whether it
// gets an Apply button once sub-phase 4 builds one.
async function buildRollContext(characterId, declaredMoveId) {
  if (declaredMoveId == null) return null;
  const [declaredMove, participant] = await Promise.all([
    one(
      `SELECT id, move_id, effective_attack_targets, attack_target_source
       FROM declared_moves WHERE id = ? AND character_id = ?`,
      [declaredMoveId, characterId]
    ),
    one('SELECT pair_index, side FROM combat_participants WHERE character_id = ?', [characterId]),
  ]);
  if (!declaredMove || !participant) return null;
  const opponentSide = participant.side === 'left' ? 'right' : 'left';
  const targets = await all(
    'SELECT character_id FROM combat_participants WHERE pair_index = ? AND side = ?',
    [participant.pair_index, opponentSide]
  );
  return {
    declaredMoveId: declaredMove.id,
    moveId: declaredMove.move_id,
    pairIndex: participant.pair_index,
    side: participant.side,
    targetCandidateIds: targets.map((t) => t.character_id),
    // Attack Target (Change 001): the declare-time snapshot — still source
    // 'move' at this point, since a Successful Block (which can flip it to
    // 'block') only ever happens after this attacking roll card is already
    // posted. combat:defense_resolved separately pushes the updated value.
    effectiveAttackTargets: parseConcreteAttackTargets(declaredMove.effective_attack_targets),
    attackTargetSource: declaredMove.attack_target_source,
  };
}

async function logRoll({ characterId, characterName, modifier, dice, rollContext = null }) {
  const total = dice.reduce((sum, d) => sum + d.result, 0);
  await run(
    'INSERT INTO chat_log (character_id, dice_rolled, modifier, payload) VALUES (?, ?, ?, ?)',
    [characterId, JSON.stringify(dice), modifier, rollContext ? JSON.stringify(rollContext) : null]
  );
  // Every existing caller passes a real character.id (die:roll, pool:roll,
  // combat:next_round's Brain rolls) — GM_CHAT_SENTINEL_ID only ever shows
  // up here via dice:roll_custom's "post as GM" path. Normalizing it back to
  // null on the live broadcast matches how GET /api/chat already reads a
  // GM-posted row back after reload (see isGmPost there), so a live entry
  // and its post-refresh reload render identically instead of one carrying
  // a raw 0 the other doesn't.
  const isGmPost = characterId === GM_CHAT_SENTINEL_ID;
  io.emit('roll:result', {
    kind: 'roll',
    // Spread directly onto the broadcast (rather than nested under its own
    // key) so a live roll and its post-refresh GET /api/chat reload render
    // identically — same convention kind='lane_snapshot' rows already use
    // for their own payload (see GET /api/chat below).
    ...(rollContext ?? {}),
    characterId: isGmPost ? null : characterId,
    characterName,
    modifier,
    dice,
    total,
    timestamp: new Date().toISOString(),
  });
}

// Combat Automation (Phase 9, sub-phase 3): a GM-authored system notice —
// "Block/Dodge has failed," "Partial Block — 1.5 damage," a Forfeit/
// Interruption Stamina-refund note, and so on (see the plan's 4.1-4.4). Same
// insertion shape chat:message already uses for a GM-posted row (posts as
// the GM_CHAT_SENTINEL_ID persona), just triggered by combat resolution
// instead of the compose box.
async function postSystemMessage(text) {
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

// Combat Automation (Phase 9, sub-phase 3): the shared clamp+update+
// broadcast a Stamina change already uses (see stamina:adjust below) —
// factored out so Forfeit's full refund (4.3) and Interruption's half
// refund (4.4) can reuse it instead of duplicating the clamp/broadcast
// logic. Returns the character's new current_stamina, or null if the
// character doesn't exist. `delta` can be negative (a cost), though every
// current caller only ever passes a positive refund.
async function adjustStamina(characterId, delta) {
  const character = await getCharacter(characterId);
  if (!character) return null;
  const change = Math.trunc(Number(delta) || 0);
  if (!change) return character.current_stamina;
  const currentStamina = clamp(character.current_stamina + change, 0, character.max_stamina);
  await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [currentStamina, character.id]);
  io.emit('character:updated', { ...character, current_stamina: currentStamina });
  return currentStamina;
}

// Combat Automation (Phase 9, sub-phase 5): server-side labels for the chat
// notice below — kept separate from client/src/lib/moveDisplay.js's own
// TRIGGER_LABELS/automationLabel (same duplication precedent as
// ChatPanel.jsx's computeHitDamage) rather than importing client code into
// the server.
const TRIGGER_LABELS = {
  hit: 'On Hit',
  block: 'On Block',
  miss: 'On Miss',
  defense_success: 'On Successful Defense',
  defense_failure: 'On Failed Defense',
};

// Combat Automation (Phase 9, sub-phase 5): actually executes a move's
// stored On Hit/Block/Miss/Successful Defense/Failed Defense automations
// (move_interactions.automations — self_recovery/opponent_recovery/
// self_stamina/opponent_stamina) once that trigger's outcome is decided,
// closing the plan's long-standing open item ("these are already fully
// modeled... but never actually fire"). `self`/`opponent` are resolved by
// each call site below to whichever character actually owns `moveId` for
// this firing and whoever's on the other side of it — see combat:apply_
// damage (hit), pool:roll/dice:roll_custom (miss), and combat:resolve_
// defense (block/defense_success/defense_failure) for exactly who plays
// which role at each trigger. `opponentDeclaredMoveId` is optional — a
// plain Hit/Miss has no specific declared move of the opponent's tied to
// the exchange, so `opponent_recovery` falls back to whichever of their
// declared moves currently ends latest (same "most relevant in-flight
// move" query move:declare's own placement-Tic floor already uses);
// opponent_recovery/opponent_stamina are silently skipped (with their own
// note in the chat line) if there's no opponent at all (declaredMoveId
// unresolvable) or, for opponent_recovery, no declared move to extend.
async function applyMoveInteractions({
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
  let recoveryChanged = false;

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
    recoveryChanged = true;
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
        // No declared move known for this exchange (a plain Hit/Miss) —
        // fall back to whichever of the opponent's own declared moves
        // currently ends latest, same lookup move:declare's own
        // placement floor already uses.
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
        await adjustStamina(selfCharacterId, -amount);
        effects.push(`−${amount} Stamina (${selfCharacter.name})`);
        break;
      case 'opponent_stamina':
        if (!opponentCharacter) break;
        await adjustStamina(opponentCharacterId, -amount);
        effects.push(`−${amount} Stamina → ${opponentCharacter.name}`);
        break;
      default:
        break;
    }
  }

  if (row.text || effects.length) {
    const parts = [row.text, effects.join(', ')].filter(Boolean);
    await postSystemMessage(`${move.name} — ${TRIGGER_LABELS[trigger] ?? trigger}: ${parts.join(' — ')}`);
  }
  // The extended Recovery window is real combat state (declared_moves
  // itself) — same as 4.3's Block-too-late extension, the existing Tic
  // Counter/footprint rendering already reads recoveryEndTic straight off
  // it, so a fresh combat:updated is enough for it to show up live.
  if (recoveryChanged) await emitCombatUpdated();
}

// Combat Automation (Phase 9, sub-phase 5): fires a move's 'miss' trigger
// the moment its own reveal-time roll comes back at 0 Half-Damage steps —
// unlike a Hit or a Block, a Miss has no GM action to hang the firing off:
// the chat card's Apply button is disabled at 0 damage, so nothing would
// ever call combat:apply_damage for one (see the "Suggested additional
// automation points" bullet's own Miss definition). Shared by pool:roll/
// dice:roll_custom, the only two callers that ever pass rollContext.
// Opponent-directed automations only fire when there's exactly one target
// candidate — which of several possible Uneven Combat targets a miss
// "affects" is a genuine ambiguity not worth guessing at, so those are
// silently skipped there (self-only automations still fire regardless).
// Guarded by interactions_resolved same as combat:apply_damage's Hit firing
// below, though in practice a fresh reveal-time roll's declared move was
// never previously resolved — defensive, not load-bearing here.
async function fireMissIfNoDamage(character, rollContext, total) {
  if (!rollContext) return;
  if (computeHitDamage(total).halfDamageSteps > 0) return;
  const dm = await one('SELECT interactions_resolved FROM declared_moves WHERE id = ?', [
    rollContext.declaredMoveId,
  ]);
  if (!dm || dm.interactions_resolved) return;
  await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [rollContext.declaredMoveId]);
  await applyMoveInteractions({
    moveId: rollContext.moveId,
    trigger: 'miss',
    selfCharacterId: character.id,
    selfDeclaredMoveId: rollContext.declaredMoveId,
    opponentCharacterId: rollContext.targetCandidateIds.length === 1 ? rollContext.targetCandidateIds[0] : null,
  });
}

// Combat Automation (Phase 9, sub-phase 3): resolves a Defensive move's own
// Roll — move_roll_slots, optionally concatenated with move_defensive_roll_
// slots (4.2's extra pool, "on top of its own normal Roll," never deduped
// against the base slots even if the same slot name appears in both) — to
// one character's actual live dice. Same AMBIGUOUS_ROLL_SLOTS resolution
// getMovesFor already uses to build a move's roll_dice/roll_choice for the
// client, just server-triggered here: there's no roll dialog for a
// Successful Block/Dodge (see combat:resolve_defense below), so this reads
// the Left/Right pick straight from the declared move's own already-stored
// appendage_choice instead of asking again. Silently drops an
// incapacitated/missing die, same as pool:roll.
async function resolveDefensiveRollDice(characterId, slotNames, appendageChoice) {
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

// ---------- REST API ----------

// Express 4 doesn't catch async route errors — without this a DB hiccup
// would crash the whole server.
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(`error in ${req.method} ${req.path}:`, err);
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  });

app.get('/api/health', async (_req, res) => {
  try {
    await db.execute('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'error', message: err.message });
  }
});

app.get('/api/characters', wrap(async (_req, res) => {
  res.json((await all('SELECT * FROM characters ORDER BY id')).map(omitVitruvianArt));
}));

// Character-list folders (GM-managed) — separate from /api/characters so
// existing callers that just want the flat character array are unaffected.
app.get('/api/character-folders', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM character_folders ORDER BY name'));
}));

app.get('/api/characters/:id', wrap(async (req, res) => {
  const character = await getCharacter(req.params.id);
  if (!character) return res.status(404).json({ error: 'not found' });
  // Eight independent lookups — none depend on another's result, so they're
  // fired concurrently. Sequentially awaiting each one (the original shape)
  // is fine against a local SQLite file, but against Turso's networked
  // connection in production every await is a real round-trip, and eight in
  // a row is exactly the "a few seconds to open a character" symptom.
  const [dice, inventory, injuries, stances, moves, roleplay, perks, counters] = await Promise.all([
    getDice(character.id),
    getInventory(character.id),
    getInjuries(character.id),
    getStances(character.id),
    getMovesFor(character.id),
    getRoleplay(character.id),
    getCharacterPerks(character.id),
    getCounters(character.id),
  ]);
  res.json({ character, dice, inventory, injuries, stances, moves, roleplay, perks, counters });
}));

app.get('/api/tells', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM tells ORDER BY id'));
}));

app.get('/api/tags', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM tags ORDER BY id'));
}));

// Compendium view: folders + every move, with interactions, tags and grants
app.get('/api/moves', wrap(async (_req, res) => {
  const moves = await attachInteractions(await all('SELECT * FROM moves ORDER BY id'));
  const grants = await all('SELECT * FROM character_moves');
  const byMove = new Map();
  for (const g of grants) {
    if (!byMove.has(g.move_id)) byMove.set(g.move_id, []);
    byMove.get(g.move_id).push(g.character_id);
  }
  res.json({
    folders: await all('SELECT * FROM move_folders ORDER BY name'),
    moves: moves.map((m) => ({ ...m, granted_character_ids: byMove.get(m.id) ?? [] })),
  });
}));

// The Perks compendium: every Perk plus who currently has it
app.get('/api/perks', wrap(async (_req, res) => {
  const perks = await all('SELECT * FROM perks ORDER BY id');
  const grants = await all('SELECT * FROM character_perks');
  const grantedBy = new Map();
  for (const g of grants) {
    if (!grantedBy.has(g.perk_id)) grantedBy.set(g.perk_id, []);
    grantedBy.get(g.perk_id).push(g.character_id);
  }
  res.json(perks.map((p) => ({ ...p, granted_character_ids: grantedBy.get(p.id) ?? [] })));
}));

// Global search across named library entities only (Characters, Moves,
// Perks, Tells, Tags) — no character sub-records (Inventory/Injuries/
// Stances/Counters aren't indexed). Role-based visibility (e.g. hiding NPCs
// from Players) is applied client-side, same as everywhere else in this
// no-auth app — the server has no concept of role.
app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json({ characters: [], moves: [], perks: [], tells: [], tags: [] });
  const like = `%${q}%`;

  const characters = await all(
    'SELECT id, name, character_type FROM characters WHERE name LIKE ? ORDER BY name',
    [like]
  );
  const moves = await all(
    'SELECT id, name, description FROM moves WHERE name LIKE ? OR description LIKE ? ORDER BY name',
    [like, like]
  );
  const perks = await all(
    'SELECT id, name, description FROM perks WHERE name LIKE ? OR description LIKE ? ORDER BY name',
    [like, like]
  );
  const tells = await all('SELECT id, name FROM tells WHERE name LIKE ? ORDER BY name', [like]);
  const tags = await all(
    'SELECT id, name, description FROM tags WHERE name LIKE ? OR description LIKE ? ORDER BY name',
    [like, like]
  );

  res.json({ characters, moves, perks, tells, tags });
}));

// The fixed ruleset: 7 styles + the complete counter tournament (seeded once)
app.get('/api/ruleset', wrap(async (_req, res) => {
  res.json({
    attributes: await all('SELECT * FROM attributes ORDER BY id'),
    counters: await all('SELECT * FROM attribute_counters ORDER BY id'),
  });
}));

// Combat Arena: who's seated, the Uneven Combat toggle, each seated
// character's simplified stats (portrait/dice/stamina/active-stance name —
// read-only glance, kept live client-side via the existing
// character:updated/die:updated/stance:activated broadcasts), each seated
// character's available moves (for the Declaration Phase's declare-a-move
// picker), every counter relevant to the arena (standalone ones, plus any
// character counter flagged Show in Combat), the round/Tic timing state,
// and every declared move so far this fight (Tell-only until revealed).
app.get('/api/combat', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  const [state, participants, pairs] = await Promise.all([
    one('SELECT * FROM combat_state WHERE id = 1'),
    all('SELECT * FROM combat_participants ORDER BY side, pair_index, id'),
    all('SELECT * FROM combat_pairs ORDER BY pair_index'),
  ]);

  const charIds = [...new Set(participants.map((p) => p.character_id))];
  const marks = charIds.map(() => '?').join(',');

  // Batched IN-clause lookups instead of a per-participant loop — this used
  // to be 3 sequential queries PER seated character (a real N+1 against
  // Turso's networked connection, and the main cause of "adding a
  // character takes ~4 seconds"); now it's 4 total (moves is naturally one
  // per character, getMovesFor's own shape), run concurrently regardless of
  // how many are seated.
  const [charRows, diceRows, stanceRows, counters, movesByChar, declaredMoveRows] = await Promise.all([
    charIds.length ? all(`SELECT * FROM characters WHERE id IN (${marks})`, charIds) : [],
    charIds.length ? all(`SELECT * FROM dice WHERE character_id IN (${marks}) ORDER BY id`, charIds) : [],
    charIds.length ? all(`SELECT * FROM stances WHERE character_id IN (${marks}) ORDER BY id`, charIds) : [],
    charIds.length
      ? all(
          `SELECT * FROM counters WHERE character_id IS NULL OR (show_in_combat = 1 AND character_id IN (${marks})) ORDER BY id`,
          charIds
        )
      : all('SELECT * FROM counters WHERE character_id IS NULL ORDER BY id'),
    Promise.all(charIds.map((id) => getMovesFor(id))),
    fetchDeclaredMoveRows(),
  ]);
  const declaredMoves = mapDeclaredMovesForViewer(
    declaredMoveRows,
    state.current_tic,
    viewer,
    state.phase,
    state.round_number
  );

  const characters = {};
  for (const character of charRows) {
    characters[character.id] = { character: omitVitruvianArt(character), dice: [], stances: [] };
  }
  for (const die of diceRows) characters[die.character_id]?.dice.push(die);
  for (const stance of stanceRows) characters[stance.character_id]?.stances.push(stance);
  charIds.forEach((id, i) => {
    if (characters[id]) characters[id].moves = movesByChar[i];
  });

  const tic = relativeTic({
    tic: state.current_tic,
    roundStartTic: state.round_start_tic,
    roundLength: state.round_length,
  });

  res.json({
    unevenCombatEnabled: Boolean(state.uneven_combat_enabled),
    phase: state.phase,
    roundNumber: state.round_number,
    currentTic: state.current_tic,
    roundStartTic: state.round_start_tic,
    roundLength: state.round_length,
    relativeTic: tic.relative,
    isOverflow: tic.isOverflow,
    overflowBy: tic.overflowBy,
    pairs,
    participants,
    characters,
    counters,
    declaredMoves,
  });
}));

app.post('/api/characters', wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const characterType = req.body?.characterType === 'npc' ? 'npc' : 'pc';

  let folderId = null;
  if (req.body?.folderId != null) {
    const folder = await one('SELECT id FROM character_folders WHERE id = ?', [req.body.folderId]);
    if (folder) folderId = folder.id;
  }

  // Dice seed at d8, so starting Max Stamina = 4 x (8 + 0); Current starts at Max.
  const maxStamina = computeMaxStamina(4, 8, 0);
  const result = await run(
    'INSERT INTO characters (name, character_type, max_stamina, current_stamina, folder_id) VALUES (?, ?, ?, ?, ?)',
    [name, characterType, maxStamina, maxStamina, folderId]
  );
  const id = Number(result.lastInsertRowid);

  for (const t of DICE_TEMPLATE) {
    await run('INSERT INTO dice (character_id, pool, slot_name) VALUES (?, ?, ?)', [
      id,
      t.pool,
      t.slot_name,
    ]);
  }

  const character = await getCharacter(id);
  io.emit('character:created', character);
  res.status(201).json(character);
}));

app.put('/api/characters/:id', wrap(async (req, res) => {
  const character = await getCharacter(req.params.id);
  if (!character) return res.status(404).json({ error: 'not found' });

  const sets = [];
  const args = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    sets.push('name = ?');
    args.push(name);
  }
  if (req.body?.imageData !== undefined) {
    sets.push('image_data = ?', 'image_mime_type = ?');
    args.push(String(req.body.imageData), String(req.body.imageMimeType ?? 'image/jpeg'));
  }
  // GM-only client-side (same trust model as everywhere else in this
  // no-auth app) — replaces Tab 1's default backdrop figure for this
  // character specifically. No "clear" affordance, matching the portrait
  // upload above: re-uploading replaces, there's no revert-to-default.
  if (req.body?.vitruvianImageData !== undefined) {
    sets.push('vitruvian_image_data = ?', 'vitruvian_image_mime_type = ?');
    args.push(String(req.body.vitruvianImageData), String(req.body.vitruvianImageMimeType ?? 'image/jpeg'));
  }
  if (sets.length) {
    args.push(character.id);
    await run(`UPDATE characters SET ${sets.join(', ')} WHERE id = ?`, args);
  }

  const updated = await getCharacter(character.id);
  io.emit('character:updated', updated);
  res.json(updated);
}));

app.delete('/api/characters/:id', wrap(async (req, res) => {
  const character = await getCharacter(req.params.id);
  if (!character) return res.status(404).json({ error: 'not found' });

  // Explicit cascade, in dependency order. Chat log rows are deliberately
  // kept — the plan wants roll history to survive character deletion.
  await run('DELETE FROM dice WHERE character_id = ?', [character.id]);
  await run('DELETE FROM inventory_items WHERE character_id = ?', [character.id]);
  await run('DELETE FROM injuries WHERE character_id = ?', [character.id]);
  await run('DELETE FROM stances WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_moves WHERE character_id = ?', [character.id]);
  await run('DELETE FROM roleplay_entries WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_move_tags WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_move_overrides WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_move_roll_bonuses WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_perks WHERE character_id = ?', [character.id]);
  await run('DELETE FROM counters WHERE character_id = ?', [character.id]);
  await run('DELETE FROM declared_moves WHERE character_id = ?', [character.id]);
  const wasSeated = await one('SELECT id FROM combat_participants WHERE character_id = ?', [
    character.id,
  ]);
  await run('DELETE FROM combat_participants WHERE character_id = ?', [character.id]);
  await run('DELETE FROM characters WHERE id = ?', [character.id]);

  io.emit('character:deleted', { id: character.id });
  if (wasSeated) await emitCombatUpdated();
  res.json({ ok: true });
}));

app.get('/api/chat', wrap(async (_req, res) => {
  const rows = await all(`
    SELECT c.id, c.kind, c.character_id, c.modifier, c.dice_rolled, c.content,
           c.image_data, c.image_mime_type, c.payload, c.created_at,
           ch.name AS character_name,
           m.id AS move_id, m.name AS move_name, m.image_data AS move_image_data,
           m.image_mime_type AS move_image_mime_type, m.startup_tics AS move_startup_tics,
           m.active_tics AS move_active_tics, m.recovery_tics AS move_recovery_tics,
           m.description AS move_description, m.stamina_cost AS move_stamina_cost
    FROM chat_log c
    LEFT JOIN characters ch ON ch.id = c.character_id
    LEFT JOIN moves m ON m.id = c.move_id
    ORDER BY c.id
  `);
  // `full` (everything MoveCard needs beyond the compact fields above — see
  // postMoveReveals) is fetched once per distinct still-existing move
  // referenced by a move_reveal row, not per chat row — a fight can post
  // the same move's reveal card many times over.
  const revealedMoveIds = [...new Set(
    rows.filter((r) => r.kind === 'move_reveal' && r.move_id != null).map((r) => r.move_id)
  )];
  const fullMoveById = new Map();
  if (revealedMoveIds.length) {
    const marks = revealedMoveIds.map(() => '?').join(',');
    const fullMoves = await attachInteractions(
      await all(`SELECT * FROM moves WHERE id IN (${marks})`, revealedMoveIds)
    );
    for (const m of fullMoves) fullMoveById.set(m.id, m);
  }
  // Attack Target (Change 001), 6.3: a roll's payload freezes
  // effectiveAttackTargets/attackTargetSource at roll time, but a
  // Successful Block can update the underlying declared_moves row *after*
  // that roll was logged — so on reload the chat feed must re-read current
  // state rather than trust the frozen payload (in-memory defenseResolutions
  // only covers a still-open live session). One batched query for every
  // distinct declaredMoveId referenced by a 'roll' row, not one per row.
  const rollDeclaredMoveIds = [...new Set(
    rows
      .filter((r) => r.kind === 'roll' && r.payload)
      .map((r) => {
        try {
          return JSON.parse(r.payload)?.declaredMoveId;
        } catch {
          return null;
        }
      })
      .filter((id) => id != null)
  )];
  const attackTargetsByDeclaredMoveId = new Map();
  if (rollDeclaredMoveIds.length) {
    const marks = rollDeclaredMoveIds.map(() => '?').join(',');
    const targetRows = await all(
      `SELECT id, effective_attack_targets, attack_target_source FROM declared_moves WHERE id IN (${marks})`,
      rollDeclaredMoveIds
    );
    for (const row of targetRows) {
      attackTargetsByDeclaredMoveId.set(row.id, {
        effectiveAttackTargets: parseConcreteAttackTargets(row.effective_attack_targets),
        attackTargetSource: row.attack_target_source,
      });
    }
  }
  res.json(
    rows.map((row) => {
      const dice = JSON.parse(row.dice_rolled);
      const isGmPost = row.character_id === GM_CHAT_SENTINEL_ID;
      return {
        id: row.id,
        kind: row.kind,
        characterId: isGmPost ? null : row.character_id,
        characterName: isGmPost ? 'GM' : (row.character_name ?? '(deleted)'),
        modifier: row.modifier,
        dice,
        total: dice.reduce((sum, d) => sum + d.result, 0),
        message: row.content,
        imageData: row.image_data,
        imageMimeType: row.image_mime_type,
        move: row.kind === 'move_reveal'
          ? row.move_id == null
            ? null
            : {
                id: row.move_id,
                name: row.move_name,
                imageData: row.move_image_data,
                imageMimeType: row.move_image_mime_type,
                startupTics: row.move_startup_tics,
                activeTics: row.move_active_tics,
                recoveryTics: row.move_recovery_tics,
                description: row.move_description,
                staminaCost: row.move_stamina_cost,
                full: fullMoveById.get(row.move_id) ?? null,
              }
          : undefined,
        // lane_snapshot rows carry the whole snapshot as JSON (pairIndex,
        // round/Tic window, every currently-revealed move in the lane with
        // its own embedded `full` data) — self-contained at write time (see
        // buildLaneSnapshotPayload), so no server-side joining needed here.
        ...(row.kind === 'lane_snapshot' && row.payload ? JSON.parse(row.payload) : {}),
        // roll rows carry the same roll-context shape (Combat Automation,
        // sub-phase 3) whenever this roll was for a declared move's own
        // reveal-time Roll — see buildRollContext/logRoll above and the
        // payload column's own comment in db.js. Absent (undefined) for
        // every other roll (Dice Tray, a manual Stat roll, initiative), same
        // as `move` above is absent for a non-move_reveal row.
        ...(row.kind === 'roll' && row.payload ? JSON.parse(row.payload) : {}),
        // Attack Target (Change 001): override the payload's frozen
        // effectiveAttackTargets/attackTargetSource, if any, with current
        // declared_moves state — see attackTargetsByDeclaredMoveId above.
        ...(row.kind === 'roll' && row.payload
          ? (() => {
              let declaredMoveId;
              try {
                declaredMoveId = JSON.parse(row.payload)?.declaredMoveId;
              } catch {
                declaredMoveId = null;
              }
              return declaredMoveId != null ? attackTargetsByDeclaredMoveId.get(declaredMoveId) ?? {} : {};
            })()
          : {}),
        timestamp: sqliteToIso(row.created_at),
      };
    })
  );
}));

// ---------- Socket.io game events ----------

// A Counter's optional reward tag — purely cosmetic (no mechanical
// effect), character-owned counters only. See counter:create/counter:set_reward.
const REWARD_TYPES = ['story', 'statistic', 'perk', 'move', 'combat_prowess'];

// chat_log.character_id's sentinel for "the GM, generically" (chat:message
// only — a real character always backs every roll/move_reveal entry).
// characters.id is an AUTOINCREMENT rowid starting at 1, so 0 can never
// collide with a real row; chat_log.character_id stays NOT NULL without a
// schema change.
const GM_CHAT_SENTINEL_ID = 0;

// Combat Automation (Phase 9, sub-phase 3): the Damage Application dialog's
// single-level Undo (4.1 — "reverts the single most recent change made
// inside this dialog... one level, not a full history"). Deliberately
// module-scoped, not per-socket: the dialog's own state already lives
// entirely in whichever GM browser tab has it open, but the *die* it last
// touched is shared game state, not a per-connection thing (matches every
// other piece of combat state in this app, which is one shared DB row/table,
// never per-socket). Lost on server restart same as everything else
// ephemeral here — nothing durable is ever built on top of an Undo buffer.
let lastDamageChange = null; // { dieId, current_size, bonus, status, half_damage } | null

io.on('connection', (socket) => {
  const on = (event, handler) => {
    socket.on(event, async (payload) => {
      try {
        await handler(payload ?? {});
      } catch (err) {
        console.error(`error handling ${event}:`, err);
      }
    });
  };

  // Who this connection is playing as — stored per-socket, in memory only
  // (lost on disconnect, matching the no-login/session-only model; the
  // client re-sends it on every reconnect — see roleContext.jsx). Drives
  // declared-move visibility in combat:updated/GET /api/combat, replacing
  // the old declared_move:own hack that only worked for the exact socket
  // that clicked declare, not "whoever is logged in as that character".
  on('identity:set', async ({ role, characterId }) => {
    if (role === 'gm') {
      socket.data.identity = { role: 'gm' };
      return;
    }
    const id = Number(characterId);
    if (role === 'player' && Number.isInteger(id)) {
      const character = await one('SELECT id FROM characters WHERE id = ?', [id]);
      socket.data.identity = character ? { role: 'player', characterId: character.id } : null;
    }
  });

  on('die:roll', async ({ characterId, dieId, modifier }) => {
    const die = await one('SELECT * FROM dice WHERE id = ? AND character_id = ?', [
      dieId,
      characterId,
    ]);
    if (!die || die.status !== 'active') return;
    const character = await getCharacter(die.character_id);
    if (!character) return;
    const mod = clampModifier(modifier) + (await getReasonsToFightBonus(character.id));
    const result = rollDie(die.current_size) + die.bonus + mod;
    await logRoll({
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      dice: [{ slot_name: die.slot_name, size: die.current_size, bonus: die.bonus, result }],
    });
  });

  // A raw ad-hoc roll of one die size (d4-d12) plus a modifier, not tied to
  // any character's own die — the chat Dice Tray (item 1) and a move's
  // Custom Roll type (item 2, base die instead of a Stat) both funnel
  // through this one event rather than duplicating roll/log logic.
  // `characterId: null` posts as the generic GM persona, same convention as
  // chat:message — reasons-to-fight only applies when a real character is
  // attributed, since a GM-persona roll isn't any seated character's own.
  // `declaredMoveId` (Combat Automation, sub-phase 3, optional): passed only
  // by the reveal-time auto-Roll dialog (CombatHeaderBar.jsx) for a
  // Custom-Roll-type move's own Roll — see buildRollContext above. Never
  // set for the Dice Tray or a GM-posted roll (asGm is always context-free).
  on('dice:roll_custom', async ({ characterId, size, modifier, declaredMoveId }) => {
    const die = Number(size);
    if (!DIE_SIZES.includes(die)) return;
    const asGm = characterId == null;
    const character = asGm ? null : await getCharacter(characterId);
    if (!asGm && !character) return;
    const mod = clampModifier(modifier) + (asGm ? 0 : await getReasonsToFightBonus(character.id));
    const result = rollDie(die) + mod;
    const rollContext = asGm ? null : await buildRollContext(character.id, declaredMoveId);
    await logRoll({
      characterId: asGm ? GM_CHAT_SENTINEL_ID : character.id,
      characterName: asGm ? 'GM' : character.name,
      modifier: mod,
      dice: [{ slot_name: 'Custom', size: die, bonus: 0, result }],
      rollContext,
    });
    if (!asGm) await fireMissIfNoDamage(character, rollContext, result);
  });

  // Selection-based pool roll: any set of the character's dice, rolled
  // together with one shared modifier (not tied to a body section).
  // `declaredMoveId` (Combat Automation, sub-phase 3, optional) — see
  // dice:roll_custom's identical comment just above.
  on('pool:roll', async ({ characterId, dieIds, modifier, declaredMoveId }) => {
    const character = await getCharacter(characterId);
    if (!character || !Array.isArray(dieIds) || !dieIds.length) return;
    const ids = [...new Set(dieIds.map(Number).filter(Number.isInteger))];
    if (!ids.length) return;
    const dice = (
      await all(
        `SELECT * FROM dice WHERE character_id = ? AND status = 'active' AND id IN (${ids
          .map(() => '?')
          .join(',')}) ORDER BY id`,
        [character.id, ...ids]
      )
    );
    if (!dice.length) return;
    const mod = clampModifier(modifier) + (await getReasonsToFightBonus(character.id));
    const rolledDice = dice.map((d) => ({
      slot_name: d.slot_name,
      size: d.current_size,
      bonus: d.bonus,
      result: rollDie(d.current_size) + d.bonus + mod,
    }));
    const rollContext = await buildRollContext(character.id, declaredMoveId);
    await logRoll({
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      dice: rolledDice,
      rollContext,
    });
    const total = rolledDice.reduce((sum, d) => sum + d.result, 0);
    await fireMissIfNoDamage(character, rollContext, total);
  });

  // Combat Automation (Phase 9): the Damage Application dialog's Stat
  // clicks (4.1/4.2) — applies `halfDamageSteps` half-damage steps in
  // sequence to one target die via applyHalfDamage (gameLogic.js), exactly
  // as 4.1 specifies ("calling applyHalfDamage that many times in sequence
  // against that Stat's current state"). `attackerDeclaredMoveId` (sub-phase
  // 5, optional): the chat roll card's own declaredMoveId, passed through by
  // DamageApplicationDialog whenever this Apply is for a roll tied to a
  // declared move (never for ad-hoc/manual GM damage). Fires that move's
  // own 'hit' trigger automations exactly once per declared move — guarded
  // by interactions_resolved so a Partial Block's own reduced damage (still
  // applied through this same event, per 4.2) doesn't also fire 'hit' on
  // top of the 'block' trigger combat:resolve_defense already fired for it.
  on('combat:apply_damage', async ({ dieId, halfDamageSteps, attackerDeclaredMoveId }) => {
    const die = await one('SELECT * FROM dice WHERE id = ?', [dieId]);
    if (!die) return;
    const steps = Math.max(0, Math.trunc(Number(halfDamageSteps) || 0));
    if (!steps) return;

    // Attack Target (Change 001), 6.5: server-authoritative hard restriction
    // — checked before any die mutation, Undo buffer write, Chat audit line,
    // or interaction automation, so a stale/manual client can't bypass it.
    // No attackerDeclaredMoveId at all (manual GM damage) keeps prior
    // unrestricted behavior — Attack Target only ever gates a damage
    // Apply that's actually tied to a declared attack.
    if (attackerDeclaredMoveId != null) {
      const attack = await one(
        'SELECT effective_attack_targets FROM declared_moves WHERE id = ?',
        [attackerDeclaredMoveId]
      );
      if (!attack) return;
      const allowed = new Set(parseConcreteAttackTargets(attack.effective_attack_targets));
      if (!allowed.has(die.slot_name)) return;
    }

    let next = {
      current_size: die.current_size,
      bonus: die.bonus,
      status: die.status,
      half_damage: Boolean(die.half_damage),
    };
    for (let i = 0; i < steps; i++) next = applyHalfDamage(next);

    // Snapshot BEFORE this change, for combat:undo_damage below — overwrites
    // whatever was previously buffered, matching the plan's single-level
    // ("not a full history") Undo.
    lastDamageChange = {
      dieId: die.id,
      current_size: die.current_size,
      bonus: die.bonus,
      status: die.status,
      half_damage: die.half_damage,
    };
    await run('UPDATE dice SET current_size = ?, bonus = ?, status = ?, half_damage = ? WHERE id = ?', [
      next.current_size,
      next.bonus,
      next.status,
      next.half_damage ? 1 : 0,
      die.id,
    ]);
    io.emit('die:updated', diePayload({ ...die, ...next, half_damage: next.half_damage ? 1 : 0 }));

    // Suggested addition, 4's "Suggested additional automation points" list:
    // a small chat audit line the moment damage is actually applied, rather
    // than the only record of it sitting silently in the die's own state.
    const character = await getCharacter(die.character_id);
    if (character) {
      await postSystemMessage(`${character.name} took ${steps * 0.5} damage to ${die.slot_name}.`);
    }

    if (attackerDeclaredMoveId != null) {
      const attackerDM = await one(
        'SELECT move_id, character_id, interactions_resolved FROM declared_moves WHERE id = ?',
        [attackerDeclaredMoveId]
      );
      if (attackerDM && !attackerDM.interactions_resolved) {
        await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [attackerDeclaredMoveId]);
        await applyMoveInteractions({
          moveId: attackerDM.move_id,
          trigger: 'hit',
          selfCharacterId: attackerDM.character_id,
          selfDeclaredMoveId: attackerDeclaredMoveId,
          opponentCharacterId: die.character_id,
        });
      }
    }
  });

  // Undo (4.1): reverts the single most recent combat:apply_damage change,
  // one level only — matches the Apply dialog's own "reverts the last
  // change" (singular) behavior, not a full history. A no-op if nothing's
  // buffered (nothing applied yet this session, or it was already undone).
  on('combat:undo_damage', async () => {
    const change = lastDamageChange;
    if (!change) return;
    lastDamageChange = null;
    await run('UPDATE dice SET current_size = ?, bonus = ?, status = ?, half_damage = ? WHERE id = ?', [
      change.current_size,
      change.bonus,
      change.status,
      change.half_damage,
      change.dieId,
    ]);
    const die = await one('SELECT * FROM dice WHERE id = ?', [change.dieId]);
    if (die) io.emit('die:updated', diePayload(die));
  });

  on('die:step', async ({ dieId, direction }) => {
    if (!['up', 'down'].includes(direction)) return;
    const die = await one('SELECT * FROM dice WHERE id = ?', [dieId]);
    if (!die) return;
    const next = stepDie(die, direction);
    if (
      next.current_size === die.current_size &&
      next.bonus === die.bonus &&
      next.status === die.status
    ) {
      return; // incapacitated die stepped down: no-op
    }
    await run('UPDATE dice SET current_size = ?, bonus = ?, status = ? WHERE id = ?', [
      next.current_size,
      next.bonus,
      next.status,
      die.id,
    ]);
    io.emit('die:updated', diePayload({ ...die, ...next }));
  });

  // Manual click only — a raw flag flip, never the step-down-and-clear
  // effect (see applyHalfDamage in gameLogic.js), which is reserved for a
  // future automated effect to call instead.
  on('die:toggle_half_damage', async ({ dieId }) => {
    const die = await one('SELECT * FROM dice WHERE id = ?', [dieId]);
    if (!die) return;
    const half_damage = die.half_damage ? 0 : 1;
    await run('UPDATE dice SET half_damage = ? WHERE id = ?', [half_damage, die.id]);
    io.emit('die:updated', diePayload({ ...die, half_damage }));
  });

  on('character:lock_stats', async ({ characterId }) => {
    const [character, dice] = await Promise.all([getCharacter(characterId), getDice(characterId)]);
    if (!character) return;
    const stamina = dice.find((d) => d.slot_name === 'Stamina');
    const maxStamina = computeMaxStamina(
      character.stamina_multiplier,
      stamina.current_size,
      stamina.bonus
    );
    const currentStamina = Math.min(character.current_stamina, maxStamina);
    // Both UPDATEs are independent (different tables, no shared read), so
    // they run as one round trip instead of two.
    await Promise.all([
      run(
        'UPDATE dice SET locked_size = current_size, locked_bonus = bonus, locked_status = status WHERE character_id = ?',
        [character.id]
      ),
      run('UPDATE characters SET max_stamina = ?, current_stamina = ? WHERE id = ?', [
        maxStamina,
        currentStamina,
        character.id,
      ]),
    ]);
    // Broadcast from the rows already in hand (current_size/bonus/status
    // aren't touched by this UPDATE, only locked_*) — no re-fetch needed.
    io.emit('character:updated', { ...character, max_stamina: maxStamina, current_stamina: currentStamina });
    for (const die of dice) {
      io.emit(
        'die:updated',
        diePayload({ ...die, locked_size: die.current_size, locked_bonus: die.bonus, locked_status: die.status })
      );
    }
  });

  on('character:revert_stats', async ({ characterId }) => {
    const [character, dice, injuries] = await Promise.all([
      getCharacter(characterId),
      getDice(characterId),
      getInjuries(characterId),
    ]);
    if (!character) return;
    // Injuries affecting base stats (decided): reverting to the locked
    // baseline isn't a raw copy — each die's locked size/bonus/status first
    // has this character's per-slot Injury penalties (summed, since more
    // than one Injury can target the same slot) applied via applyRankPenalty.
    // Lock in Stats (character:lock_stats above) is unaffected by this.
    const penaltyBySlot = new Map();
    for (const injury of injuries) {
      if (!injury.slot_name || !injury.penalty) continue;
      penaltyBySlot.set(injury.slot_name, (penaltyBySlot.get(injury.slot_name) ?? 0) + injury.penalty);
    }
    const reverted = dice.map((die) => ({
      die,
      next: applyRankPenalty(
        { size: die.locked_size, bonus: die.locked_bonus, status: die.locked_status },
        penaltyBySlot.get(die.slot_name) ?? 0
      ),
    }));
    await Promise.all(
      reverted.map(({ die, next }) =>
        run('UPDATE dice SET current_size = ?, bonus = ?, status = ? WHERE id = ?', [
          next.size,
          next.bonus,
          next.status,
          die.id,
        ])
      )
    );
    for (const { die, next } of reverted) {
      io.emit(
        'die:updated',
        diePayload({ ...die, current_size: next.size, bonus: next.bonus, status: next.status })
      );
    }
  });

  on('stamina:regen', async ({ characterId }) => {
    const [character, stamina] = await Promise.all([
      getCharacter(characterId),
      getStaminaDie(characterId),
    ]);
    if (!character) return;
    if (!stamina || stamina.status !== 'active') return; // incapacitated dice can't be rolled
    const result = rollDie(stamina.current_size) + stamina.bonus;
    const currentStamina = clamp(
      character.current_stamina + result,
      0,
      character.max_stamina
    );
    await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [
      currentStamina,
      character.id,
    ]);
    io.emit('character:updated', { ...character, current_stamina: currentStamina });
    await logRoll({
      characterId: character.id,
      characterName: character.name,
      modifier: 0,
      dice: [
        {
          slot_name: 'Stamina',
          size: stamina.current_size,
          bonus: stamina.bonus,
          result,
        },
      ],
    });
  });

  on('stamina:adjust', async ({ characterId, delta }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    const change = Math.trunc(Number(delta) || 0);
    if (!change) return;
    const currentStamina = clamp(
      character.current_stamina + change,
      0,
      character.max_stamina
    );
    await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [
      currentStamina,
      character.id,
    ]);
    // Broadcast the row we already have plus the one field we just changed —
    // no need to round-trip back to the DB for data we already know.
    io.emit('character:updated', { ...character, current_stamina: currentStamina });
  });

  on('inventory:add', async ({ characterId, itemName, description }) => {
    const character = await getCharacter(characterId);
    const name = String(itemName ?? '').trim();
    if (!character || !name) return;
    await run(
      'INSERT INTO inventory_items (character_id, item_name, description) VALUES (?, ?, ?)',
      [character.id, name, String(description ?? '').trim()]
    );
    io.emit('inventory:updated', {
      characterId: character.id,
      items: await getInventory(character.id),
    });
  });

  on('inventory:update', async ({ itemId, itemName, description }) => {
    const item = await one('SELECT * FROM inventory_items WHERE id = ?', [itemId]);
    const name = String(itemName ?? '').trim();
    if (!item || !name) return;
    await run('UPDATE inventory_items SET item_name = ?, description = ? WHERE id = ?', [
      name,
      String(description ?? '').trim(),
      item.id,
    ]);
    io.emit('inventory:updated', {
      characterId: item.character_id,
      items: await getInventory(item.character_id),
    });
  });

  on('inventory:remove', async ({ itemId }) => {
    const item = await one('SELECT * FROM inventory_items WHERE id = ?', [itemId]);
    if (!item) return;
    await run('DELETE FROM inventory_items WHERE id = ?', [item.id]);
    io.emit('inventory:updated', {
      characterId: item.character_id,
      items: await getInventory(item.character_id),
    });
  });

  // Both stance attributes must exist and differ
  const validStancePair = async (attributeAId, attributeBId) => {
    if (!attributeAId || !attributeBId || attributeAId === attributeBId) return false;
    const found = await all(
      'SELECT id FROM attributes WHERE id IN (?, ?)',
      [attributeAId, attributeBId]
    );
    return found.length === 2;
  };

  on('stance:create', async ({ characterId, name, attributeAId, attributeBId }) => {
    const character = await getCharacter(characterId);
    const stanceName = String(name ?? '').trim();
    if (!character || !stanceName) return;
    if (!(await validStancePair(attributeAId, attributeBId))) return;
    const result = await run(
      'INSERT INTO stances (character_id, name, attribute_a_id, attribute_b_id) VALUES (?, ?, ?, ?)',
      [character.id, stanceName, attributeAId, attributeBId]
    );
    const stance = await one('SELECT * FROM stances WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]);
    io.emit('stance:created', stance);
    // A character's first stance auto-activates: one stance must be active
    // at all times once any exist.
    if (character.active_stance_id == null) {
      await run('UPDATE characters SET active_stance_id = ? WHERE id = ?', [
        stance.id,
        character.id,
      ]);
      io.emit('stance:activated', { characterId: character.id, stanceId: stance.id });
    }
  });

  on('stance:update', async ({ stanceId, name, attributeAId, attributeBId }) => {
    const stance = await one('SELECT * FROM stances WHERE id = ?', [stanceId]);
    const stanceName = String(name ?? '').trim();
    if (!stance || !stanceName) return;
    if (!(await validStancePair(attributeAId, attributeBId))) return;
    await run(
      'UPDATE stances SET name = ?, attribute_a_id = ?, attribute_b_id = ? WHERE id = ?',
      [stanceName, attributeAId, attributeBId, stance.id]
    );
    io.emit('stance:updated', await one('SELECT * FROM stances WHERE id = ?', [stance.id]));
  });

  on('stance:delete', async ({ stanceId }) => {
    const stance = await one('SELECT * FROM stances WHERE id = ?', [stanceId]);
    if (!stance) return;
    const siblings = await getStances(stance.character_id);
    if (siblings.length <= 1) return; // every character keeps at least one stance
    const character = await getCharacter(stance.character_id);
    // Deleting the active stance hands "active" to another one — one stance
    // stays active at all times.
    if (character.active_stance_id === stance.id) {
      const next = siblings.find((s) => s.id !== stance.id);
      await run('UPDATE characters SET active_stance_id = ? WHERE id = ?', [
        next.id,
        character.id,
      ]);
      io.emit('stance:activated', { characterId: character.id, stanceId: next.id });
    }
    await run('DELETE FROM stances WHERE id = ?', [stance.id]);
    io.emit('stance:deleted', { stanceId: stance.id, characterId: stance.character_id });
  });

  on('stance:activate', async ({ characterId, stanceId }) => {
    const stance = await one(
      'SELECT * FROM stances WHERE id = ? AND character_id = ?',
      [stanceId, characterId]
    );
    if (!stance) return;
    await run('UPDATE characters SET active_stance_id = ? WHERE id = ?', [
      stance.id,
      stance.character_id,
    ]);
    io.emit('stance:activated', { characterId: stance.character_id, stanceId: stance.id });
  });

  on('tell:create', async ({ name, imageData, imageMimeType }) => {
    const tellName = String(name ?? '').trim();
    if (!tellName) return;
    const result = await run(
      'INSERT INTO tells (name, image_data, image_mime_type) VALUES (?, ?, ?)',
      [tellName, imageData ?? null, imageData ? (imageMimeType ?? 'image/png') : null]
    );
    io.emit('tell:created', await one('SELECT * FROM tells WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  on('tell:update', async ({ tellId, name, imageData, imageMimeType }) => {
    const tell = await one('SELECT * FROM tells WHERE id = ?', [tellId]);
    const tellName = String(name ?? '').trim();
    if (!tell || !tellName) return;
    // image only replaced when a new one is provided
    if (imageData !== undefined) {
      await run('UPDATE tells SET name = ?, image_data = ?, image_mime_type = ? WHERE id = ?', [
        tellName,
        imageData,
        imageMimeType ?? 'image/png',
        tell.id,
      ]);
    } else {
      await run('UPDATE tells SET name = ? WHERE id = ?', [tellName, tell.id]);
    }
    io.emit('tell:updated', await one('SELECT * FROM tells WHERE id = ?', [tell.id]));
  });

  on('tell:delete', async ({ tellId }) => {
    const tell = await one('SELECT * FROM tells WHERE id = ?', [tellId]);
    if (!tell) return;
    const used = await one(
      'SELECT COUNT(*) AS count FROM moves WHERE tell_id = ? OR right_tell_id = ? OR left_tell_id = ?',
      [tell.id, tell.id, tell.id]
    );
    if (Number(used.count) > 0) return; // a Tell in use by moves can't be deleted
    await run('DELETE FROM tells WHERE id = ?', [tell.id]);
    io.emit('tell:deleted', { tellId: tell.id });
  });

  // Shared validation + write path for move create/update
  const writeMove = async (moveId, payload) => {
    const name = String(payload.name ?? '').trim();
    if (!name) return null;
    const startup = clampFrame(payload.startupTics);
    const active = clampFrame(payload.activeTics);
    const recovery = clampFrame(payload.recoveryTics);
    if (!validFrames(startup, active, recovery)) return null;
    const defenseFramePositions = sanitizeDefensePositions(
      payload.defenseFramePositions,
      startup + active + recovery
    );
    const staminaCost = clampStaminaCost(payload.staminaCost);
    const isDefault = payload.isDefault ? 1 : 0;
    const isDefensive = payload.isDefensive ? 1 : 0;
    const description = String(payload.description ?? '').trim();

    // Roll is optional — a move with no slots (or no custom die picked) has
    // no Roll at all. An ambiguous Hand/Leg slot means this move needs two
    // Tells (one per appendage choice) instead of the usual one.
    const rollModifier = clampRollBonus(payload.rollModifier);
    const rollType = sanitizeRollType(payload.rollType);
    // Mutually exclusive (decided): 'custom' always has empty roll_slots —
    // its base die comes from custom_roll_size, not a body-part stat — and
    // 'stat' always has a null custom_roll_size. Forced here regardless of
    // what the client actually sent, same pattern as a Default move's
    // styleAttributeId always being forced null above.
    const rollSlots = rollType === 'custom' ? [] : sanitizeRollSlots(payload.rollSlots);
    const customRollSize = rollType === 'custom' ? sanitizeCustomRollSize(payload.customRollSize) : null;
    const ambiguousRoll = hasAmbiguousRollSlot(rollSlots);
    // Attack Target (Change 001): no minimum — an empty array is a valid,
    // explicit "no Attack Target" and is never re-filled after the fact (see
    // db.js's own note on why the DB column default only fires once, at
    // migration, and never again for a plain empty save).
    const attackTargets = sanitizeAttackTargets(payload.attackTargets);

    let tellId;
    let rightTellId = null;
    let leftTellId = null;
    if (ambiguousRoll) {
      const [rightTell, leftTell] = await Promise.all([
        payload.rightTellId != null
          ? one('SELECT * FROM tells WHERE id = ?', [payload.rightTellId])
          : null,
        payload.leftTellId != null
          ? one('SELECT * FROM tells WHERE id = ?', [payload.leftTellId])
          : null,
      ]);
      if (!rightTell || !leftTell) return null;
      rightTellId = rightTell.id;
      leftTellId = leftTell.id;
      tellId = rightTell.id; // satisfies moves.tell_id's NOT NULL; unused once right/left are both set
    } else {
      if (payload.tellId == null) return null;
      const tell = await one('SELECT * FROM tells WHERE id = ?', [payload.tellId]);
      if (!tell) return null;
      tellId = tell.id;
    }

    // Style: one of the 7, or none. A Default move is usable by anyone,
    // anytime, so it never carries a Style gate — any styleAttributeId sent
    // alongside isDefault is silently dropped rather than stored, regardless
    // of what the client sent (see MoveCreator.jsx, which already hides the
    // picker in that case).
    let styleId = null;
    if (!isDefault && payload.styleAttributeId != null) {
      const style = await one('SELECT id FROM attributes WHERE id = ?', [
        payload.styleAttributeId,
      ]);
      if (!style) return null;
      styleId = style.id;
    }

    let folderId = null;
    if (payload.folderId != null) {
      const folder = await one('SELECT id FROM move_folders WHERE id = ?', [payload.folderId]);
      if (folder) folderId = folder.id;
    }

    // 0-10 tags, all must exist
    let tagIds = [];
    if (Array.isArray(payload.tagIds) && payload.tagIds.length) {
      const unique = [...new Set(payload.tagIds.map(Number).filter(Number.isInteger))].slice(0, 10);
      if (unique.length) {
        const found = await all(
          `SELECT id FROM tags WHERE id IN (${unique.map(() => '?').join(',')})`,
          unique
        );
        tagIds = found.map((t) => t.id);
      }
    }

    let id = moveId;
    if (id == null) {
      const result = await run(
        `INSERT INTO moves (name, is_default, tell_id, startup_tics, active_tics, recovery_tics,
          stamina_cost, description, style_attribute_id, folder_id, image_data, image_mime_type,
          roll_modifier, right_tell_id, left_tell_id, is_defensive, defense_frame_positions,
          roll_type, custom_roll_size, attack_targets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, isDefault, tellId, startup, active, recovery, staminaCost, description, styleId,
          folderId, payload.imageData ?? null,
          payload.imageData ? (payload.imageMimeType ?? 'image/png') : null,
          rollModifier, rightTellId, leftTellId, isDefensive, JSON.stringify(defenseFramePositions),
          rollType, customRollSize, JSON.stringify(attackTargets)]
      );
      id = Number(result.lastInsertRowid);
    } else {
      await run(
        `UPDATE moves SET name = ?, is_default = ?, tell_id = ?, startup_tics = ?, active_tics = ?,
          recovery_tics = ?, stamina_cost = ?, description = ?, style_attribute_id = ?, folder_id = ?,
          roll_modifier = ?, right_tell_id = ?, left_tell_id = ?, is_defensive = ?,
          defense_frame_positions = ?, roll_type = ?, custom_roll_size = ?, attack_targets = ?
          WHERE id = ?`,
        [name, isDefault, tellId, startup, active, recovery, staminaCost, description, styleId,
          folderId, rollModifier, rightTellId, leftTellId, isDefensive,
          JSON.stringify(defenseFramePositions), rollType, customRollSize, JSON.stringify(attackTargets), id]
      );
      // image only replaced when a new one is provided
      if (payload.imageData !== undefined) {
        await run('UPDATE moves SET image_data = ?, image_mime_type = ? WHERE id = ?', [
          payload.imageData,
          payload.imageMimeType ?? 'image/png',
          id,
        ]);
      }
      await run('DELETE FROM move_interactions WHERE move_id = ?', [id]);
    }
    await run('DELETE FROM move_tags WHERE move_id = ?', [id]);
    for (const tagId of tagIds) {
      await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [id, tagId]);
    }
    await run('DELETE FROM move_roll_slots WHERE move_id = ?', [id]);
    for (const slotName of rollSlots) {
      await run('INSERT INTO move_roll_slots (move_id, slot_name) VALUES (?, ?)', [id, slotName]);
    }
    for (const row of normalizeInteractions(payload.interactions, Boolean(isDefensive))) {
      await run(
        'INSERT INTO move_interactions (move_id, trigger, text, automations) VALUES (?, ?, ?, ?)',
        [id, row.trigger, row.text, JSON.stringify(row.automations)]
      );
    }
    return getMove(id);
  };

  on('move:create', async (payload) => {
    const move = await writeMove(null, payload ?? {});
    if (move) io.emit('move:created', move);
  });

  on('move:update', async (payload) => {
    const existing = await one('SELECT * FROM moves WHERE id = ?', [payload?.moveId]);
    if (!existing) return;
    const move = await writeMove(existing.id, payload);
    if (move) io.emit('move:updated', move);
  });

  on('move:delete', async ({ moveId }) => {
    const move = await one('SELECT * FROM moves WHERE id = ?', [moveId]);
    if (!move) return;
    await run('DELETE FROM move_interactions WHERE move_id = ?', [move.id]);
    await run('DELETE FROM move_tags WHERE move_id = ?', [move.id]);
    await run('DELETE FROM move_roll_slots WHERE move_id = ?', [move.id]);
    await run('DELETE FROM character_moves WHERE move_id = ?', [move.id]);
    await run('DELETE FROM character_move_tags WHERE move_id = ?', [move.id]);
    await run('DELETE FROM character_move_overrides WHERE move_id = ?', [move.id]);
    await run('DELETE FROM character_move_roll_bonuses WHERE move_id = ?', [move.id]);
    // declared_moves.move_id has no ON DELETE clause (unlike character_id's
    // CASCADE) — deleting a move that's currently declared mid-fight would
    // otherwise throw a foreign key error and leave the move half-deleted.
    await run('DELETE FROM declared_moves WHERE move_id = ?', [move.id]);
    await run('DELETE FROM moves WHERE id = ?', [move.id]);
    io.emit('move:deleted', { moveId: move.id });
  });

  on('move:grant', async ({ characterId, moveId }) => {
    const character = await getCharacter(characterId);
    const move = await one('SELECT * FROM moves WHERE id = ?', [moveId]);
    if (!character || !move) return;
    // Learnability: a styled move needs at least one stance with that style
    if (
      move.style_attribute_id != null &&
      !(await characterHasStyle(character.id, move.style_attribute_id))
    ) {
      return;
    }
    await run('INSERT OR IGNORE INTO character_moves (character_id, move_id) VALUES (?, ?)', [
      character.id,
      move.id,
    ]);
    io.emit('move:granted', { characterId: character.id, moveId: move.id });
  });

  on('tag:create', async ({ name, description }) => {
    const tagName = String(name ?? '').trim();
    if (!tagName) return;
    const result = await run('INSERT INTO tags (name, description) VALUES (?, ?)', [
      tagName,
      String(description ?? '').trim(),
    ]);
    io.emit('tag:created', await one('SELECT * FROM tags WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  on('tag:update', async ({ tagId, name, description }) => {
    const tag = await one('SELECT * FROM tags WHERE id = ?', [tagId]);
    const tagName = String(name ?? '').trim();
    if (!tag || !tagName) return;
    await run('UPDATE tags SET name = ?, description = ? WHERE id = ?', [
      tagName,
      String(description ?? '').trim(),
      tag.id,
    ]);
    io.emit('tag:updated', await one('SELECT * FROM tags WHERE id = ?', [tag.id]));
  });

  on('tag:delete', async ({ tagId }) => {
    const tag = await one('SELECT * FROM tags WHERE id = ?', [tagId]);
    if (!tag) return;
    await run('DELETE FROM move_tags WHERE tag_id = ?', [tag.id]);
    await run('DELETE FROM character_move_tags WHERE tag_id = ?', [tag.id]);
    await run('DELETE FROM tags WHERE id = ?', [tag.id]);
    io.emit('tag:deleted', { tagId: tag.id });
  });

  on('folder:create', async ({ name, parentFolderId }) => {
    const folderName = String(name ?? '').trim();
    if (!folderName) return;
    let parentId = null;
    if (parentFolderId != null) {
      const parent = await one('SELECT id FROM move_folders WHERE id = ?', [parentFolderId]);
      if (parent) parentId = parent.id; // unknown parent falls back to root
    }
    const result = await run('INSERT INTO move_folders (name, parent_id) VALUES (?, ?)', [
      folderName,
      parentId,
    ]);
    io.emit('folder:created', await one('SELECT * FROM move_folders WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  on('folder:rename', async ({ folderId, name }) => {
    const folder = await one('SELECT * FROM move_folders WHERE id = ?', [folderId]);
    const folderName = String(name ?? '').trim();
    if (!folder || !folderName) return;
    await run('UPDATE move_folders SET name = ? WHERE id = ?', [folderName, folder.id]);
    io.emit('folder:updated', await one('SELECT * FROM move_folders WHERE id = ?', [folder.id]));
  });

  on('folder:delete', async ({ folderId }) => {
    const folder = await one('SELECT * FROM move_folders WHERE id = ?', [folderId]);
    if (!folder) return;
    // Directly-contained moves and direct child disciplines promote one
    // level, to this discipline's own parent (root if it was already at
    // root) — not unconditionally to root, so deleting a nested discipline
    // only collapses that one level rather than flattening the whole subtree.
    await run('UPDATE moves SET folder_id = ? WHERE folder_id = ?', [folder.parent_id, folder.id]);
    await run('UPDATE move_folders SET parent_id = ? WHERE parent_id = ?', [folder.parent_id, folder.id]);
    await run('DELETE FROM move_folders WHERE id = ?', [folder.id]);
    io.emit('folder:deleted', { folderId: folder.id, parentFolderId: folder.parent_id });
  });

  // Drag-and-drop reassignment: touches only folder_id, unlike move:update
  // which replaces the whole move (interactions/tags included).
  on('move:set_folder', async ({ moveId, folderId }) => {
    const move = await one('SELECT * FROM moves WHERE id = ?', [moveId]);
    if (!move) return;
    let target = null;
    if (folderId != null) {
      const folder = await one('SELECT id FROM move_folders WHERE id = ?', [folderId]);
      if (folder) target = folder.id;
    }
    await run('UPDATE moves SET folder_id = ? WHERE id = ?', [target, move.id]);
    io.emit('move:updated', await getMove(move.id));
  });

  // Character-list folders — GM-managed (client-side gated), same structural
  // pattern as move folders: create/rename/delete, delete returns to root.
  on('character_folder:create', async ({ name, parentFolderId }) => {
    const folderName = String(name ?? '').trim();
    if (!folderName) return;
    let parentId = null;
    if (parentFolderId != null) {
      const parent = await one('SELECT id FROM character_folders WHERE id = ?', [parentFolderId]);
      if (parent) parentId = parent.id; // unknown parent falls back to root
    }
    const result = await run('INSERT INTO character_folders (name, parent_id) VALUES (?, ?)', [
      folderName,
      parentId,
    ]);
    io.emit('character_folder:created', await one('SELECT * FROM character_folders WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  on('character_folder:rename', async ({ folderId, name }) => {
    const folder = await one('SELECT * FROM character_folders WHERE id = ?', [folderId]);
    const folderName = String(name ?? '').trim();
    if (!folder || !folderName) return;
    await run('UPDATE character_folders SET name = ? WHERE id = ?', [folderName, folder.id]);
    io.emit(
      'character_folder:updated',
      await one('SELECT * FROM character_folders WHERE id = ?', [folder.id])
    );
  });

  on('character_folder:delete', async ({ folderId }) => {
    const folder = await one('SELECT * FROM character_folders WHERE id = ?', [folderId]);
    if (!folder) return;
    // Directly-contained characters and direct child folders promote one
    // level, to this folder's own parent (root if it was already at root) —
    // not unconditionally to root, so deleting a nested folder only
    // collapses that one level rather than flattening the whole subtree.
    await run('UPDATE characters SET folder_id = ? WHERE folder_id = ?', [folder.parent_id, folder.id]);
    await run('UPDATE character_folders SET parent_id = ? WHERE parent_id = ?', [folder.parent_id, folder.id]);
    await run('DELETE FROM character_folders WHERE id = ?', [folder.id]);
    io.emit('character_folder:deleted', { folderId: folder.id, parentFolderId: folder.parent_id });
  });

  // Drag-and-drop reassignment: touches only folder_id.
  on('character:set_folder', async ({ characterId, folderId }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    let target = null;
    if (folderId != null) {
      const folder = await one('SELECT id FROM character_folders WHERE id = ?', [folderId]);
      if (folder) target = folder.id;
    }
    await run('UPDATE characters SET folder_id = ? WHERE id = ?', [target, character.id]);
    io.emit('character:updated', { ...character, folder_id: target });
  });

  on('move:revoke', async ({ characterId, moveId }) => {
    await run('DELETE FROM character_moves WHERE character_id = ? AND move_id = ?', [
      characterId,
      moveId,
    ]);
    io.emit('move:revoked', { characterId: Number(characterId), moveId: Number(moveId) });
  });

  // Shared validation + write path for perk create/update. Perks are just
  // picture/name/description now — mechanical effects are handled per-Perk
  // in server/perkAutomations.js's PERK_HOOKS, not stored automation data.
  const writePerk = async (perkId, payload) => {
    const name = String(payload.name ?? '').trim();
    if (!name) return null;
    const description = String(payload.description ?? '').trim();

    let id = perkId;
    if (id == null) {
      const result = await run(
        'INSERT INTO perks (name, description, image_data, image_mime_type) VALUES (?, ?, ?, ?)',
        [name, description, payload.imageData ?? null, payload.imageData ? (payload.imageMimeType ?? 'image/png') : null]
      );
      id = Number(result.lastInsertRowid);
    } else {
      await run('UPDATE perks SET name = ?, description = ? WHERE id = ?', [name, description, id]);
      if (payload.imageData !== undefined) {
        await run('UPDATE perks SET image_data = ?, image_mime_type = ? WHERE id = ?', [
          payload.imageData,
          payload.imageMimeType ?? 'image/png',
          id,
        ]);
      }
    }
    return getPerk(id);
  };

  on('perk:create', async (payload) => {
    const perk = await writePerk(null, payload ?? {});
    if (perk) io.emit('perk:created', perk);
  });

  on('perk:update', async (payload) => {
    const existing = await one('SELECT * FROM perks WHERE id = ?', [payload?.perkId]);
    if (!existing) return;
    const perk = await writePerk(existing.id, payload);
    if (perk) io.emit('perk:updated', perk);
  });

  on('perk:delete', async ({ perkId }) => {
    const perk = await one('SELECT * FROM perks WHERE id = ?', [perkId]);
    if (!perk) return;
    const inUse = await one('SELECT COUNT(*) AS count FROM character_perks WHERE perk_id = ?', [perk.id]);
    if (Number(inUse.count) > 0) return; // must be revoked from everyone first
    await run('DELETE FROM perks WHERE id = ?', [perk.id]);
    io.emit('perk:deleted', { perkId: perk.id });
  });

  on('perk:grant', async ({ characterId, perkId }) => {
    const character = await getCharacter(characterId);
    const perk = await one('SELECT * FROM perks WHERE id = ?', [perkId]);
    if (!character || !perk) return;
    const existing = await one(
      'SELECT * FROM character_perks WHERE character_id = ? AND perk_id = ?',
      [character.id, perk.id]
    );
    if (existing) return;

    const result = await run('INSERT INTO character_perks (character_id, perk_id) VALUES (?, ?)', [
      character.id,
      perk.id,
    ]);
    const characterPerkId = Number(result.lastInsertRowid);

    await PERK_HOOKS[perk.name]?.onGrant?.({ characterId: character.id, perkId: perk.id, characterPerkId });

    io.emit('perk:granted', { characterId: character.id, perkId: perk.id });
  });

  on('perk:revoke', async ({ characterId, perkId }) => {
    const characterPerk = await one(
      'SELECT * FROM character_perks WHERE character_id = ? AND perk_id = ?',
      [characterId, perkId]
    );
    if (!characterPerk) return;
    const perk = await one('SELECT * FROM perks WHERE id = ?', [characterPerk.perk_id]);

    // Move-scoped rows a manual PERK_HOOKS.onGrant may have tagged with this
    // grant — cleaned up in bulk here rather than by the hook itself.
    await run('DELETE FROM character_move_tags WHERE source_character_perk_id = ?', [characterPerk.id]);
    await run('DELETE FROM character_move_overrides WHERE source_character_perk_id = ?', [characterPerk.id]);
    await run('DELETE FROM character_move_roll_bonuses WHERE source_character_perk_id = ?', [characterPerk.id]);
    await run('DELETE FROM character_perks WHERE id = ?', [characterPerk.id]);

    await PERK_HOOKS[perk?.name]?.onRevoke?.({
      characterId: characterPerk.character_id,
      perkId: characterPerk.perk_id,
      characterPerkId: characterPerk.id,
    });

    io.emit('perk:revoked', { characterId: characterPerk.character_id, perkId: characterPerk.perk_id });
  });

  const emitRoleplay = async (characterId) =>
    io.emit('roleplay:updated', { characterId, entries: await getRoleplay(characterId) });

  // Upsert the answer to one of the canonical (non-custom) questions
  on('roleplay:save_answer', async ({ characterId, question, answer }) => {
    const character = await getCharacter(characterId);
    const q = String(question ?? '').trim();
    if (!character || !q) return;
    const existing = await one(
      'SELECT * FROM roleplay_entries WHERE character_id = ? AND question = ? AND is_custom = 0',
      [character.id, q]
    );
    if (existing) {
      await run('UPDATE roleplay_entries SET answer = ? WHERE id = ?', [
        String(answer ?? ''),
        existing.id,
      ]);
    } else {
      await run(
        'INSERT INTO roleplay_entries (character_id, question, answer, is_custom) VALUES (?, ?, ?, 0)',
        [character.id, q, String(answer ?? '')]
      );
    }
    await emitRoleplay(character.id);
  });

  on('roleplay:add_question', async ({ characterId, question }) => {
    const character = await getCharacter(characterId);
    const q = String(question ?? '').trim();
    if (!character || !q) return;
    const custom = await one(
      'SELECT COUNT(*) AS count FROM roleplay_entries WHERE character_id = ? AND is_custom = 1',
      [character.id]
    );
    if (Number(custom.count) >= 20) return; // up to 20 additional questions
    await run(
      'INSERT INTO roleplay_entries (character_id, question, answer, is_custom) VALUES (?, ?, ?, 1)',
      [character.id, q, '']
    );
    await emitRoleplay(character.id);
  });

  on('roleplay:update_entry', async ({ entryId, question, answer }) => {
    const entry = await one('SELECT * FROM roleplay_entries WHERE id = ?', [entryId]);
    if (!entry) return;
    const q = entry.is_custom ? String(question ?? entry.question).trim() : entry.question;
    if (!q) return;
    await run('UPDATE roleplay_entries SET question = ?, answer = ? WHERE id = ?', [
      q,
      String(answer ?? ''),
      entry.id,
    ]);
    await emitRoleplay(entry.character_id);
  });

  on('roleplay:delete_question', async ({ entryId }) => {
    const entry = await one(
      'SELECT * FROM roleplay_entries WHERE id = ? AND is_custom = 1',
      [entryId]
    );
    if (!entry) return;
    await run('DELETE FROM roleplay_entries WHERE id = ?', [entry.id]);
    await emitRoleplay(entry.character_id);
  });

  on('injury:add', async ({ characterId, name, effect, slotName, penalty }) => {
    const character = await getCharacter(characterId);
    const injuryName = String(name ?? '').trim();
    if (!character || !injuryName) return;
    const slot = VALID_INJURY_SLOTS.has(slotName) ? slotName : null;
    await run('INSERT INTO injuries (character_id, name, effect, slot_name, penalty) VALUES (?, ?, ?, ?, ?)', [
      character.id,
      injuryName,
      String(effect ?? '').trim(),
      slot,
      slot ? clampInjuryPenalty(penalty) : 0,
    ]);
    io.emit('injuries:updated', {
      characterId: character.id,
      injuries: await getInjuries(character.id),
    });
  });

  on('injury:update', async ({ injuryId, name, effect, slotName, penalty }) => {
    const injury = await one('SELECT * FROM injuries WHERE id = ?', [injuryId]);
    const injuryName = String(name ?? '').trim();
    if (!injury || !injuryName) return;
    const slot = VALID_INJURY_SLOTS.has(slotName) ? slotName : null;
    await run('UPDATE injuries SET name = ?, effect = ?, slot_name = ?, penalty = ? WHERE id = ?', [
      injuryName,
      String(effect ?? '').trim(),
      slot,
      slot ? clampInjuryPenalty(penalty) : 0,
      injury.id,
    ]);
    io.emit('injuries:updated', {
      characterId: injury.character_id,
      injuries: await getInjuries(injury.character_id),
    });
  });

  on('injury:remove', async ({ injuryId }) => {
    const injury = await one('SELECT * FROM injuries WHERE id = ?', [injuryId]);
    if (!injury) return;
    await run('DELETE FROM injuries WHERE id = ?', [injury.id]);
    io.emit('injuries:updated', {
      characterId: injury.character_id,
      injuries: await getInjuries(injury.character_id),
    });
  });

  // Character-owned counters, or standalone (characterId null) — GM-only
  // client-side, created directly in the Combat Arena.
  on('counter:create', async ({ characterId, name, targetPips, rewardType }) => {
    const counterName = String(name ?? '').trim();
    const target = Math.trunc(Number(targetPips));
    if (!counterName || !Number.isInteger(target)) return;
    if (target < 2 || target > 20) return;
    let charId = null;
    if (characterId != null) {
      const character = await getCharacter(characterId);
      if (!character) return;
      charId = character.id;
    }
    // Rewards are a purely cosmetic tracking tag for character-owned
    // counters only — a standalone Arena counter never gets one.
    const reward = charId != null && REWARD_TYPES.includes(rewardType) ? rewardType : null;
    const result = await run(
      'INSERT INTO counters (character_id, name, target_pips, reward_type) VALUES (?, ?, ?, ?)',
      [charId, counterName, target, reward]
    );
    io.emit('counter:created', await one('SELECT * FROM counters WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  // Sets or clears (rewardType omitted/unknown) a counter's reward tag at
  // any point in its lifetime — character-owned counters only, same
  // restriction as creation time.
  on('counter:set_reward', async ({ counterId, rewardType }) => {
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    if (!counter || counter.character_id == null) return;
    const reward = REWARD_TYPES.includes(rewardType) ? rewardType : null;
    await run('UPDATE counters SET reward_type = ? WHERE id = ?', [reward, counter.id]);
    io.emit('counter:updated', await one('SELECT * FROM counters WHERE id = ?', [counter.id]));
  });

  on('counter:adjust', async ({ counterId, delta }) => {
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    const change = Math.trunc(Number(delta) || 0);
    if (!counter || !change) return;
    const currentPips = clamp(counter.current_pips + change, 0, counter.target_pips);
    await run('UPDATE counters SET current_pips = ? WHERE id = ?', [currentPips, counter.id]);
    io.emit('counter:updated', await one('SELECT * FROM counters WHERE id = ?', [counter.id]));
  });

  on('counter:toggle_show_in_combat', async ({ counterId }) => {
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    if (!counter) return;
    await run('UPDATE counters SET show_in_combat = ? WHERE id = ?', [
      counter.show_in_combat ? 0 : 1,
      counter.id,
    ]);
    io.emit('counter:updated', await one('SELECT * FROM counters WHERE id = ?', [counter.id]));
  });

  on('counter:delete', async ({ counterId }) => {
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    if (!counter) return;
    await run('DELETE FROM counters WHERE id = ?', [counter.id]);
    io.emit('counter:deleted', { counterId: counter.id });
  });

  // Free-text chat message, optionally with an attached image/GIF (see Chat
  // Log above). Attributed to a character the same way a roll is — chosen
  // client-side in the compose box, not implied by the current page — or to
  // GM_CHAT_SENTINEL_ID, the GM's own generic persona (no real character
  // row; characters.id starts at 1, so 0 can never collide with a real
  // one). Never kept long-term: wiped by chat:clear and automatically on
  // every server boot (see the initDb() call at the bottom of this file).
  const MAX_CHAT_MESSAGE_LENGTH = 2000;
  on('chat:message', async ({ characterId, text, imageData, imageMimeType }) => {
    const asGm = characterId == null;
    const character = asGm ? null : await getCharacter(characterId);
    if (!asGm && !character) return;
    const message =
      typeof text === 'string' ? text.trim().slice(0, MAX_CHAT_MESSAGE_LENGTH) : '';
    const image = typeof imageData === 'string' && imageData ? imageData : null;
    if (!message && !image) return;
    const mimeType = image ? imageMimeType || 'image/png' : null;
    await run(
      `INSERT INTO chat_log (kind, character_id, dice_rolled, content, image_data, image_mime_type)
       VALUES ('message', ?, '[]', ?, ?, ?)`,
      [asGm ? GM_CHAT_SENTINEL_ID : character.id, message || null, image, mimeType]
    );
    io.emit('chat:message', {
      kind: 'message',
      characterId: asGm ? null : character.id,
      characterName: asGm ? 'GM' : character.name,
      message: message || null,
      imageData: image,
      imageMimeType: mimeType,
      timestamp: new Date().toISOString(),
    });
  });

  // GM-only client-side, same as every other admin-style control in this
  // no-auth app — the server itself has no concept of role.
  on('chat:clear', async () => {
    await run('DELETE FROM chat_log');
    io.emit('chat:cleared');
  });

  // Combat Arena (Phase 6 — structure only, no round/Tic timing yet).
  // GM-only client-side, same as every other GM-gated control in this app.
  // Seats (or re-seats) a character at side/pairIndex — the same upsert
  // covers both combat:add_participant and combat:move_participant, since
  // a character can only ever occupy one seat (combat_participants.character_id
  // is UNIQUE). More than one character can share a side/pair_index — that's
  // how an Uneven Combat 2v1 (etc.) grouping is represented.
  const seatParticipant = async (characterId, side, pairIndex) => {
    const character = await getCharacter(characterId);
    if (!character) return false;
    if (!['left', 'right'].includes(side)) return false;
    const idx = Math.trunc(Number(pairIndex));
    if (!Number.isInteger(idx) || idx < 0) return false;
    const existing = await one('SELECT id FROM combat_participants WHERE character_id = ?', [
      character.id,
    ]);
    if (existing) {
      await run('UPDATE combat_participants SET side = ?, pair_index = ? WHERE id = ?', [
        side,
        idx,
        existing.id,
      ]);
    } else {
      await run('INSERT INTO combat_participants (character_id, side, pair_index) VALUES (?, ?, ?)', [
        character.id,
        side,
        idx,
      ]);
    }
    return true;
  };

  on('combat:add_participant', async ({ characterId, side, pairIndex }) => {
    if (await seatParticipant(characterId, side, pairIndex)) await emitCombatUpdated();
  });

  on('combat:move_participant', async ({ characterId, side, pairIndex }) => {
    if (await seatParticipant(characterId, side, pairIndex)) await emitCombatUpdated();
  });

  on('combat:remove_participant', async ({ characterId }) => {
    await run('DELETE FROM combat_participants WHERE character_id = ?', [characterId]);
    await emitCombatUpdated();
  });

  // Reasons to Fight: 0-3 per-seat counter, +1 to all of this character's
  // rolls per point while combat is active (see getReasonsToFightBonus).
  on('combat:adjust_reasons_to_fight', async ({ characterId, delta }) => {
    const participant = await one('SELECT * FROM combat_participants WHERE character_id = ?', [
      characterId,
    ]);
    const change = Math.trunc(Number(delta) || 0);
    if (!participant || !change) return;
    const next = clamp(participant.reasons_to_fight + change, 0, 3);
    await run('UPDATE combat_participants SET reasons_to_fight = ? WHERE character_id = ?', [
      next,
      characterId,
    ]);
    await emitCombatUpdated();
  });

  on('combat:toggle_uneven', async () => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    await run('UPDATE combat_state SET uneven_combat_enabled = ? WHERE id = 1', [
      state.uneven_combat_enabled ? 0 : 1,
    ]);
    await emitCombatUpdated();
  });

  on('combat:clear', async () => {
    await run('DELETE FROM combat_participants');
    await run('DELETE FROM declared_moves');
    await run('DELETE FROM combat_pairs');
    await run(`
      UPDATE combat_state SET phase = NULL, round_number = 0, current_tic = 0,
      round_start_tic = 0
      WHERE id = 1
    `);
    await emitCombatUpdated();
  });

  // End Combat — the other half of the Start/End Combat toggle shown in the
  // global Tic Counter header (visible on every page while phase is
  // non-null). Unlike combat:clear ("Clear Arena"), this only turns the
  // fight itself off; everyone stays seated so the GM can start a fresh
  // fight for the same roster without re-seating.
  on('combat:end', async () => {
    await run('DELETE FROM declared_moves');
    await run('DELETE FROM combat_pairs');
    await run('UPDATE combat_participants SET declared_this_round = 0, idle_regen_progress = 0');
    await run(`
      UPDATE combat_state SET phase = NULL, round_number = 0, current_tic = 0,
      round_start_tic = 0
      WHERE id = 1
    `);
    await emitCombatUpdated();
  });

  // Phase 7 — Combat Timing. Uses server/combatTiming.js's pure functions
  // for all placement/reveal/overflow math; see that module + the plan's
  // Combat Timing mechanic section for the decided rules wired together
  // here. GM-only client-side for next_round/start_tic_countdown/
  // tic_forward/tic_backward (matching the plan's own event contract);
  // move:declare and character_done_declaring are open-access, matching how
  // declaring/rolling for a character already works everywhere else.
  //
  // Phase 9 combat redesign: initiative and declaration order are now
  // resolved independently PER PAIR, not once across the whole arena — pair
  // 1's losing side and pair 2's losing side can be declaring at the same
  // time even though they might be literal opposite "sides" (see
  // combat_pairs in db.js).
  on('combat:next_round', async () => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    if (state.phase === 'declaration') return;
    const participants = await all('SELECT * FROM combat_participants');
    if (!participants.length) return;

    const charIds = [...new Set(participants.map((p) => p.character_id))];
    const marks = charIds.map(() => '?').join(',');
    const [charRows, brainDice, staminaDice, speedAttribute] = await Promise.all([
      all(`SELECT * FROM characters WHERE id IN (${marks})`, charIds),
      all(
        `SELECT * FROM dice WHERE character_id IN (${marks}) AND slot_name = 'Brain'`,
        charIds
      ),
      all(
        `SELECT * FROM dice WHERE character_id IN (${marks}) AND slot_name = 'Stamina'`,
        charIds
      ),
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

    // Computed up front (moved ahead of the Brain-roll loop below, which
    // needs it) — see the Declaration Phase bullet in the plan for why this
    // floor exists.
    const nextRoundStartTic = computeNextRoundStartTic({
      phase: state.phase,
      currentTic: state.current_tic,
      roundStartTic: state.round_start_tic,
      roundLength: state.round_length,
    });

    // Initiative overflow penalty (decided, new rule): each character's own
    // last-queued move's full footprint end, across every round declared so
    // far this fight — same "blocked until" lookup move:declare's own
    // placement floor uses, just batched here for every seated character at
    // once. Feeds computeInitiativeOverflowPenalty below; null (no rows)
    // means that character has never declared a move, always a 0 penalty.
    const blockedUntilRows = charIds.length
      ? await all(
          // + dm.recovery_extension_tics (Combat Automation, sub-phase 3) —
          // see the column's own comment in db.js.
          `SELECT dm.character_id AS characterId,
                  MAX(dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics) AS blockedUntilTic
           FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
           WHERE dm.character_id IN (${marks})
           GROUP BY dm.character_id`,
          charIds
        )
      : [];
    const blockedUntilByChar = new Map(blockedUntilRows.map((r) => [r.characterId, r.blockedUntilTic]));

    // Start Combat (the very first round, phase was null) restores every
    // seated character to full Stamina — a fresh fight starts fresh, even
    // if someone was topped up mid-round from an earlier encounter. Only
    // this one time, not on every subsequent Next Round: ongoing Stamina
    // spend across rounds is the whole point of Stamina Cost.
    if (state.phase === null) {
      await Promise.all(
        charRows
          .filter((c) => c.current_stamina !== c.max_stamina)
          .map((c) => run('UPDATE characters SET current_stamina = ? WHERE id = ?', [c.max_stamina, c.id]))
      );
      for (const c of charRows) {
        if (c.current_stamina !== c.max_stamina) {
          io.emit('character:updated', { ...c, current_stamina: c.max_stamina });
        }
      }
    } else {
      // Stamina Regen (decided, new rule): every round from the 2nd on rolls
      // each seated character's Stamina die at its current size/bonus and
      // adds the result to current_stamina, clamped to max — same math/log
      // shape as the manual stamina:regen button, just automatic now and for
      // everyone at once. Round 1 is the Start Combat full-restore above
      // instead (already at max, nothing to regen there).
      const regenRolls = charRows
        .map((character) => {
          const die = staminaByChar.get(character.id);
          if (!die || die.status !== 'active') return null;
          const result = rollDie(die.current_size) + die.bonus;
          const currentStamina = clamp(character.current_stamina + result, 0, character.max_stamina);
          return { character, die, result, currentStamina };
        })
        .filter(Boolean);
      await Promise.all(
        regenRolls.map(({ character, currentStamina }) =>
          run('UPDATE characters SET current_stamina = ? WHERE id = ?', [currentStamina, character.id])
        )
      );
      for (const { character, currentStamina } of regenRolls) {
        io.emit('character:updated', { ...character, current_stamina: currentStamina });
      }
      await Promise.all(
        regenRolls.map(({ character, die, result }) =>
          logRoll({
            characterId: character.id,
            characterName: character.name,
            modifier: 0,
            dice: [{ slot_name: 'Stamina', size: die.current_size, bonus: die.bonus, result }],
          })
        )
      );
    }

    // Brain rolls per PAIR per side, posted to chat as normal initiative
    // rolls exactly as before — an incapacitated/missing Brain die is
    // silently dropped from its side's initiative, same as pool:roll drops
    // incapacitated dice elsewhere. Grouped by pair_index now instead of
    // pooled across the whole arena, since each pair resolves its own
    // initiative independently.
    const rollsByPair = new Map(); // pair_index -> { left: [], right: [] }
    for (const p of participants) {
      const die = brainByChar.get(p.character_id);
      const character = charById.get(p.character_id);
      if (!die || die.status !== 'active' || !character) continue;
      // Reasons to Fight applies to Initiative rolls too — "+1 to all rolls
      // during combat" — on every round including the first, same as any
      // other roll. The overflow penalty (decided, new rule) subtracts
      // however many of this new round's own Tics are still occupied by
      // this character's own carried-over move, if any (0 on round 1, since
      // there's no previous round to overflow from). Neither ever affects
      // the currentBrain/lockedBrain tie-break values below (those are raw
      // stats) — only the roll itself. Folded into `modifier`, not baked
      // silently into `result`, so the chat log's dice-breakdown display
      // (raw die face + bonus/modifier = result) actually shows it instead
      // of misattributing it to the die face.
      const modifier = (p.reasons_to_fight || 0) - computeInitiativeOverflowPenalty({
        blockedUntilTic: blockedUntilByChar.get(p.character_id) ?? null,
        nextRoundStartTic,
      });
      const result = rollDie(die.current_size) + die.bonus + modifier;
      if (!rollsByPair.has(p.pair_index)) rollsByPair.set(p.pair_index, { left: [], right: [] });
      rollsByPair.get(p.pair_index)[p.side].push({
        characterId: character.id,
        roll: result,
        currentBrain: die.current_size + die.bonus,
        lockedBrain: die.locked_size + die.locked_bonus,
        hasSpeedStance: hasSpeedStance(character),
      });
      await logRoll({
        characterId: character.id,
        characterName: character.name,
        modifier,
        dice: [{ slot_name: 'Brain', size: die.current_size, bonus: die.bonus, result }],
      });
    }

    const pairIndices = [...new Set(participants.map((p) => p.pair_index))];
    const pairDeclaringSide = new Map();
    for (const pairIndex of pairIndices) {
      const pairParticipants = participants.filter((p) => p.pair_index === pairIndex);
      const hasLeft = pairParticipants.some((p) => p.side === 'left');
      const hasRight = pairParticipants.some((p) => p.side === 'right');
      if (hasLeft && hasRight) {
        const { firstToDeclare } = resolveSideInitiative(
          rollsByPair.get(pairIndex) ?? { left: [], right: [] }
        );
        pairDeclaringSide.set(pairIndex, firstToDeclare);
      } else {
        pairDeclaringSide.set(pairIndex, hasLeft ? 'left' : 'right');
      }
    }

    await run('DELETE FROM combat_pairs');
    await Promise.all(
      pairIndices.map((pairIndex) =>
        run('INSERT INTO combat_pairs (pair_index, declaring_side) VALUES (?, ?)', [
          pairIndex,
          pairDeclaringSide.get(pairIndex),
        ])
      )
    );
    await run('UPDATE combat_participants SET declared_this_round = 0');

    // nextRoundStartTic was already computed above (needed earlier, by the
    // Brain-roll loop's overflow penalty) — floored a full round_length past
    // the previous round's own start, not just set to wherever current_tic
    // happens to sit, so a round that never actually had its Tic Countdown
    // run (or only partially did) can't leave its declared moves' Tics
    // "occupied" again in the new round. current_tic is advanced to match,
    // keeping it in sync with the new round_start_tic.
    await run(
      `UPDATE combat_state SET phase = 'declaration', round_number = round_number + 1,
       current_tic = ?, round_start_tic = ?
       WHERE id = 1`,
      [nextRoundStartTic, nextRoundStartTic]
    );
    await emitCombatUpdated();
  });

  on('move:declare', async ({ characterId, moveId, placementTic: requestedPlacementTic, appendageChoice }) => {
    // The four lookups below are all independent of each other (none reads
    // a value the others produce), so they run as one round trip instead
    // of four sequential ones.
    const [state, participant, character, move] = await Promise.all([
      one('SELECT * FROM combat_state WHERE id = 1'),
      one('SELECT * FROM combat_participants WHERE character_id = ?', [characterId]),
      getCharacter(characterId),
      one('SELECT * FROM moves WHERE id = ?', [moveId]),
    ]);
    if (state.phase !== 'declaration') return;
    // Declaration runs independently per pair now (Phase 9 combat redesign)
    // — a character may only declare while their OWN pair's declaring_side
    // matches their own side, and only until they themselves have pressed
    // "done declaring" for the round (declared_this_round).
    if (!participant || participant.declared_this_round) return;
    const pair = await one('SELECT * FROM combat_pairs WHERE pair_index = ?', [participant.pair_index]);
    if (!pair || pair.declaring_side !== participant.side) return;
    if (!character || !move) return;

    // right_tell_id/left_tell_id are only ever set together, exactly when
    // this move's Roll has an ambiguous Hand/Leg slot (see db.js) — the
    // client is expected to have already asked Left/Right via a popup
    // before ever emitting this event for such a move, so a missing/invalid
    // choice here is rejected rather than silently guessed.
    const isAmbiguous = move.right_tell_id != null;
    if (isAmbiguous && !['left', 'right'].includes(appendageChoice)) return;
    const storedAppendageChoice = isAmbiguous ? appendageChoice : null;

    // Move must actually be available to this character (Default, or
    // granted) — same rule getMovesFor uses to build a character's list.
    if (!move.is_default) {
      const granted = await one(
        'SELECT id FROM character_moves WHERE character_id = ? AND move_id = ?',
        [character.id, move.id]
      );
      if (!granted) return;
    }
    // Learnability: a styled move is only usable while the character's
    // ACTIVE stance carries that style (Tab 3 dims it otherwise).
    if (move.style_attribute_id != null) {
      const stance = character.active_stance_id
        ? await one('SELECT * FROM stances WHERE id = ?', [character.active_stance_id])
        : null;
      if (
        !stance ||
        (stance.attribute_a_id !== move.style_attribute_id &&
          stance.attribute_b_id !== move.style_attribute_id)
      ) {
        return;
      }
    }

    // Affordability is checked up front, against current_stamina minus
    // every other move this character already has pending (not yet
    // committed) this Declaration Phase — the actual spend only happens when
    // this character themselves finishes declaring (see
    // combat:character_done_declaring), but they can never queue more than
    // they can actually pay for once that happens.
    // The character's own last-queued move's full footprint end (reveal +
    // Active + Recovery) — ORDER BY the computed end, not just reveal_tic,
    // since a shorter-Active/Recovery move declared later could still end
    // earlier than a longer one declared before it.
    const [pending, last] = await Promise.all([
      getPendingStaminaCost(character.id),
      one(
        // + dm.recovery_extension_tics (Combat Automation, sub-phase 3) —
        // see the column's own comment in db.js.
        `SELECT (dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics) AS blocked_until_tic
         FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
         WHERE dm.character_id = ?
         ORDER BY blocked_until_tic DESC LIMIT 1`,
        [character.id]
      ),
    ]);
    if (character.current_stamina - pending - move.stamina_cost < 0) return;

    // A player can drag a move onto any Tic they like on the Tic Counter —
    // never earlier than the character's own next-eligible Tic, which is
    // why this is a floor, not an exact placement: dropping too early just
    // snaps forward to the earliest legal Tic instead of failing. That
    // floor is the previous move's full footprint end (Startup+Active+
    // Recovery, not just Startup) — a new move can't be placed while an
    // earlier one is still active or recovering (revised: an earlier
    // version of this rule blocked only through Startup, letting a
    // still-Active/Recovering move get silently overlapped by a new one).
    const minPlacementTic = computePlacementTic({
      roundStartTic: state.round_start_tic,
      previousBlockedUntilTic: last ? last.blocked_until_tic : null,
    });
    const placementTic = Number.isInteger(requestedPlacementTic)
      ? Math.max(requestedPlacementTic, minPlacementTic)
      : minPlacementTic;
    const { revealTic } = computeMoveFootprint({
      placementTic,
      startupTics: move.startup_tics,
      activeTics: move.active_tics,
      recoveryTics: move.recovery_tics,
    });
    const countRow = await one(
      'SELECT COUNT(*) AS count FROM declared_moves WHERE character_id = ? AND round_number = ?',
      [character.id, state.round_number]
    );
    const queueOrder = countRow.count + 1;

    // Attack Target (Change 001): snapshot the move template's attack_targets
    // (Hand/Leg expanded to this declaration's own appendage_choice) into
    // declared_moves at declare time — a later edit to the Move template
    // must not retroactively change an already-declared attack. Stored
    // regardless of whether this move even has a Roll; an attack with no
    // Roll simply has no meaningful damage/target flow downstream.
    const effectiveAttackTargets = expandAttackTargets(
      JSON.parse(move.attack_targets ?? '[]'),
      storedAppendageChoice
    );

    await run(
      `INSERT INTO declared_moves (character_id, move_id, round_number, queue_order, placement_tic, reveal_tic, appendage_choice, effective_attack_targets, attack_target_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'move')`,
      [character.id, move.id, state.round_number, queueOrder, placementTic, revealTic, storedAppendageChoice, JSON.stringify(effectiveAttackTargets)]
    );
    // Every connected socket gets its own tailored view via emitCombatUpdated
    // (see isRevealedToViewer/mapDeclaredMovesForViewer) — whoever's logged
    // in as this character sees the real move and its Stamina Cost
    // immediately, everyone else sees Tell-only, regardless of who actually
    // triggered this declare.
    await emitCombatUpdated();
  });

  // Lets a still-pending declared move be taken back and something else
  // declared instead — open access, same trust model as move:declare
  // itself. Only while it's genuinely still pending: stamina_committed = 1
  // means this character already pressed Done Declaring, at which point its
  // Stamina Cost has actually left current_stamina (see
  // combat:character_done_declaring) — undoing that would need a refund
  // this event deliberately doesn't attempt, so it's simply rejected past
  // that point (a no-op, matching move:declare's own rejection pattern).
  on('move:undeclare', async ({ declaredMoveId }) => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    if (state.phase !== 'declaration') return;
    const row = await one('SELECT * FROM declared_moves WHERE id = ?', [declaredMoveId]);
    if (!row || row.stamina_committed) return;
    await run('DELETE FROM declared_moves WHERE id = ?', [row.id]);
    await emitCombatUpdated();
  });

  // Phase 9 combat redesign: declaring is now asynchronous per character,
  // not one shared button per side — every seated character presses their
  // own "done declaring" individually (open access, same trust model as
  // move:declare — declaring/finishing for a character isn't restricted to
  // whoever's logged in as them). A no-op unless it's genuinely this
  // character's turn (their pair's declaring_side matches their own side)
  // and they haven't already finished this round.
  on('combat:character_done_declaring', async ({ characterId }) => {
    const [state, participant] = await Promise.all([
      one('SELECT * FROM combat_state WHERE id = 1'),
      one('SELECT * FROM combat_participants WHERE character_id = ?', [characterId]),
    ]);
    if (state.phase !== 'declaration' || !participant || participant.declared_this_round) return;
    const pair = await one('SELECT * FROM combat_pairs WHERE pair_index = ?', [participant.pair_index]);
    if (!pair || pair.declaring_side !== participant.side) return;

    // Commit this character's own pending moves' Stamina Cost now — this is
    // the one and only place cost actually leaves/returns to
    // current_stamina (move:declare only ever checked affordability).
    // Clamped defensively to [0, max]; the up-front affordability check
    // already keeps this from going negative in the normal flow. Per
    // character now rather than batched per side, since declaring itself is.
    const [pendingRow, character] = await Promise.all([
      one(
        `SELECT COALESCE(SUM(m.stamina_cost), 0) AS pending
         FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
         WHERE dm.character_id = ? AND dm.stamina_committed = 0`,
        [characterId]
      ),
      getCharacter(characterId),
    ]);
    if (character && pendingRow.pending !== 0) {
      const newStamina = clamp(character.current_stamina - pendingRow.pending, 0, character.max_stamina);
      await run('UPDATE characters SET current_stamina = ? WHERE id = ?', [newStamina, characterId]);
      io.emit('character:updated', { ...character, current_stamina: newStamina });
    }
    await Promise.all([
      run('UPDATE declared_moves SET stamina_committed = 1 WHERE character_id = ? AND stamina_committed = 0', [
        characterId,
      ]),
      run('UPDATE combat_participants SET declared_this_round = 1 WHERE character_id = ?', [characterId]),
    ]);

    // Has every character on THIS side of THIS pair now finished? If so,
    // this pair's declaring_side flips to the other side (if it exists and
    // hasn't already gone) or clears to NULL (this pair is fully done) — see
    // combat_pairs' schema comment in db.js for the full reasoning behind
    // not needing a separate "pending side" field to figure this out.
    const pairmates = await all(
      'SELECT declared_this_round FROM combat_participants WHERE pair_index = ? AND side = ?',
      [participant.pair_index, participant.side]
    );
    if (pairmates.every((p) => p.declared_this_round)) {
      const otherSide = participant.side === 'left' ? 'right' : 'left';
      const otherSideParticipants = await all(
        'SELECT declared_this_round FROM combat_participants WHERE pair_index = ? AND side = ?',
        [participant.pair_index, otherSide]
      );
      const nextDeclaringSide =
        otherSideParticipants.length && otherSideParticipants.some((p) => !p.declared_this_round)
          ? otherSide
          : null;
      await run('UPDATE combat_pairs SET declaring_side = ? WHERE pair_index = ?', [
        nextDeclaringSide,
        participant.pair_index,
      ]);
    }

    await emitCombatUpdated();
  });

  on('combat:start_tic_countdown', async () => {
    const [state, pairs] = await Promise.all([
      one('SELECT * FROM combat_state WHERE id = 1'),
      all('SELECT * FROM combat_pairs'),
    ]);
    // Every pair must have finished declaring (both sides done, or trivially
    // done for a single-sided pair) — the Tic Counter is one shared timeline
    // for the whole arena, so it can't start counting down while any pair is
    // still mid-Declaration (Phase 9 combat redesign: declaration itself now
    // runs independently per pair, but the countdown that follows it is
    // still global).
    if (state.phase !== 'declaration' || pairs.some((p) => p.declaring_side != null)) return;
    await run("UPDATE combat_state SET phase = 'tic_countdown' WHERE id = 1");
    // A move with 0 Startup Tics placed at the round's very first Tic
    // reveals immediately — its reveal_tic already equals current_tic
    // before a single Tic forward happens. postMoveReveals only otherwise
    // runs from inside tic_forward, so without this it would sit fully
    // revealed (isMoveRevealedTo is computed live) with no lane_snapshot
    // chat card ever posted for it. Catches any other already-due reveal
    // the same way, for the same reason.
    await postMoveReveals(state.current_tic, {
      roundNumber: state.round_number,
      roundStartTic: state.round_start_tic,
      roundLength: state.round_length,
    });
    await applyIdleTicStaminaRegen(state.current_tic);
    await emitCombatUpdated();
  });

  on('combat:tic_forward', async () => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    if (state.phase !== 'tic_countdown') return;
    const maxTic = state.round_start_tic + state.round_length - 1;
    if (state.current_tic >= maxTic) return;
    const newTic = state.current_tic + 1;
    await run('UPDATE combat_state SET current_tic = ? WHERE id = 1', [newTic]);
    await postMoveReveals(newTic, {
      roundNumber: state.round_number,
      roundStartTic: state.round_start_tic,
      roundLength: state.round_length,
    });
    await applyIdleTicStaminaRegen(newTic);
    await emitCombatUpdated();
  });

  on('combat:tic_backward', async () => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    if (state.phase !== 'tic_countdown') return;
    const newTic = Math.max(state.round_start_tic, state.current_tic - 1);
    await run('UPDATE combat_state SET current_tic = ? WHERE id = 1', [newTic]);
    await emitCombatUpdated();
  });

  // Combat Automation (Phase 9): the GM's 2×2 Block/Dodge × Successful/
  // Failed prompt (4.2), plus the frame-overlap classification that decides
  // whether that prompt should even be trusted (4.3). `attackerResult` is
  // the attacker's already-rolled total (from the roll card the reveal-time
  // auto-Roll already posted, see buildRollContext above) — this event
  // doesn't roll for the attacker, only (when Successful) for the defender.
  // Sub-phase 5: also fires move_interactions automations — the attacker's
  // own move's 'block' trigger on a Successful resolution (guarded by
  // interactions_resolved, same reasoning as combat:apply_damage's 'hit'
  // firing — see its own comment), and the defender's move's
  // defense_success/defense_failure every time this resolves, unconditional
  // (a defensive move can legitimately defend more than once).
  on('combat:resolve_defense', async ({
    attackerDeclaredMoveId,
    attackerResult,
    defenderDeclaredMoveId,
    defenseType,
    outcome,
  }) => {
    if (!['block', 'dodge'].includes(defenseType)) return;
    if (!['successful', 'failed'].includes(outcome)) return;
    const result = Math.trunc(Number(attackerResult));
    if (!Number.isFinite(result)) return;

    const [attackerDM, defenderDM] = await Promise.all([
      one(
        `SELECT dm.id, dm.character_id, dm.reveal_tic, dm.move_id, dm.interactions_resolved, m.active_tics
         FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
         WHERE dm.id = ?`,
        [attackerDeclaredMoveId]
      ),
      one(
        `SELECT dm.id, dm.character_id, dm.placement_tic, dm.reveal_tic, dm.appendage_choice,
                dm.recovery_extension_tics AS current_extension_tics,
                m.id AS move_id, m.active_tics, m.recovery_tics, m.defense_frame_positions,
                m.is_defensive, m.roll_type, m.custom_roll_size, m.roll_modifier,
                ch.name AS character_name
         FROM declared_moves dm JOIN moves m ON m.id = dm.move_id JOIN characters ch ON ch.id = dm.character_id
         WHERE dm.id = ?`,
        [defenderDeclaredMoveId]
      ),
    ]);
    if (!attackerDM || !defenderDM) return;

    // Attack Target (Change 001), rule 12: Block MUST have a base Stat
    // Roll — a Custom Roll move has no named stat to turn into a
    // replacement Attack Target, so it can never serve as a Block. This is
    // the server-authoritative version of the same restriction
    // ResolveDefenseDialog.jsx already enforces client-side; checked here
    // regardless of outcome, before any defensive Roll happens.
    if (defenseType === 'block') {
      if (defenderDM.roll_type !== 'stat') return;
      const baseSlotCount = await one(
        'SELECT COUNT(*) AS count FROM move_roll_slots WHERE move_id = ?',
        [defenderDM.move_id]
      );
      if (Number(baseSlotCount.count) === 0) return;
    }

    // 4.3: whether the attacker's Active window is actually covered by the
    // defender's Defense-tagged Tic(s) at all, and if not, exactly how.
    const defenseFramePositions = JSON.parse(defenderDM.defense_frame_positions ?? '[]');
    const coverage = classifyDefenseCoverage({
      attackActiveStart: attackerDM.reveal_tic,
      attackActiveEnd: attackerDM.reveal_tic + attackerDM.active_tics,
      defenseTics: defenseFramePositions.map((pos) => defenderDM.placement_tic + pos),
    });
    // The attack's very first Active Tic uncovered is automatically
    // non-effective — treated as GM-picked Failed regardless of what was
    // actually picked, so a stale/incorrect client can't bypass this.
    const effectiveOutcome = coverage.coverage === 'too-early' ? 'failed' : outcome;
    const defenseLabel = defenseType === 'block' ? 'Block' : 'Dodge';

    if (effectiveOutcome === 'failed') {
      // "the defense does nothing... resolution falls through to the plain
      // 4.1 Hit flow exactly as if there'd been no Defense Frame at all" —
      // the attacker's roll card (already posted) is still the Apply-button
      // vehicle for that (which is what fires the attacker's own 'hit'
      // trigger, once damage is actually applied — not here). Only the
      // defender's own move's 'defense_failure' trigger fires from this
      // branch.
      await postSystemMessage(`${defenderDM.character_name}'s ${defenseLabel} has failed.`);
      await applyMoveInteractions({
        moveId: defenderDM.move_id,
        trigger: 'defense_failure',
        selfCharacterId: defenderDM.character_id,
        selfDeclaredMoveId: defenderDeclaredMoveId,
        opponentCharacterId: attackerDM.character_id,
        opponentDeclaredMoveId: attackerDeclaredMoveId,
      });
      io.emit('combat:defense_resolved', {
        attackerDeclaredMoveId,
        defenderDeclaredMoveId,
        defenseType,
        outcome: 'failed',
        coverage: coverage.coverage,
      });
      return;
    }

    // Successful Block/Dodge (4.2): roll the defending move's own Roll —
    // base move_roll_slots plus, if it's is_defensive, the extra
    // move_defensive_roll_slots pool on top — via this declared move's own
    // stored appendage_choice (see resolveDefensiveRollDice above).
    const [baseSlotRows, defensiveSlotRows, rollBonusRow] = await Promise.all([
      all('SELECT slot_name FROM move_roll_slots WHERE move_id = ?', [defenderDM.move_id]),
      defenderDM.is_defensive
        ? all('SELECT slot_name FROM move_defensive_roll_slots WHERE move_id = ?', [defenderDM.move_id])
        : [],
      one(
        'SELECT COALESCE(SUM(amount), 0) AS bonus FROM character_move_roll_bonuses WHERE character_id = ? AND move_id = ?',
        [defenderDM.character_id, defenderDM.move_id]
      ),
    ]);
    const mod =
      defenderDM.roll_modifier + rollBonusRow.bonus + (await getReasonsToFightBonus(defenderDM.character_id));

    // Attack Target (Change 001), 6.4: a Successful Block (Partial or Full
    // alike) replaces the attacker's effective target with the blocking
    // move's own base Stat Roll — baseSlotRows only, never the extra
    // move_defensive_roll_slots pool (that pool contributes to the Block's
    // result total, never to what it can turn into a target). Hand/Leg
    // narrow to whichever side this Block itself was declared with. Written
    // before the outcome/damage chat line below and before combat:
    // defense_resolved is emitted, per the spec's "resolved emits only
    // after a successful target write" ordering; Dodge and Failed Block
    // never reach this branch, so the snapshot is untouched for both.
    let attackTargetUpdate = null;
    if (defenseType === 'block') {
      const effectiveAttackTargets = expandAttackTargets(
        baseSlotRows.map((row) => row.slot_name),
        defenderDM.appendage_choice
      );
      await run(
        `UPDATE declared_moves
         SET effective_attack_targets = ?, attack_target_source = 'block'
         WHERE id = ?`,
        [JSON.stringify(effectiveAttackTargets), attackerDeclaredMoveId]
      );
      attackTargetUpdate = { effectiveAttackTargets, attackTargetSource: 'block' };
    }

    let blockDice;
    if (defenderDM.roll_type === 'custom' && defenderDM.custom_roll_size != null) {
      blockDice = [
        {
          slot_name: 'Custom',
          size: defenderDM.custom_roll_size,
          bonus: 0,
          result: rollDie(defenderDM.custom_roll_size) + mod,
        },
      ];
    } else {
      const slotNames = [...baseSlotRows, ...defensiveSlotRows].map((r) => r.slot_name);
      const dice = await resolveDefensiveRollDice(defenderDM.character_id, slotNames, defenderDM.appendage_choice);
      blockDice = dice.map((d) => ({
        slot_name: d.slot_name,
        size: d.current_size,
        bonus: d.bonus,
        result: rollDie(d.current_size) + d.bonus + mod,
      }));
    }
    const blockResult = blockDice.reduce((sum, d) => sum + d.result, 0);
    await logRoll({
      characterId: defenderDM.character_id,
      characterName: defenderDM.character_name,
      modifier: mod,
      dice: blockDice,
    });

    const resolution = resolveDefenseRoll({ attackerResult: result, defenderResult: blockResult });
    await postSystemMessage(
      resolution.outcome === 'full'
        ? `${defenderDM.character_name} scored a Full ${defenseLabel} — no damage.`
        : `${defenderDM.character_name} scored a Partial ${defenseLabel} — ${resolution.damage} damage.`
    );

    // Sub-phase 5: the defender's own move reacts to defending successfully
    // every time (a defensive move can defend more than once), the
    // attacker's own move reacts to being blocked/dodged exactly once per
    // declared move — guarded the same way combat:apply_damage's 'hit'
    // firing is, so a later Apply of this Partial Block's own reduced
    // damage (still routed through that same event) doesn't also fire 'hit'
    // on top of 'block'.
    await applyMoveInteractions({
      moveId: defenderDM.move_id,
      trigger: 'defense_success',
      selfCharacterId: defenderDM.character_id,
      selfDeclaredMoveId: defenderDeclaredMoveId,
      opponentCharacterId: attackerDM.character_id,
      opponentDeclaredMoveId: attackerDeclaredMoveId,
    });
    if (!attackerDM.interactions_resolved) {
      await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [attackerDeclaredMoveId]);
      await applyMoveInteractions({
        moveId: attackerDM.move_id,
        trigger: 'block',
        selfCharacterId: attackerDM.character_id,
        selfDeclaredMoveId: attackerDeclaredMoveId,
        opponentCharacterId: defenderDM.character_id,
        opponentDeclaredMoveId: defenderDeclaredMoveId,
      });
    }

    // 4.3: Block only — coverage running out before the attacker's Active
    // window ends extends the blocker's own Recovery to cover the gap.
    // Anything else this character already had declared into the newly-
    // consumed Tics needs a Forfeit/Postpone choice (combat:move_conflict
    // below, resolved via combat:resolve_move_conflict); a previously-free
    // Tic is simply consumed, no event needed for that case.
    let conflictDeclaredMoveIds = [];
    if (defenseType === 'block' && coverage.coverage === 'too-late') {
      const oldRecoveryEndTic =
        defenderDM.reveal_tic + defenderDM.active_tics + defenderDM.recovery_tics + defenderDM.current_extension_tics;
      const newRecoveryEndTic = oldRecoveryEndTic + coverage.extensionTicsNeeded;
      await run('UPDATE declared_moves SET recovery_extension_tics = ? WHERE id = ?', [
        defenderDM.current_extension_tics + coverage.extensionTicsNeeded,
        defenderDM.id,
      ]);
      const colliding = await all(
        'SELECT id FROM declared_moves WHERE character_id = ? AND id != ? AND placement_tic >= ? AND placement_tic < ?',
        [defenderDM.character_id, defenderDM.id, oldRecoveryEndTic, newRecoveryEndTic]
      );
      conflictDeclaredMoveIds = colliding.map((r) => r.id);
      for (const conflictId of conflictDeclaredMoveIds) {
        io.emit('combat:move_conflict', {
          declaredMoveId: conflictId,
          characterId: defenderDM.character_id,
          blockerDeclaredMoveId: defenderDM.id,
        });
      }
      // The extended Recovery window is real combat state (declared_moves
      // itself, not something new) — the existing Tic Counter/footprint
      // rendering already reads recoveryEndTic straight off it, so this
      // alone is enough for the extension to show up live, no new UI needed.
      await emitCombatUpdated();
    }

    io.emit('combat:defense_resolved', {
      attackerDeclaredMoveId,
      defenderDeclaredMoveId,
      defenseType,
      outcome: resolution.outcome,
      netResult: resolution.netResult,
      halfDamageSteps: resolution.halfDamageSteps,
      damage: resolution.damage,
      coverage: coverage.coverage,
      conflictDeclaredMoveIds,
      ...(attackTargetUpdate ?? {}),
    });
  });

  // Combat Automation (Phase 9, sub-phase 3): Forfeit or Postpone (4.3) for
  // a declared move that a Block's Recovery extension just ran into —
  // `blockerDeclaredMoveId` is whichever move's (possibly itself-extended)
  // Recovery window this one is colliding with, from the combat:move_conflict
  // event this responds to (see combat:resolve_defense above, or the
  // recursive re-emit below).
  on('combat:resolve_move_conflict', async ({ declaredMoveId, blockerDeclaredMoveId, choice }) => {
    if (!['forfeit', 'postpone'].includes(choice)) return;
    const row = await one(
      `SELECT dm.*, m.startup_tics, m.active_tics, m.recovery_tics, m.stamina_cost
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
       WHERE dm.id = ?`,
      [declaredMoveId]
    );
    if (!row) return;

    if (choice === 'forfeit') {
      // Cancel outright, full Stamina refund — mirrors move:undeclare's
      // existing cancel-before-commit behavior, but this can fire well past
      // that point (mid Tic Countdown, after stamina_committed already left
      // current_stamina), so unlike move:undeclare a refund is issued here
      // explicitly rather than relying on the spend never having happened.
      await run('DELETE FROM declared_moves WHERE id = ?', [row.id]);
      if (row.stamina_committed && row.stamina_cost) {
        await adjustStamina(row.character_id, row.stamina_cost);
        await postSystemMessage(`A declared move was Forfeited — ${row.stamina_cost} Stamina refunded.`);
      }
      await emitCombatUpdated();
      return;
    }

    // Postpone: shift later along the Tic Counter by just enough Tics that
    // the new footprint starts after the specific colliding move's own
    // Recovery ends — recomputed fresh from the DB (not trusted from
    // whenever this prompt first fired), in case anything shifted again in
    // the meantime.
    const blocker = await one(
      `SELECT dm.reveal_tic, dm.recovery_extension_tics, m.active_tics, m.recovery_tics
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
       WHERE dm.id = ?`,
      [blockerDeclaredMoveId]
    );
    if (!blocker) return;
    const blockerRecoveryEndTic =
      blocker.reveal_tic + blocker.active_tics + blocker.recovery_tics + blocker.recovery_extension_tics;
    const newPlacementTic = Math.max(row.placement_tic, blockerRecoveryEndTic);
    const { revealTic } = computeMoveFootprint({
      placementTic: newPlacementTic,
      startupTics: row.startup_tics,
      activeTics: row.active_tics,
      recoveryTics: row.recovery_tics,
    });
    await run('UPDATE declared_moves SET placement_tic = ?, reveal_tic = ? WHERE id = ?', [
      newPlacementTic,
      revealTic,
      row.id,
    ]);
    await emitCombatUpdated();

    // Recursive cascade (4.3): the postponed footprint might now collide
    // with yet another already-declared move of this SAME character further
    // down the timeline — re-raise the same conflict prompt for each one
    // found, with this move now standing in as the new blocker.
    const recoveryEndTic = revealTic + row.active_tics + row.recovery_tics + row.recovery_extension_tics;
    const stillColliding = await all(
      'SELECT id FROM declared_moves WHERE character_id = ? AND id != ? AND placement_tic >= ? AND placement_tic < ?',
      [row.character_id, row.id, newPlacementTic, recoveryEndTic]
    );
    for (const collision of stillColliding) {
      io.emit('combat:move_conflict', {
        declaredMoveId: collision.id,
        characterId: row.character_id,
        blockerDeclaredMoveId: row.id,
      });
    }
  });

  // Combat Automation (Phase 9, sub-phase 3): Interruption (4.4) — taking a
  // Hit while still in your own move's Startup can Disrupt it.
  // `dieId` is the attacker's own Stat chosen for the interrupt roll
  // (see the plan's 4.4 "needs confirmation" note on whose Stat this is);
  // `attackerDeclaredMoveId` is the attacker's own move (for
  // computeInterruptBonus's Active-frame-elapsed count); `halfDamageSteps`
  // is however many steps the hit that triggered this already dealt (4.1's
  // Apply flow is unaffected/still runs independently of this event —
  // "the hit's damage applies exactly as it would anyway"); `startupDeclaredMoveId`
  // is the move being potentially Interrupted.
  on('combat:check_interrupt', async ({ dieId, attackerDeclaredMoveId, halfDamageSteps, startupDeclaredMoveId }) => {
    const [die, attackerDM, startupDM, state] = await Promise.all([
      one('SELECT * FROM dice WHERE id = ?', [dieId]),
      one('SELECT id, reveal_tic FROM declared_moves WHERE id = ?', [attackerDeclaredMoveId]),
      one(
        `SELECT dm.*, m.stamina_cost, ch.name AS character_name
         FROM declared_moves dm JOIN moves m ON m.id = dm.move_id JOIN characters ch ON ch.id = dm.character_id
         WHERE dm.id = ?`,
        [startupDeclaredMoveId]
      ),
      one('SELECT current_tic FROM combat_state WHERE id = 1'),
    ]);
    if (!die || die.status !== 'active' || !attackerDM || !startupDM) return;
    const steps = Math.max(0, Math.trunc(Number(halfDamageSteps) || 0));

    const bonus = computeInterruptBonus({ revealTic: attackerDM.reveal_tic, currentTic: state.current_tic });
    const character = await getCharacter(die.character_id);
    if (!character) return;
    const mod = bonus + (await getReasonsToFightBonus(die.character_id));
    const result = rollDie(die.current_size) + die.bonus + mod;
    await logRoll({
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      dice: [{ slot_name: die.slot_name, size: die.current_size, bonus: die.bonus, result }],
    });

    // (Needs confirmation, per the plan's own 4.4 note): threshold assumed
    // to be `roll >= damage taken` (here, half-damage steps — the same unit
    // the flat roll is naturally compared against).
    const succeeded = result >= steps;
    io.emit('combat:interrupt_resolved', {
      startupDeclaredMoveId,
      succeeded,
      result,
      threshold: steps,
    });
    if (!succeeded) return;

    // Interrupted (decided): every remaining frame reverts to Undeclared —
    // simply deleting the row is the same end state as never having
    // declared it, "an implementation choice, not a design one" per the
    // plan. Half the Stamina Cost is refunded (contrast with 4.3's Forfeit,
    // a FULL refund — Interruption is involuntary/mid-commitment, Forfeit a
    // voluntary trade-off, hence the different fraction).
    await run('DELETE FROM declared_moves WHERE id = ?', [startupDM.id]);
    const refund = startupDM.stamina_committed ? Math.trunc(startupDM.stamina_cost / 2) : 0;
    if (refund) await adjustStamina(startupDM.character_id, refund);
    await postSystemMessage(
      refund
        ? `${startupDM.character_name}'s move was Interrupted — ${refund} Stamina refunded.`
        : `${startupDM.character_name}'s move was Interrupted.`
    );
    await emitCombatUpdated();
  });
});

// ---------- static frontend ----------

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

await initDb();
// Chat is intentionally ephemeral — see chat:clear below — and clearing it
// on every boot doubles as clearing it between sessions on Render's free
// tier, which spins the server down after inactivity.
await run('DELETE FROM chat_log');
httpServer.listen(PORT, () => {
  console.log(`Custom VTT server listening on port ${PORT}`);
});
