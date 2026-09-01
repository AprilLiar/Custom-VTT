import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  db, all, one, run, readMany, writeMany, initDb,
  syncReplica, syncOnce, syncHealth, startSyncLoop, replicaMode, SYNC_SECONDS,
} from './db.js';
import { gateChatLine, gatesCrossed, isValidPip, visibleGates } from './counterGates.js';
import {
  advancePairResolution,
  resolveDodge,
  resolveBlock,
  resolveMoveConflict,
  resolveNonCommit,
  answerGrapple,
  resumeGrapple,
  resumeAllPairsOnBoot,
  postSystemMessage,
  adjustStamina,
  logRoll,
  applyMoveInteractions,
  moveTagNamesFor,
  openRoundForCharacters,
  defensePromptPayload,
} from './roundResolution.js';
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
  dieAtRank,
  rollTotal,
} from './gameLogic.js';
import { getCombatRollBonus, getPairStanceMatchup, getStanceMatchupBonus } from './combatBonuses.js';
import {
  clampFrame,
  validFrames,
  normalizeInteractions,
  clampRollBonus,
  clampStaminaCost,
  sanitizeRollSlots,
  hasAmbiguousRollSlot,
  countRollSlot,
  resolveRollSlotNames,
  expandRollSlotRows,
  collapseRollSlots,
  sanitizeDefensePositions,
  sanitizeDefenseKind,
  AMBIGUOUS_ROLL_SLOTS,
  sanitizeRollType,
  sanitizeCustomRollSize,
  sanitizeAttackTargets,
  expandAttackTargets,
  parseConcreteAttackTargets,
  attackHeights,
  clampStaminaModifier,
  clampSuccessThreshold,
  normalizeGrappleDirections,
  normalizeRequirement,
  declarableByHand,
  effectiveStaminaCost,
} from './moveLogic.js';
import {
  carriesBlockTag,
  carriesFeintTag,
  carriesOffTheGroundTag,
  groundingTripRecoveryTics,
  effectiveTagNames,
  feintMasksDeclaration,
  movementBlockedByLegs,
  BLOCK_TAG,
  FEINT_TAG,
} from './tagAutomations.js';
import {
  getWeapon,
  grantWeapon,
  removeWeapon,
  weaponDie,
  WEAPON_SLOT,
} from './weapons.js';
import { effectiveFrames, idleStaminaRegenRate } from './perkAutomations.js';
import {
  clearAllPerkState, perkAllowsRevealedDetail, perkStaminaCostDeltas, perkMoveFrameDeltas,
  perkWeaponOffers, takeWeaponOffer, perkSeesAttackHeight, perkSeesFeints,
} from './perkEngine.js';
import { isAutomatedPerk, isManualPerk, perkDefinition } from './perks/index.js';
import { validateCreation } from './characterCreation.js';
import {
  resolveSideInitiative,
  computePlacementTic,
  computeMoveFootprint,
  placementFloorAfterTrip,
  isMoveRevealedTo,
  relativeTic,
  computeNextRoundStartTic,
  isTicIdle,
  overlapsRoundWindow,
  computeInitiativeOverflowPenalty,
} from './combatTiming.js';
import { clampRecoveryExtension } from './combatDamage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// Roll Requests that carry a target number, keyed by request id. Held here
// rather than in the DB on purpose: nothing waits on one (unlike a Dodge
// pause, which is why THAT is durable), so losing them to a restart costs
// only the verdict line, and the roll itself is unaffected.
const pendingRollChecks = new Map();

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

// **Gates ride their own channel, not the Counter payload.** A Counter goes out
// with `io.emit` — everybody's Arena shows everybody's clocks — and a Gate can
// carry something only the GM may read. Rather than make five Counter
// broadcasts viewer-aware, Gates are pushed per socket on their own event and
// held separately by the client, the same shape the Relationships board uses.
//
// The whole list every time: there are a handful of Counters in a world and a
// few Gates on each, and a whole-list push cannot leave a client holding a Gate
// that has since moved.
const getAllGates = () => all('SELECT * FROM counter_gates ORDER BY counter_id, pip_index');

async function emitGates() {
  const gates = await getAllGates();
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data?.identity;
    if (!identity) continue;
    socket.emit('counter_gates:updated', { gates: visibleGates(gates, identity) });
  }
}

// Attach parsed interaction rows + tag ids to each move in the list. The
// three lookups are independent of each other — fired concurrently so this
// costs one network round-trip (to Turso in production), not three.
async function attachInteractions(moves) {
  if (!moves.length) return moves;
  const ids = moves.map((m) => m.id);
  const marks = ids.map(() => '?').join(',');
  // Every extra child table is one more batched IN (...) query, not one per
  // move — against Turso's networked connection in production each round-trip
  // is real latency, and this is the single read path every move surface goes
  // through (Compendium, a character's Moves tab, every move:created payload).
  const [rows, tagRows, rollSlotRows, resistSlotRows, defensiveSlotRows, directionRows] =
    await readMany([
      [`SELECT * FROM move_interactions WHERE move_id IN (${marks}) ORDER BY id`, ids],
      [`SELECT * FROM move_tags WHERE move_id IN (${marks}) ORDER BY id`, ids],
      [`SELECT * FROM move_roll_slots WHERE move_id IN (${marks}) ORDER BY id`, ids],
      [`SELECT * FROM move_resist_roll_slots WHERE move_id IN (${marks}) ORDER BY id`, ids],
      [`SELECT * FROM move_defensive_roll_slots WHERE move_id IN (${marks}) ORDER BY id`, ids],
      [`SELECT * FROM move_grapple_directions WHERE move_id IN (${marks}) ORDER BY id`, ids],
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
  // All three slot tables share a shape, so they share a grouper — one row per
  // distinct slot with a count, expanded to the flat list every consumer
  // actually wants (see expandRollSlotRows).
  const groupSlots = (slotRows) => {
    const bySlot = new Map();
    for (const row of slotRows) {
      if (!bySlot.has(row.move_id)) bySlot.set(row.move_id, []);
      bySlot.get(row.move_id).push(...expandRollSlotRows([row]));
    }
    return bySlot;
  };
  const rollSlotsByMove = groupSlots(rollSlotRows);
  const resistSlotsByMove = groupSlots(resistSlotRows);
  const defensiveSlotsByMove = groupSlots(defensiveSlotRows);

  // Requirement names. A move's Requirement points anywhere in the library,
  // which may be outside the list being attached to (a character's own moves
  // can require one they haven't been granted), so the name is resolved here
  // rather than left for each renderer to look up in whatever move list it
  // happens to hold. One batched query, and none at all in the common case
  // where nothing in this list has a Requirement.
  const requirementIds = [...new Set(moves.map((m) => m.requirement_move_id).filter((v) => v != null))];
  const requirementNames = new Map();
  if (requirementIds.length) {
    const reqMarks = requirementIds.map(() => '?').join(',');
    for (const row of await all(`SELECT id, name FROM moves WHERE id IN (${reqMarks})`, requirementIds)) {
      requirementNames.set(row.id, row.name);
    }
  }

  const directionsByMove = new Map();
  for (const row of directionRows) {
    if (!directionsByMove.has(row.move_id)) directionsByMove.set(row.move_id, []);
    directionsByMove.get(row.move_id).push({
      direction: row.direction,
      target_move_id: row.target_move_id,
    });
  }
  return moves.map((m) => ({
    ...m,
    interactions: byMove.get(m.id) ?? [],
    tag_ids: tagsByMove.get(m.id) ?? [],
    roll_slots: rollSlotsByMove.get(m.id) ?? [],
    resist_roll_slots: resistSlotsByMove.get(m.id) ?? [],
    defensive_roll_slots: defensiveSlotsByMove.get(m.id) ?? [],
    grapple_directions: directionsByMove.get(m.id) ?? [],
    requirement_move_name:
      m.requirement_move_id != null ? (requirementNames.get(m.requirement_move_id) ?? null) : null,
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
async function getMovesFor(characterId, { knownDice = null } = {}) {
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

  // Five independent lookups in **one** round trip. They were already
  // concurrent, which is the right shape — but `Promise.all` still puts five
  // requests on the wire, and this function runs once per character on the
  // combat snapshot.
  //
  // `knownDice` lets a caller that has already read this character's dice hand
  // them in rather than making this read them a second time: `GET /api/combat`
  // fetches every seated character's dice in one bulk query up front and then
  // called through here, which is how the same character's dice ended up being
  // read three times in a single request.
  const [overrideRows, tagOverrideRows, bonusRows, weaponRows, diceRows] = await readMany([
    [
      `SELECT * FROM character_move_overrides WHERE character_id = ? AND move_id IN (${marks})`,
      [characterId, ...ids],
    ],
    [
      `SELECT * FROM character_move_tags WHERE character_id = ? AND move_id IN (${marks})`,
      [characterId, ...ids],
    ],
    [
      `SELECT * FROM character_move_roll_bonuses WHERE character_id = ? AND move_id IN (${marks})`,
      [characterId, ...ids],
    ],
    // The Weapon, so a Move whose Roll names it can quote what it will actually
    // throw. Null for almost everybody (see server/weapons.js).
    ['SELECT * FROM weapons WHERE character_id = ?', [characterId]],
    // Live dice, keyed by body-part slot below, to resolve each move's Roll to
    // the character's actual current dice (not the shared template). Optional,
    // and therefore LAST: readMany drops falsy entries, so a conditional in the
    // middle would shift every index after it.
    knownDice ? null : ['SELECT * FROM dice WHERE character_id = ? ORDER BY id', [characterId]],
  ]);
  const dice = knownDice ?? diceRows;
  const weapon = weaponRows?.[0] ?? null;

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
  // The Weapon slot resolves to whatever is in hand, shaped like a die row so
  // every reader below treats it as one. Absent when they are carrying nothing,
  // which is exactly what makes such a move show as unrollable — and the
  // declare gate refuses it outright.
  const armed = weaponDie(weapon);
  if (armed) dieBySlot.set(WEAPON_SLOT, armed);

  // What each move actually costs THIS character, Perks included (Perfect
  // Player discounts a Dodge). Resolved here rather than left to the client
  // because it is the same figure move:declare will check against and
  // combat:character_done_declaring will spend — the picker must not be showing
  // a different one. The dice this needs are already in hand above.
  const staminaCosts = await resolveStaminaCosts(characterId, withBase, { knownDice: dice });
  // Frames a Perk adds to this character's moves (Osu!). Folded into the same
  // deltas the stored per-character overrides use, one line below, so a
  // Perk-granted frame is indistinguishable downstream from a GM-granted one —
  // same picker, same placement floor, same footprint, same Tic strip.
  const perkFrames = await perkMoveFrameDeltas({ characterId, moves: withBase });

  return withBase.map((move) => {
    const stored = overrideByMove.get(move.id) ?? { startup: 0, active: 0, recovery: 0 };
    const fromPerks = perkFrames.get(move.id);
    const deltas = fromPerks
      ? {
          startup: stored.startup + fromPerks.startup,
          active: stored.active + fromPerks.active,
          recovery: stored.recovery + fromPerks.recovery,
        }
      : stored;
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
      // Null for the Weapon: it is not a row in `dice`, so it has no die id to
      // send back. pool:roll takes it as its own `includeWeapon` flag instead.
      dieId: d.id ?? null,
      slot_name: d.slot_name,
      current_size: d.current_size,
      bonus: d.bonus,
      status: d.status,
    });
    // An appendage slot taken TWICE means both sides are used, so there is
    // no Left/Right question left to ask — it resolves to two concrete dice
    // here, exactly like a concrete slot, and never reaches rollChoice
    // below. Only a slot taken once is still ambiguous.
    const settledSlots = move.roll_slots.filter(
      (s) => !(s in AMBIGUOUS_ROLL_SLOTS) || countRollSlot(move.roll_slots, s) > 1
    );
    const rollDice = resolveRollSlotNames(settledSlots)
      .map((s) => dieBySlot.get(s))
      .filter(Boolean)
      .map(toDieInfo);
    const ambiguousSlots = move.roll_slots.filter(
      (s) => s in AMBIGUOUS_ROLL_SLOTS && countRollSlot(move.roll_slots, s) === 1
    );
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
      // Always present, and equal to stamina_cost whenever no Perk moved it —
      // so a client can render this one field unconditionally rather than
      // deciding for itself when the discount applies.
      effective_stamina_cost: staminaCosts.get(move.id) ?? move.stamina_cost,
    };
  });
}

async function getPerk(id) {
  const perk = await one('SELECT * FROM perks WHERE id = ?', [id]);
  if (!perk) return null;
  const tags = await all('SELECT perk_tag_id FROM perk_tag_links WHERE perk_id = ? ORDER BY id', [id]);
  return {
    ...perk,
    tag_ids: tags.map((t) => t.perk_tag_id),
    automated: isAutomatedPerk(perk.name),
    // Registered but deliberately not automated — the badge stays, its tooltip
    // changes. See multifaceted.js.
    manual: isManualPerk(perk.name),
  };
}

// A character's granted Perks (id, name, description, picture, plus whether
// the Perk has code behind it — mechanics are per-Perk code bound by name, see
// server/perks/index.js, never stored automation data).
async function getCharacterPerks(characterId) {
  const rows = await all(
    `SELECT p.*, cp.id AS character_perk_id
     FROM character_perks cp JOIN perks p ON p.id = cp.perk_id
     WHERE cp.character_id = ? ORDER BY cp.id`,
    [characterId]
  );
  if (!rows.length) return [];
  const perkIds = [...new Set(rows.map((r) => r.id))];
  const links = await all(
    `SELECT perk_id, perk_tag_id FROM perk_tag_links WHERE perk_id IN (${perkIds
      .map(() => '?')
      .join(',')}) ORDER BY id`,
    perkIds
  );
  const tagsBy = new Map();
  for (const l of links) {
    if (!tagsBy.has(l.perk_id)) tagsBy.set(l.perk_id, []);
    tagsBy.get(l.perk_id).push(l.perk_tag_id);
  }
  return rows.map((r) => ({
    id: r.id,
    character_perk_id: r.character_perk_id,
    name: r.name,
    description: r.description,
    image_data: r.image_data,
    image_mime_type: r.image_mime_type,
    tag_ids: tagsBy.get(r.id) ?? [],
    // Whether this Perk has code behind it (server/perks/index.js). A Perk's
    // mechanics bind to its NAME, which is invisible from the outside — the
    // card shows a badge for this so a GM can tell at a glance which of their
    // Perks actually do something and which are pure description.
    automated: isAutomatedPerk(r.name),
    manual: isManualPerk(r.name),
  }));
}

// Superset of the plan's die:updated payload: locked_* is included because the
// current-vs-locked tint can't update after Lock/Revert without it.
// **The Special Tag: GM-only to hand out (decided, new).**
//
// A Move or Perk carrying `Special` is invisible to a Player in the Compendium
// and in Character Creation — that is the whole feature, and it is done on the
// client where the browsing happens. This is the other half: the two grant
// events are open-access (a Player learning a Move for themselves uses the same
// event the GM's Grant list does), so without this a Player who knew the id
// could still take one.
//
// Matched by NAME against the thing's own tag vocabulary, exactly like every
// other Tag mechanic — Moves against `tags`, Perks against `perk_tags` — for
// the reason tagAutomations.js gives: ids differ between databases and the GM
// owns the list.
const SPECIAL_TAG_NAME = 'special';
const isSpecialMove = async (moveId) => {
  const row = await one(
    `SELECT 1 AS hit FROM move_tags mt JOIN tags t ON t.id = mt.tag_id
     WHERE mt.move_id = ? AND LOWER(TRIM(t.name)) = ?`,
    [moveId, SPECIAL_TAG_NAME]
  );
  return Boolean(row);
};
const isSpecialPerk = async (perkId) => {
  const row = await one(
    `SELECT 1 AS hit FROM perk_tag_links l JOIN perk_tags t ON t.id = l.perk_tag_id
     WHERE l.perk_id = ? AND LOWER(TRIM(t.name)) = ?`,
    [perkId, SPECIAL_TAG_NAME]
  );
  return Boolean(row);
};

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
  // **Temporary Damage**: how many half-steps of this Stat's damage wear off at
  // 0.5 a Round. Carried on the die itself so every surface that draws a Stat
  // can tint it, rather than each one asking separately — see the purple in
  // DieWidget.jsx and the cutscene's StatPip.
  temporary_damage: die.temporary_damage ?? 0,
});

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC
const sqliteToIso = (ts) =>
  ts && !ts.includes('T') ? new Date(ts.replace(' ', 'T') + 'Z').toISOString() : ts;

// Every declared move, Tell always included (never secret) but move_id/
// move_name withheld from anyone who isn't entitled to see it early (see
// isRevealedToViewer below). Split in two: the DB round-trip happens once
// per broadcast regardless of how many sockets are watching (fetchDeclaredMoveRows),
// then each connected socket's own view is a cheap in-memory map
// (mapDeclaredMovesForViewer) — see emitCombatUpdated. pair_index (Combat
// Automation overhaul) is a LEFT JOIN, not INNER: a declared move can
// briefly outlive its owner's seat (combat:remove_participant doesn't
// delete declared_moves), and such an orphaned row must still render for
// its own owner rather than silently vanishing — mapDeclaredMovesForViewer
// falls back to "never naturally reveals" for a null pair_index.
async function fetchDeclaredMoveRows() {
  return all(`
    SELECT dm.id, dm.character_id, dm.round_number, dm.queue_order,
           dm.placement_tic, dm.reveal_tic, dm.stamina_committed, dm.appendage_choice,
           dm.recovery_extension_tics, dm.trip_recovery_tics, dm.feint_masked, dm.target_character_id,
           dm.effective_attack_targets,
           m.id AS move_id, m.name AS move_name, m.tell_id, m.right_tell_id,
           m.left_tell_id, m.active_tics, m.recovery_tics, m.stamina_cost,
           m.defense_frame_positions, m.is_defensive, m.attack_targets,
           ch.character_type, cp.pair_index
    FROM declared_moves dm
    JOIN moves m ON m.id = dm.move_id
    JOIN characters ch ON ch.id = dm.character_id
    LEFT JOIN combat_participants cp ON cp.character_id = dm.character_id
    ORDER BY dm.id
  `);
}

// **Which declared moves carry the Feint Tag, for their own owners** (Never a
// Fool). Two queries for the whole board rather than the two-per-move
// `moveTagNamesFor` does, because this is asked on a broadcast: wall time there
// is depth times round-trip, and a per-move await chain would be one round trip
// per Tell on the strip.
//
// Resolved per character as well as per move, because a Perk can add or remove
// a Tag for one fighter (`character_move_tags`) — the same resolved set every
// other Tag mechanic reads, so a Perk that grants Feint really does feint.
//
// Returns a Set of DECLARED-move ids, not move ids: the same move thrown by two
// fighters can be a Feint for one of them and not the other.
async function feintDeclaredMoveIds(rows) {
  const moveIds = [...new Set(rows.map((r) => r.move_id).filter((id) => id != null))];
  if (!moveIds.length) return new Set();
  const marks = moveIds.map(() => '?').join(',');
  const [tagged, overrides] = await Promise.all([
    all(
      `SELECT mt.move_id FROM move_tags mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.move_id IN (${marks}) AND LOWER(TRIM(t.name)) = ?`,
      [...moveIds, FEINT_TAG.toLowerCase()]
    ),
    all(
      `SELECT cmt.character_id, cmt.move_id, cmt.action
       FROM character_move_tags cmt JOIN tags t ON t.id = cmt.tag_id
       WHERE cmt.move_id IN (${marks}) AND LOWER(TRIM(t.name)) = ?`,
      [...moveIds, FEINT_TAG.toLowerCase()]
    ),
  ]);
  const onTemplate = new Set(tagged.map((r) => r.move_id));
  const byPair = new Map(overrides.map((r) => [`${r.character_id}:${r.move_id}`, r.action]));
  const out = new Set();
  for (const row of rows) {
    // Removals win over additions, exactly as effectiveTagNames resolves them.
    const override = byPair.get(`${row.character_id}:${row.move_id}`);
    if (override === 'remove') continue;
    if (override === 'add' || onTemplate.has(row.move_id)) out.add(row.id);
  }
  return out;
}

// Every seated character, **with the character's own type joined in**
// (bugfix). `combat_participants` has no `character_type` column of its own,
// and `mapPendingGrappleForViewer` asks each row for one to decide whether
// the GM owns the character being prompted. A plain `SELECT *` therefore
// answered `undefined` for every seat, the GM never owned anything, and an
// NPC's grapple showed the GM a "waiting on <that same NPC>" bystander
// screen instead of the direction cross — a deadlock that read at the table
// as "grappling does not work". Joined here rather than fixed at the one
// call site so any future per-viewer rule gets the same truthful rows.
const allParticipants = () =>
  all(
    `SELECT cp.*, ch.character_type
     FROM combat_participants cp JOIN characters ch ON ch.id = cp.character_id
     ORDER BY cp.side, cp.pair_index, cp.id`
  );

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
// What this viewer is allowed to do that a Perk can change (decided, new).
//
// **Answered here rather than in the browser**, which is the whole point of the
// change: reading a revealed move in full used to be a `window.confirm("Does
// your character have the Genius Observer Perk?")` — an honour-system prompt
// that trusted the reader about the reader's own advantage. Identity is already
// tracked per connection for exactly this class of question (see identity:set
// and isRevealedToViewer below), so the same machinery answers this one.
//
// It is still the app's usual trust model — anybody can pick anybody's
// character at the door — but it is now the *same* trust model as everything
// else, rather than a second, weaker one layered on top.
//
// The GM always qualifies: they authored the move, and the gate exists to stop
// a Player reading detail their character did not earn.
async function capabilitiesFor(identity) {
  if (!identity) return { canSeeRevealedDetail: false };
  if (identity.role === 'gm') return { canSeeRevealedDetail: true };
  return { canSeeRevealedDetail: await perkAllowsRevealedDetail(identity.characterId) };
}

// Push a fresh answer to whoever is logged in as this character. Granting a
// Perk mid-session has to take effect at the table, not on the next reload.
async function refreshCapabilities(characterId) {
  const id = Number(characterId);
  if (!Number.isInteger(id)) return;
  let payload = null;
  for (const socket of io.sockets.sockets.values()) {
    const identity = socket.data?.identity;
    if (identity?.role !== 'player' || identity.characterId !== id) continue;
    payload = payload ?? (await capabilitiesFor(identity));
    socket.emit('identity:capabilities', payload);
  }
}

function isRevealedToViewer(row, viewer) {
  if (!viewer) return false;
  if (viewer.role === 'player') return viewer.characterId === row.character_id;
  if (viewer.role === 'gm') return row.character_type === 'npc';
  return false;
}

// Combat Automation overhaul: reveal timing is now a per-pair question —
// each row's own pair has its own independent phase/roundNumber/currentTic
// (combat_pairs), rather than one shared combat_state clock. `pairsByIndex`
// maps pair_index -> that pair's combat_pairs row. A row whose pair_index
// is null (see fetchDeclaredMoveRows' LEFT JOIN comment — an orphaned
// declared move outliving its owner's seat) or whose pair no longer exists
// falls back to "never naturally reveals to a non-owner" rather than
// guessing at a clock that no longer applies to it.
// **Eye Catcher (decided, new).** `attackHeightViewers` is the set of character
// ids whose Perks answer yes to `seesAttackHeight`, resolved once per broadcast
// (buildCombatUpdate) rather than per socket — the same one-read-many-views
// shape the rest of this function is built on. `pairIndexByCharacter` is what
// answers "is this attack coming at me" in a 1v1, where target_character_id is
// NULL because there is only one person it could be for.
function mapDeclaredMovesForViewer(
  rows,
  pairsByIndex,
  viewer,
  { attackHeightViewers = null, pairIndexByCharacter = null, feintViewers = null, feintDeclaredMoveIds: feintIds = null } = {}
) {
  // Whether THIS viewer is entitled at all, asked once instead of per row.
  const viewerSeesHeight = Boolean(
    viewer?.role === 'player' && attackHeightViewers?.has(viewer.characterId)
  );
  // ...and the same question for Never a Fool, which reads exactly the same
  // three gates below and so shares `viewerPairIndex`.
  const viewerSeesFeints = Boolean(
    viewer?.role === 'player' && feintViewers?.has(viewer.characterId)
  );
  const viewerPairIndex = viewerSeesHeight || viewerSeesFeints
    ? pairIndexByCharacter?.get(viewer.characterId) ?? null
    : null;
  // Null when this viewer has not earned this row's height, so the spread at
  // the push below adds no key at all rather than an empty one.
  const attackHeightsForViewer = (row) => {
    if (!viewerSeesHeight) return null;
    if (row.character_id === viewer.characterId) return null;
    if (viewerPairIndex == null || row.pair_index !== viewerPairIndex) return null;
    if (row.target_character_id != null && row.target_character_id !== viewer.characterId) return null;
    const heights = attackHeights(parseConcreteAttackTargets(row.effective_attack_targets));
    return heights.length ? { attackHeights: heights } : null;
  };
  // **Never a Fool.** The identical three gates — somebody else's move, in this
  // viewer's own pair, coming at this viewer (or at nobody in particular, which
  // is every 1v1). Null when unearned so the spread adds no key at all: a row
  // saying `isFeint: false` would tell a devtools reader which moves are not
  // Feints, and by elimination which ones are.
  const feintForViewer = (row) => {
    if (!viewerSeesFeints || !feintIds?.has(row.id)) return null;
    if (row.character_id === viewer.characterId) return null;
    if (viewerPairIndex == null || row.pair_index !== viewerPairIndex) return null;
    if (row.target_character_id != null && row.target_character_id !== viewer.characterId) return null;
    return { isFeint: true };
  };

  const out = [];
  for (const row of rows) {
    const viewerIsOwner = isRevealedToViewer(row, viewer);
    const pair = row.pair_index != null ? pairsByIndex.get(row.pair_index) : null;
    const currentTic = pair ? pair.current_tic : -Infinity;
    const phase = pair ? pair.phase : null;
    const roundNumber = pair ? pair.round_number : row.round_number;
    // Natural (non-owner) reveal only applies once this row's own pair has
    // actually entered its Resolving phase. Without this, a 0-Startup move
    // placed at the round's very first Tic already satisfies currentTic >=
    // revealTic the instant it's declared — while still in Declaration
    // Phase, before the other side has even finished declaring — leaking
    // its identity to everyone early. A row from an earlier round (for this
    // same pair) is always safe to check live: round_start_tic/current_tic
    // only ever move forward, so this can't un-reveal something already
    // legitimately shown.
    const ticCountdownRanForThisRow = row.round_number < roundNumber || phase === 'resolving';
    // Split out of isRevealed below (Attack telegraph, decided): "has this
    // move gone public" is a property of the board, while `isRevealed` is a
    // property of *this viewer* — the owner sees their own move from the
    // moment they declare it. The Attack telegraph (see the Combat Timing
    // section of the plan) has to key off the former: gating it on
    // `isRevealed` would hide a fighter's own telegraph from themselves
    // while every opponent still saw it, which reads as a bug rather than
    // as secrecy. Discloses nothing new — currentTic and revealTic are both
    // already public on every row, so any client could derive this itself.
    const publiclyRevealed =
      ticCountdownRanForThisRow &&
      isMoveRevealedTo({ revealTic: row.reveal_tic, currentTic, viewerIsOwner: false });
    const isRevealed = viewerIsOwner || publiclyRevealed;
    // Feint Tag (decided, new): a move declared immediately after a Feint is
    // not merely Tell-less to everyone else — it is not on the board at all
    // until it reveals. Dropped from the payload rather than blanked,
    // because every other secret in this game is protected by *absence* of
    // data (see moveId/moveName/staminaCost below, and
    // mapPendingGrappleForViewer): a row that said `{ placementTic: 4,
    // feintMasked: true }` would tell an opponent with devtools exactly what
    // the Feint exists to hide, and the telegraph would paint a glow on that
    // Tic for everyone regardless.
    //
    // Safe to reappear mid-round: `publiclyRevealed` only ever goes from
    // false to true (current_tic only moves forward, and a row from an
    // earlier round is always past its reveal), so a masked move pops onto
    // the timeline exactly once, at the Tic it reveals on — which is the
    // "revealing it during the cutscene" half of the rule.
    if (row.feint_masked && !viewerIsOwner && !publiclyRevealed) continue;
    out.push({
      id: row.id,
      characterId: row.character_id,
      roundNumber: row.round_number,
      queueOrder: row.queue_order,
      placementTic: row.placement_tic,
      revealTic: row.reveal_tic,
      activeEndTic: row.reveal_tic + row.active_tics,
      // + recovery_extension_tics (Combat Automation, sub-phase 3): 0 for
      // every move untouched by a Block's Recovery extension — see the
      // column's own comment in db.js — the automatic engine is what sets it now.
      recoveryEndTic: row.reveal_tic + row.active_tics + row.recovery_tics + row.recovery_extension_tics,
      // **Trip Recovery frames, as a count off the end (decided, new).** Same
      // disclosure reasoning as the two Tic ends above: this is structure, not
      // identity — where somebody is lying on the floor is a plain visible
      // fact, and the Off The Ground Tag makes it one both sides play around.
      // The client derives the window from this and recoveryEndTic, exactly as
      // `tripWindow` does server-side, so there is one rule for where they are.
      tripRecoveryTics: row.trip_recovery_tics ?? 0,
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
      // Uneven Combat: who this move is coming for. Public for the same reason
      // placementTic is — squaring up to someone is visible at the table, and
      // it is what lets the matchup plaque show the right number for everyone
      // rather than only for the fighter who picked. NULL in a 1v1.
      targetCharacterId: row.target_character_id ?? null,
      isRevealed,
      publiclyRevealed,
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
      // Feint Tag: only ever true on a row this viewer is entitled to see —
      // an opponent never learns a masked move exists, because the row is
      // dropped below rather than blanked. For the owner it drives the
      // "hidden" marker on their own Tell card.
      feintMasked: Boolean(row.feint_masked),
      // **Eye Catcher: the height, alongside the Tell.** Present only on rows
      // this viewer's Perk actually earns them — somebody else's move, in this
      // viewer's own pair, coming at this viewer — and absent entirely
      // otherwise, following the same protect-by-absence rule as moveId and
      // moveName above rather than sending a flag a devtools reader could just
      // flip.
      //
      // Not gated on `isRevealed`: knowing it BEFORE the move shows itself is
      // the Perk's entire content. Once the move reveals, its full target list
      // is public anyway and the band is merely redundant. A defence-pure move
      // has no Attack Targets and so reports no height at all, which is the
      // true answer rather than a withheld one.
      ...(attackHeightsForViewer(row) ?? {}),
      // **Never a Fool: that it is a Feint, and nothing else.** Present only on
      // rows the Perk earns, absent everywhere else — and deliberately NOT
      // gated on `isRevealed`, since knowing before the move shows itself is
      // the whole content of the Perk. Once it reveals, its Tags are public
      // anyway.
      ...(feintForViewer(row) ?? {}),
    });
  }
  return out;
}

// **What a set of moves costs THIS character (decided, new).** Perks can move a
// move's Stamina Cost (Perfect Player discounts a Dodge by 2), so "the cost" is
// no longer a column — it is a column plus whatever this fighter's Perks say
// about this particular move.
//
// One resolver, used by every place that needs the number: the picker that
// shows it, the affordability check that permits a declaration, and the commit
// that actually spends it. They used to be three separate reads of
// `m.stamina_cost`, two of them SQL SUMs; a Perk that moved the figure in only
// some of them would show a player one number and charge them another.
//
// The character's dice and Injuries are fetched once and handed to every Perk,
// rather than each seam function querying for itself — the conditions Perks want
// here are all about the state of the fighter, and this is asked once per move.
async function resolveStaminaCosts(characterId, moves, { knownDice = null } = {}) {
  if (!moves.length) return new Map();
  // `knownDice` for the same reason getMovesFor takes it: the combat snapshot
  // already read every seated character's dice in bulk, and this used to make
  // it read them again per character.
  // The optional statement goes LAST so the required ones keep fixed indices —
  // readMany drops falsy entries, and a conditional in the middle would shift
  // everything after it.
  const [injuries, diceRows] = await readMany([
    ['SELECT * FROM injuries WHERE character_id = ? ORDER BY id', [characterId]],
    knownDice ? null : ['SELECT * FROM dice WHERE character_id = ? ORDER BY id', [characterId]],
  ]);
  const dice = knownDice ?? diceRows;
  // One batched pass, not one per move — see perkStaminaCostDeltas. The picker
  // asks about a character's whole move list at once.
  const deltas = await perkStaminaCostDeltas({ characterId, moves, dice, injuries });
  const out = new Map();
  for (const move of moves) {
    out.set(move.id, effectiveStaminaCost(move.stamina_cost, deltas.get(move.id) ?? 0));
  }
  return out;
}

// One move's effective cost. The single-move shorthand over the above.
async function getEffectiveStaminaCost(characterId, move) {
  const costs = await resolveStaminaCosts(characterId, [move]);
  return costs.get(move.id) ?? effectiveStaminaCost(move.stamina_cost, 0);
}

// Sum of Stamina Cost across a character's declared-but-not-yet-committed
// moves — moves only stay uncommitted until this character themselves
// presses "done declaring" (combat:character_done_declaring commits them
// all at once), so this is also exactly "how much is currently pending."
//
// A fetch-then-fold rather than the SQL SUM it used to be, because the cost of
// each row is now a per-character question rather than a column.
async function getPendingStaminaCost(characterId) {
  // `dm.id` rides along so each row is priced against ITS OWN predecessor in the
  // queue rather than against whatever was declared last — see the bugfix note
  // in perkStaminaCostDeltas. Without it a combo is charged a different figure
  // from the one the picker quoted for it.
  const rows = await all(
    `SELECT m.*, dm.id AS declared_move_id FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
     WHERE dm.character_id = ? AND dm.stamina_committed = 0`,
    [characterId]
  );
  if (!rows.length) return 0;
  const costs = await resolveStaminaCosts(characterId, rows);
  return rows.reduce((sum, move) => sum + (costs.get(move.id) ?? 0), 0);
}

// Combat Automation overhaul: each pair now runs its own independent round/
// phase/Tic clock (combat_pairs), replacing the single global one
// combat_state used to hold — combat_state.phase/round_number/current_tic/
// round_start_tic are now unused leftovers (see db.js's own comment on that
// exact precedent, already true of declaring_side/pending_declare_side).
// This shapes one raw combat_pairs row into the client-facing shape shared
// by both GET /api/combat and combat:updated — camelCase, plus the derived
// relativeTic/isOverflow/overflowBy every existing Tic Counter render
// already expects (see combatTiming.js's relativeTic).
// **A pause payload that will not take the Arena down with it (bugfix, new).**
//
// `GET /api/combat` is the Arena's whole world — if it throws, the page has no
// partial state to fall back on and simply never finishes loading. That makes
// every `JSON.parse` on this path a single point of failure for the entire
// screen, and the values being parsed are the *least* trustworthy rows in the
// database: mid-round pause payloads, written by a resolution that may have
// been interrupted by a redeploy or a free-tier spin-down halfway through.
//
// One unreadable pause on one pair is not a reason nobody can see the Arena.
// It degrades to "this pair has no prompt", which the GM can clear and re-run,
// and it says so loudly in the log rather than silently — a prompt that has
// quietly vanished is its own bug and must not look like normal operation.
function parsePausePayload(json, what, pairIndex) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (err) {
    console.error(
      `Unreadable ${what} payload on pair ${pairIndex} — the prompt is being dropped so the ` +
        `Arena can still load. Clear the pair to re-run the round. Stored value: ${String(json).slice(0, 200)}`,
      err
    );
    return null;
  }
}

// The same guard extended over the shaping step. `defensePromptPayload` reads
// fields off the parsed payload, so handing it a null — or a payload that
// parsed but is not the shape it expects, which a half-written row can easily
// be — would throw from one line further down and cost the whole Arena just the
// same. Parsing safely and then shaping unsafely would be a guard in name only.
function defensePromptOrNull(json, kind, what, pairIndex) {
  const payload = parsePausePayload(json, what, pairIndex);
  if (!payload) return null;
  try {
    return defensePromptPayload(payload, kind);
  } catch (err) {
    console.error(`Unusable ${what} payload on pair ${pairIndex} — dropping the prompt.`, err);
    return null;
  }
}

// One viewer's half of a Non-Committed prompt: the entry that belongs to them,
// and nothing else.
//
// **Never the whole payload.** It lists move names for every holder in the
// pair, and a pair can have a holder on each side — handing that across would
// disclose an opponent's undeclared board, which is the one thing Declaration
// exists to keep. A GM sees their NPCs' entries; a Player sees their own.
function nonCommitForViewer(pending, viewer) {
  const entries = pending?.entries ?? [];
  if (!entries.length || !viewer) return null;
  const mine = entries.filter((entry) =>
    viewer.role === 'player'
      ? viewer.characterId === entry.characterId
      : entry.characterType === 'npc'
  );
  return mine.length ? { entries: mine } : null;
}

function shapePair(row, roundLength, resolution, viewer) {
  const tic = relativeTic({ tic: row.current_tic, roundStartTic: row.round_start_tic, roundLength });
  return {
    pairIndex: row.pair_index,
    declaringSide: row.declaring_side,
    phase: row.phase,
    roundNumber: row.round_number,
    currentTic: row.current_tic,
    roundStartTic: row.round_start_tic,
    relativeTic: tic.relative,
    isOverflow: tic.isOverflow,
    overflowBy: tic.overflowBy,
    // Combat Automation overhaul §2.4 — this pair's in-flight resolution,
    // if any, folded into the regular snapshot so a reconnecting or
    // newly-connecting client picks up a pending Dodge/conflict prompt
    // "for free" instead of needing its own resync plumbing. Null on a
    // pair that's declaring or whose round already completed.
    resolutionId: resolution?.id ?? null,
    resolutionStatus: resolution?.status ?? null,
    //
    // **Already shaped into the question, and GM-only (revised).** These used
    // to be handed over as the raw pause row for the client to re-derive
    // `coverage` and `targetSlotName` from — in two places, differently from
    // how the live push worded it. `defensePromptPayload` is now the single
    // author of both, and the prompt is withheld from a Player socket outright:
    // it carries the attacker's roll total, and nothing but a GM has any
    // business reading that mid-round.
    pendingDodge:
      viewer?.role === 'gm' && resolution?.status === 'paused_dodge' && resolution.pending_dodge_json
        ? defensePromptOrNull(resolution.pending_dodge_json, 'dodge', 'Dodge', row.pair_index)
        : null,
    // The conflict prompt is the affected *fighter's* call, not the GM's, so it
    // stays on the shared shape and the client filters it by ownership.
    pendingConflict:
      resolution?.status === 'paused_conflict' && resolution.pending_conflict_json
        ? parsePausePayload(resolution.pending_conflict_json, 'conflict', row.pair_index)
        : null,
    // **The Non-Committed window (decided, new).** Scoped to the fighter it
    // belongs to, not to the GM: it is their own moves being taken back, and
    // the payload names what they declared — which is exactly the thing
    // declaration keeps secret from everyone else until it reveals. A GM
    // controlling an NPC gets it because they control that NPC, on the same
    // ownership test the conflict prompt already uses.
    pendingNonCommit:
      resolution?.status === 'paused_noncommit' && resolution.pending_noncommit_json
        ? nonCommitForViewer(parsePausePayload(resolution.pending_noncommit_json, 'Non-Committed', row.pair_index), viewer)
        : null,
    // The Block prompt rides the same snapshot as the Dodge prompt above, so a
    // GM who connects (or reconnects) into an already-paused pair picks it up
    // for free. Everything on it is already GM-visible — the payload names the
    // two moves by name, and only GMs are ever shown it (see the client's own
    // role gate, matching combat:block_prompt's emitToGMs delivery).
    pendingDefense:
      viewer?.role === 'gm' && resolution?.status === 'paused_defense' && resolution.pending_defense_json
        ? defensePromptOrNull(resolution.pending_defense_json, 'block', 'Block', row.pair_index)
        : null,
    // Deliberately NOT included here. Grappling's prompt differs per viewer —
    // the grappler sees the move names, the target sees four blanks — so it
    // is built inside emitCombatUpdated's per-socket loop instead, where the
    // viewer's identity is known. Putting it in the shared `base` object is
    // exactly the mistake that would leak the whole mini-game.
    pendingGrapple: undefined,
  };
}

// The in-flight (non-complete) resolution per pair, keyed by pair_index —
// at most one row each, since pair_round_resolutions is UNIQUE(pair_index,
// round_number) and a pair only ever has one round open at a time. Scoped
// to non-complete rows rather than fetching the whole table, which grows by
// one row per pair per round for the life of a fight.
async function fetchOpenResolutionsByPair() {
  const rows = await all(
    `SELECT id, pair_index, round_number, status, pending_dodge_json, pending_conflict_json,
            pending_defense_json, pending_grapple_json
     FROM pair_round_resolutions WHERE status != 'complete'`
  );
  return new Map(rows.map((r) => [r.pair_index, r]));
}

// The stance matchup for every pair that currently has anyone seated, for
// the Arena's VS divider. Keyed off combat_participants rather than
// combat_pairs on purpose: the whole point is to show two fighters what they
// are facing *before* the fight starts, and a pair has no combat_pairs row
// until its first round opens. Entries the rule doesn't apply to are dropped
// (see getPairStanceMatchup), so the UI renders nothing rather than a 0 that
// would read as "even matchup".
async function fetchPairStanceMatchups() {
  const rows = await all('SELECT DISTINCT pair_index FROM combat_participants ORDER BY pair_index');
  const results = await Promise.all(rows.map((r) => getPairStanceMatchup(r.pair_index)));
  return results.filter(Boolean);
}

// Broadcasts the Combat Arena's full current state — seating/toggle plus
// (Phase 7) the round/Tic timing state and every declared move — called
// from the combat:*/move:declare socket handlers below and from character
// delete (a seated character leaving the roster needs the arena to drop
// them too). Always the full state, not a delta, same pattern `participants`
// already used before Phase 7. declaredMoves' visibility depends on who's
// watching (see isRevealedToViewer above), so this is a per-socket emit
// rather than one io.emit — the DB round-trip still only happens once.
// Everything a combat snapshot is built from, read once. Split out from the
// emit below because the pair shape is now **viewer-dependent** — the defence
// prompts are GM-only (see shapePair) — and because a single socket sometimes
// needs resyncing on its own without a broadcast (see identity:set).
async function buildCombatUpdate() {
  const [state, participants, pairRows, declaredMoveRows, openResolutions, stanceMatchups] =
    await Promise.all([
      one('SELECT * FROM combat_state WHERE id = 1'),
      allParticipants(),
      all('SELECT * FROM combat_pairs ORDER BY pair_index'),
      fetchDeclaredMoveRows(),
      fetchOpenResolutionsByPair(),
      fetchPairStanceMatchups(),
    ]);
  // **Eye Catcher, asked once for the whole table (decided, new).** Which
  // seated fighters read attack height is a property of the board, not of the
  // socket looking at it, so it is resolved here — with the whole set in ONE
  // Promise.all rather than a per-character await chain, because wall time on
  // a broadcast is depth times round-trip, never count (see the DB latency
  // notes in the plan). A character with no such Perk costs a single cached
  // perk read and stops before touching anything else.
  const attackHeightViewers = new Set();
  const feintViewers = new Set();
  const seated = participants.map((p) => p.character_id);
  const [sees, seesFeints] = await Promise.all([
    Promise.all(seated.map((id) => perkSeesAttackHeight(id))),
    // **Never a Fool, on the same one-read-many-views footing.** Both sets are
    // properties of the board rather than of the socket looking at it, and both
    // cost a single cached Perk read per seated fighter.
    Promise.all(seated.map((id) => perkSeesFeints(id))),
  ]);
  seated.forEach((id, i) => {
    if (sees[i]) attackHeightViewers.add(id);
    if (seesFeints[i]) feintViewers.add(id);
  });
  // Only worth the two queries when somebody at the table can actually use it.
  const feintIds = feintViewers.size ? await feintDeclaredMoveIds(declaredMoveRows) : new Set();
  return {
    state,
    participants,
    pairRows,
    declaredMoveRows,
    openResolutions,
    stanceMatchups,
    attackHeightViewers,
    feintViewers,
    feintDeclaredMoveIds: feintIds,
    pairIndexByCharacter: new Map(participants.map((p) => [p.character_id, p.pair_index])),
    pairsByIndex: new Map(pairRows.map((row) => [row.pair_index, row])),
  };
}

function combatUpdateFor(built, viewer) {
  const {
    state, participants, pairRows, declaredMoveRows, openResolutions, stanceMatchups, pairsByIndex,
    attackHeightViewers, pairIndexByCharacter, feintViewers, feintDeclaredMoveIds: feintIds,
  } = built;
  return {
    unevenCombatEnabled: Boolean(state.uneven_combat_enabled),
    freshStart: Boolean(state.fresh_start),
    roundLength: state.round_length,
    // Combat Automation overhaul: declaration/round/phase/Tic state all now
    // lives per-pair (pairs[].phase/roundNumber/currentTic/etc) — pairs[]
    // .declaringSide is whichever side of that pair may currently call
    // move:declare (null once both sides of it are done);
    // participants[].declared_this_round is the per-character status the
    // GM's declaration table renders (see Combat Timing above).
    //
    // Every pending prompt a pair can be holding rides along: the defence
    // prompts (GM-only), the conflict prompt (ownership-filtered client-side),
    // and grappling's per-viewer mini-game. This snapshot is the ONLY delivery
    // path the client trusts for them — see the plan's "Pause delivery" note.
    pairs: pairRows.map((row) => ({
      ...shapePair(row, state.round_length, openResolutions.get(row.pair_index), viewer),
      // Deliberately built per viewer: the grappler sees the move names, the
      // target sees four blanks. Putting it on a shared object is exactly the
      // mistake that would leak the whole mini-game.
      pendingGrapple: mapPendingGrappleForViewer(openResolutions.get(row.pair_index), viewer, participants),
    })),
    participants,
    // What each side of each pair's stance is worth against the other, for
    // the Arena's VS divider (see fetchPairStanceMatchups).
    stanceMatchups,
    declaredMoves: mapDeclaredMovesForViewer(declaredMoveRows, pairsByIndex, viewer, {
      attackHeightViewers,
      pairIndexByCharacter,
      feintViewers,
      feintDeclaredMoveIds: feintIds,
    }),
  };
}

async function emitCombatUpdated() {
  const built = await buildCombatUpdate();
  for (const viewerSocket of io.sockets.sockets.values()) {
    viewerSocket.emit('combat:updated', combatUpdateFor(built, viewerSocket.data.identity));
  }
}

// Handed to the resolution engine on the one object it already holds. It cannot
// import this module — server/index.js starts a listening HTTP server at module
// load, so importing it from the engine would boot a second server — and the
// engine genuinely needs it: raising a pause has to broadcast, or the prompt
// reaches nobody who wasn't already looking. See broadcastPause there.
io.emitCombatUpdated = emitCombatUpdated;

// One socket, on its own. The reason this exists: a paused pair produces no
// further broadcasts — that is what being paused means — so a client that was
// disconnected when the pause fired has nothing to catch up on and no event
// coming. Sending it the snapshot the moment it identifies is what closes that
// hole, and identity is re-sent on every reconnect (roleContext.jsx).
async function emitCombatUpdatedTo(viewerSocket) {
  const built = await buildCombatUpdate();
  viewerSocket.emit('combat:updated', combatUpdateFor(built, viewerSocket.data?.identity));
}

// Grappling's prompt, as this one viewer is allowed to see it.
//
// **Keep the structure, null the identity** — the same rule
// mapDeclaredMovesForViewer already follows for a secret declared move. Both
// sides get four entries and know how many carry a move; only the grappler
// gets the names. Nulling here rather than omitting means the target's cross
// still renders four arrows in the right places, which is what makes the
// guess a guess rather than a shrug.
//
// The GM is NOT privileged here. Whoever owns the grabbing character sees the
// names; everyone else, GM included, sees blanks — matching
// isRevealedToViewer's own adversarial stance, where a GM does not get to see
// a PC's declared move either.
function mapPendingGrappleForViewer(resolution, identity, participants) {
  if (resolution?.status !== 'paused_grapple' || !resolution.pending_grapple_json) return null;
  const pending = parsePausePayload(
    resolution.pending_grapple_json,
    'grapple',
    resolution.pair_index
  );
  if (!pending) return null;
  const owns = (characterId) => {
    if (!identity) return false;
    if (identity.role === 'player') return identity.characterId === characterId;
    // The GM owns every NPC. An all-NPC grapple never reaches this function —
    // resolveGrapple auto-chains it rather than prompting — so this can only
    // ever put the GM on one side of a real prompt. `character_type` reaches
    // these rows through allParticipants' join; it is not a column of
    // combat_participants, and reading it off a bare SELECT * silently made
    // the GM a bystander at every prompt (see that helper).
    return participants.some((p) => p.character_id === characterId && p.character_type === 'npc');
  };
  const isGrappler = owns(pending.grapplerCharacterId);
  const isTarget = owns(pending.targetCharacterId);
  // Which of the two sequential phases is open (decided, revised): the grappler
  // picks their follow-up first, then — only if a read is happening — the
  // defender guesses. Whoever is not being asked right now waits.
  const phase = pending.phase ?? 'choice';
  const waitingOn = phase === 'choice' ? pending.grapplerCharacterName : pending.targetCharacterName;

  if (!isGrappler && !isTarget) {
    // A bystander sees that a grapple is happening, who it is waiting on, and
    // nothing else. Naming the blocker is the difference between a round that
    // looks broken and one that is visibly waiting for a person — which is
    // exactly what a missing player's grapple looked like before.
    return {
      grapplerCharacterName: pending.grapplerCharacterName,
      targetCharacterName: pending.targetCharacterName,
      grapplerMoveName: pending.grapplerMoveName,
      role: 'observer',
      phase,
      waitingOn,
      answered: true, // nothing is being asked of them
      directions: [],
    };
  }

  const myTurn = (isGrappler && phase === 'choice') || (isTarget && phase === 'guess');
  return {
    grapplerDeclaredMoveId: pending.grapplerDeclaredMoveId,
    grapplerCharacterName: pending.grapplerCharacterName,
    targetCharacterName: pending.targetCharacterName,
    grapplerMoveName: pending.grapplerMoveName,
    role: isGrappler ? 'grappler' : 'target',
    phase,
    waitingOn,
    // `answered` now means "there is nothing for me to do", which covers both
    // having answered and its not being my phase yet. Still never says whether
    // the *other* side has answered — except that the defender being asked at
    // all implies the grappler has, which sequencing makes unavoidable and
    // which discloses nothing about *what* they picked.
    answered: !myTurn,
    directions: pending.directions.map((d) => ({
      direction: d.direction,
      // The target gets the shape and not the substance: no ids, no names, and
      // no availability either — which of the grappler's follow-ups they can
      // afford is their business.
      moveId: isGrappler ? d.moveId : null,
      moveName: isGrappler ? d.moveName : null,
      staminaCost: isGrappler ? d.staminaCost : null,
      available: isGrappler ? d.available : null,
      reason: isGrappler ? d.reason : null,
    })),
  };
}

// Reasons to Fight and the Stance matchup both live in
// server/combatBonuses.js now — see getCombatRollBonus there for why they're
// summed in one place rather than added per call site.

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
// Which move a manual roll belongs to, when the client said. Only the
// reveal-time auto-Roll dialog passes a declaredMoveId; the Dice Tray and a
// bare stat roll don't, and get null — getStanceMatchupBonus then falls back
// to whatever the roller has in play. Combat Style needs this so a move's own
// style still counts on the one roll path a human drives by hand.
async function moveIdOfDeclared(declaredMoveId) {
  if (declaredMoveId == null) return null;
  const row = await one('SELECT move_id AS moveId FROM declared_moves WHERE id = ?', [declaredMoveId]);
  return row?.moveId ?? null;
}

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


// Combat Automation (Phase 9, sub-phase 3): a GM-authored system notice —
// "Block/Dodge has failed," "Partial Block — 1.5 damage," a Forfeit/
// Interruption Stamina-refund note, and so on (see the plan's 4.1-4.4). Same
// insertion shape chat:message already uses for a GM-posted row (posts as
// the GM_CHAT_SENTINEL_ID persona), just triggered by combat resolution
// instead of the compose box.

// Combat Automation (Phase 9, sub-phase 3): the shared clamp+update+
// broadcast a Stamina change already uses (see stamina:adjust below) —
// factored out so Forfeit's full refund (4.3) and Interruption's half
// refund (4.4) can reuse it instead of duplicating the clamp/broadcast
// logic. Returns the character's new current_stamina, or null if the
// character doesn't exist. `delta` can be negative (a cost), though every
// current caller only ever passes a positive refund.

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
// which role at each trigger.
//
// **Recovery is applied to the clock, not to a row (decided, new).** An
// `opponent_recovery`/`self_recovery` no longer picks a declared move to
// bump a counter on; it asks what that character is doing at the Tic it
// fires on — winding up, mid-move, or between moves — puts the frames where
// that answer says they go, and slides everything they had declared after it
// that many Tics later. `planImposedRecovery` in server/combatTiming.js
// holds the whole rule, and `imposeRecovery` in server/roundResolution.js
// is the only caller. The old "whichever of their declared moves ends
// latest" fallback is gone with it: the question was never *which* move, and
// "between moves" is now a real answer rather than a missing one.
// opponent_recovery/opponent_stamina are still silently skipped if there is
// no opponent at all (declaredMoveId unresolvable).

// Combat Automation overhaul: fireMissIfNoDamage used to live here, firing
// a move's 'miss' trigger whenever its own reveal-time roll came back under
// 5. Both halves of that are gone. The trigger moved (a Miss is an attack
// evaded by a Dodge now, fired only from applySuccessfulDodge in
// server/roundResolution.js; a sub-5 roll is Insignificant Damage, which is
// a hit that did too little to matter and fires On Hit), and the path
// itself was already unreachable — every combat roll
// is server-computed by the engine, so no client roll has carried a
// declaredMoveId since the overhaul.

// ---------- REST API ----------

// Express 4 doesn't catch async route errors — without this a DB hiccup
// would crash the whole server.
// The message rides along with the 500 (decided, new).
//
// It used to be a flat `internal error`, which meant a failing endpoint told
// nobody anything: the server log had the stack, but the log lives on Render
// and the person looking at the broken screen is usually not the person who can
// read it. That is exactly how an Arena that threw on every load presented as
// an infinite spinner with no way in — see the Arena's own error state.
//
// Nothing is leaked by this that the app does not already hand out: there is no
// auth here by design (see the plan), `/api/health` has always returned
// `err.message`, and every reader is a GM or a player at the same table.
// **Which region of an uploaded picture shows.** Four fractions of the
// picture's own width and height, and the one field on any of these tables that
// reaches a renderer as raw CSS — `client/src/lib/imageCrop.js` turns it into
// four percentages on an <img>. So it is validated rather than clamped: a NaN
// or a rectangle that leaves the picture would draw a thumbnail as an empty box
// with nothing logged anywhere.
//
// Anything that is not a real rectangle inside the picture is stored as four
// NULLs, which the client reads as "no crop" and renders with plain
// `object-fit: cover` — exactly what every picture uploaded before the crop
// editor existed still does.
//
// **Always written together with the image**, never on its own: a new picture
// means the old crop described a different photograph, so it goes.
const CROP_COLUMNS = 'crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?';

function cropValues(payload) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = num(payload?.cropX);
  const y = num(payload?.cropY);
  const w = num(payload?.cropW);
  const h = num(payload?.cropH);
  const slack = 1e-6;
  const ok =
    x !== null && y !== null && w !== null && h !== null &&
    w > 0 && h > 0 &&
    x >= -slack && y >= -slack && x + w <= 1 + slack && y + h <= 1 + slack;
  return ok ? [x, y, w, h] : [null, null, null, null];
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(`error in ${req.method} ${req.path}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ? `internal error: ${err.message}` : 'internal error' });
    }
  });

app.get('/api/health', async (_req, res) => {
  try {
    const started = Date.now();
    await db.execute('SELECT 1');
    // The sync half is the part worth being able to read from outside. It is
    // the one thing about this deployment that cannot be reproduced locally
    // (offline writes need a real syncUrl), and `lastSyncMs` doubles as the
    // length of time the server answers nothing, because `db.sync()` blocks the
    // event loop — see the note above the sync loop in db.js.
    res.json({
      ok: true,
      db: 'connected',
      readMs: Date.now() - started,
      sync: syncHealth(),
    });
  } catch (err) {
    res.status(500).json({ ok: false, db: 'error', message: err.message });
  }
});

// **Stances ride along (decided, new).** The Compendium needs every
// character's stances to decide which styled moves each of them could ever
// learn, and its only way to get them was to fetch a whole character sheet per
// character — `getCharacter(c.id)` in a loop, 24 queries each, re-run on every
// one of the twenty events it listened to. Two queries here replace all of
// that, and nothing else on this endpoint changes: `stances` is additive, so
// callers that only want the flat roster are untouched.
app.get('/api/characters', wrap(async (_req, res) => {
  const [characters, stanceRows] = await Promise.all([
    all('SELECT * FROM characters ORDER BY id'),
    all('SELECT * FROM stances ORDER BY character_id, id'),
  ]);
  const stancesByCharacter = new Map();
  for (const stance of stanceRows) {
    if (!stancesByCharacter.has(stance.character_id)) stancesByCharacter.set(stance.character_id, []);
    stancesByCharacter.get(stance.character_id).push(stance);
  }
  res.json(
    characters.map((character) => ({
      ...omitVitruvianArt(character),
      stances: stancesByCharacter.get(character.id) ?? [],
    }))
  );
}));

// Character-list folders (GM-managed) — separate from /api/characters so
// existing callers that just want the flat character array are unaffected.
// **The Relationships board, read whole.**
//
// Deliberately its own endpoint rather than one more key on
// GET /api/characters/:id. That payload is refetched by roughly twenty
// unrelated socket events — every Stamina tick among them — and a board carries
// base64 pictures for its board-local people. Folding it in would drag all of
// that along on every one of those refetches, for a tab most of them have
// nothing to do with.
async function getRelationshipBoard(ownerCharacterId) {
  const [people, nodes, edges] = await readMany([
    ['SELECT * FROM relationship_people WHERE owner_character_id = ? ORDER BY id', [ownerCharacterId]],
    ['SELECT * FROM relationship_nodes WHERE owner_character_id = ? ORDER BY id', [ownerCharacterId]],
    ['SELECT * FROM relationship_edges WHERE owner_character_id = ? ORDER BY id', [ownerCharacterId]],
  ]);
  return { people, nodes, edges };
}

// ---------------------------------------------------------------------------
// Undo — the last three states of a board
// ---------------------------------------------------------------------------
//
// **Whole snapshots, on the server, rather than inverse commands on the client.**
// An inverse works fine for a move or a colour, and falls apart on a delete:
// undoing one has to bring a row back with the SAME id, or every relationship
// that pointed at it now points at nothing. Re-inserting by id is something only
// the writer can do, so the writer is where undo lives — and it also means the
// GM and the owner, who edit the same board, share one history rather than
// holding two that disagree.
//
// Three deep, as asked. In memory only: an undo stack is a working convenience
// for the session you are in, not a record of the game, and one that survived a
// restart would let somebody reach back past a night's play.
//
// Keyed by owner, so one player's undo can never touch another's board.
const UNDO_DEPTH = 3;
const undoStacks = new Map(); // ownerCharacterId -> snapshot[] (oldest first)

// Take a snapshot of a board as it is RIGHT NOW. Called before a write, so the
// top of the stack is always the state to return to.
async function pushUndo(ownerCharacterId) {
  const id = Number(ownerCharacterId);
  if (!Number.isInteger(id)) return;
  const snapshot = await getRelationshipBoard(id);
  const stack = undoStacks.get(id) ?? [];
  stack.push(snapshot);
  // Oldest out first: three is the window the table asked for, and an unbounded
  // stack of boards carrying base64 portraits is a memory leak with a nice name.
  while (stack.length > UNDO_DEPTH) stack.shift();
  undoStacks.set(id, stack);
}

// Put a board back exactly as it was: clear the three tables for this owner and
// re-insert every row with its original id. Explicit column lists rather than a
// row spread, so a future column added to one of these tables fails loudly here
// instead of being silently dropped on the first undo.
async function restoreBoard(ownerCharacterId, snapshot) {
  const id = Number(ownerCharacterId);
  await run('DELETE FROM relationship_edges WHERE owner_character_id = ?', [id]);
  await run('DELETE FROM relationship_nodes WHERE owner_character_id = ?', [id]);
  await run('DELETE FROM relationship_people WHERE owner_character_id = ?', [id]);
  // People first, then nodes, then edges — the order the references run in, so
  // the database never sees a row pointing at one that is not back yet.
  for (const p of snapshot.people) {
    await run(
      `INSERT INTO relationship_people (id, owner_character_id, name, image_data, image_mime_type, created_at, crop_x, crop_y, crop_w, crop_h)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.id, id, p.name, p.image_data, p.image_mime_type, p.created_at, p.crop_x, p.crop_y, p.crop_w, p.crop_h]
    );
  }
  for (const n of snapshot.nodes) {
    await run(
      `INSERT INTO relationship_nodes (id, owner_character_id, character_id, person_id, x, y, nickname, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [n.id, id, n.character_id, n.person_id, n.x, n.y, n.nickname, n.notes, n.created_at]
    );
  }
  for (const e of snapshot.edges) {
    await run(
      `INSERT INTO relationship_edges (id, owner_character_id, from_node_id, from_side, from_x, from_y,
        to_node_id, to_side, to_x, to_y, label, color, arrow, retired, created_at, bend, bend_u)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.id, id, e.from_node_id, e.from_side, e.from_x, e.from_y, e.to_node_id, e.to_side, e.to_x, e.to_y,
        e.label, e.color, e.arrow, e.retired, e.created_at, e.bend, e.bend_u]
    );
  }
}

// How many steps back this board can go, so the client can grey its own control
// rather than firing into an empty stack to find out.
const undoDepthFor = (ownerCharacterId) => undoStacks.get(Number(ownerCharacterId))?.length ?? 0;

// Who may read or write one board: its owner, or the GM. The GM edits rather
// than merely watches (decided) — useful for setting a new player up with a
// starting web — so there is one predicate, not two.
function maySeeBoard(viewer, ownerCharacterId) {
  if (!viewer) return false;
  if (viewer.role === 'gm') return true;
  return viewer.role === 'player' && viewer.characterId === Number(ownerCharacterId);
}

// A private board must never cross the wire to another player, so this is a
// per-socket emit rather than an io.emit — the same shape refreshCapabilities
// uses, and for the same reason. The board is read ONCE regardless of how many
// sockets are entitled to it.
async function emitRelationships(ownerCharacterId) {
  const id = Number(ownerCharacterId);
  if (!Number.isInteger(id)) return;
  let payload = null;
  for (const socket of io.sockets.sockets.values()) {
    if (!maySeeBoard(socket.data?.identity, id)) continue;
    payload = payload ?? (await getRelationshipBoard(id));
    // `undoDepth` rides every board update so the client can grey its own Undo
    // rather than firing into an empty stack to find out it was empty.
    socket.emit('relationships:updated', { characterId: id, ...payload, undoDepth: undoDepthFor(id) });
  }
}

app.get('/api/characters/:id/relationships', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  if (!maySeeBoard(viewer, req.params.id)) return res.status(403).json({ error: 'not yours' });
  res.json(await getRelationshipBoard(Number(req.params.id)));
}));

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
  const [dice, inventory, injuries, stances, moves, roleplay, perks, counters, weapon] = await Promise.all([
    getDice(character.id),
    getInventory(character.id),
    getInjuries(character.id),
    getStances(character.id),
    getMovesFor(character.id),
    getRoleplay(character.id),
    getCharacterPerks(character.id),
    getCounters(character.id),
    // Null for almost everyone — a weapon is something a character acquires,
    // not something they are created with (see server/weapons.js).
    getWeapon(character.id),
  ]);
  // What this character could pick up, offered on an EMPTY slot only (Never
  // Empty-Handed). Resolved server-side and sent already filtered, so the slot
  // renders what it is given rather than deciding whether a charge is spent.
  const weaponOffers = weapon ? [] : await perkWeaponOffers(character.id);
  res.json({ character, dice, inventory, injuries, stances, moves, roleplay, perks, counters, weapon, weaponOffers });
}));

// The Gates on every Counter, as this viewer is allowed to know them. Its own
// endpoint rather than a key on the Counter payloads for the reason above: a
// Counter is public and a Gate need not be, and `GET /api/characters/:id` has
// no idea who is asking.
app.get('/api/counter-gates', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  // Unlike a board there is nothing to refuse — a Gate's EXISTENCE is public —
  // but an unidentified caller is treated as a Player, which is the closed
  // answer rather than the open one.
  res.json({ gates: visibleGates(await getAllGates(), viewer) });
}));

app.get('/api/tells', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM tells ORDER BY id'));
}));

app.get('/api/tags', wrap(async (_req, res) => {
  // Alphabetical, not creation order (decided, new). This list is a
  // vocabulary a GM adds to over months — by the twentieth Tag, "whichever I
  // happened to make first" is not an order anybody can find anything in.
  // COLLATE NOCASE so 'block' and 'Block' file together rather than in two
  // runs, which is the same case-insensitive treatment every Tag mechanic
  // already gives names.
  res.json(await all('SELECT * FROM tags ORDER BY name COLLATE NOCASE, id'));
}));

// Compendium view: folders + every move, with interactions, tags and grants
app.get('/api/moves', wrap(async (_req, res) => {
  // (sort_order, id) — the GM's custom drag order, with id breaking ties so a
  // library nobody has reordered yet (every sort_order still 0) comes back in
  // exactly the order it always did.
  const moves = await attachInteractions(await all('SELECT * FROM moves ORDER BY sort_order, id'));
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
  const [perks, grants, tagLinks] = await Promise.all([
    all('SELECT * FROM perks ORDER BY id'),
    all('SELECT * FROM character_perks'),
    all('SELECT * FROM perk_tag_links ORDER BY id'),
  ]);
  const grantedBy = new Map();
  for (const g of grants) {
    if (!grantedBy.has(g.perk_id)) grantedBy.set(g.perk_id, []);
    grantedBy.get(g.perk_id).push(g.character_id);
  }
  const tagsBy = new Map();
  for (const l of tagLinks) {
    if (!tagsBy.has(l.perk_id)) tagsBy.set(l.perk_id, []);
    tagsBy.get(l.perk_id).push(l.perk_tag_id);
  }
  res.json(
    perks.map((p) => ({
      ...p,
      granted_character_ids: grantedBy.get(p.id) ?? [],
      tag_ids: tagsBy.get(p.id) ?? [],
      automated: isAutomatedPerk(p.name),
      manual: isManualPerk(p.name),
    }))
  );
}));

// The Perk Tag vocabulary (see perk_tags in db.js — deliberately separate
// from the Move tag list at /api/tags).
app.get('/api/perk-tags', wrap(async (_req, res) => {
  res.json(await all('SELECT * FROM perk_tags ORDER BY id'));
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

// The player-facing rule book, served straight out of game_rules.md at the
// repo root (see the Rules mechanic in vttprojectplan.md for why it lives in
// a Markdown file rather than the database). Read per request rather than
// cached at boot so editing the file and refreshing is the whole authoring
// loop in development; the file is a few KB, and this is not a hot path.
app.get('/api/rules', wrap(async (_req, res) => {
  try {
    const markdown = await readFile(path.join(__dirname, '..', 'game_rules.md'), 'utf8');
    res.json({ markdown });
  } catch {
    // A missing rule book is a deployment problem, not a client error — say
    // so plainly instead of rendering an empty rules page that looks like
    // the game simply has no rules.
    res.status(404).json({ error: 'game_rules.md is missing from this deployment.' });
  }
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
// Combat Automation overhaul §3 — the stored replay behind a chat log's
// "Watch Round N between X and Y" button. Returns the same round_events
// rows the live cutscene was fed, in seq order, so RoundCutscene renders a
// replay and a live round through one code path (see §0: the client only
// ever plays back an event log it did not compute).
//
// Deliberately unrestricted (decision #11): by the time a round_summary
// card exists, that round is fully-resolved public history, watchable by
// anyone — including players who weren't in the fight.
app.get('/api/combat/round-replay/:resolutionId', wrap(async (req, res) => {
  const resolutionId = Number(req.params.resolutionId);
  if (!Number.isInteger(resolutionId)) return res.status(400).json({ error: 'bad resolutionId' });
  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE id = ?', [resolutionId]);
  if (!resolution) return res.status(404).json({ error: 'not found' });

  const [events, participants] = await Promise.all([
    all('SELECT seq, tic, type, payload, created_at FROM round_events WHERE resolution_id = ? ORDER BY seq', [
      resolutionId,
    ]),
    all(
      `SELECT cp.character_id AS characterId, cp.side AS side, ch.name AS name, ch.character_type AS characterType
       FROM combat_participants cp JOIN characters ch ON ch.id = cp.character_id
       WHERE cp.pair_index = ? ORDER BY cp.id`,
      [resolution.pair_index]
    ),
  ]);

  res.json({
    resolutionId,
    pairIndex: resolution.pair_index,
    roundNumber: resolution.round_number,
    roundStartTic: resolution.round_start_tic,
    roundLength: resolution.round_length,
    status: resolution.status,
    participants,
    events: events.map((e) => ({
      seq: e.seq,
      tic: e.tic,
      type: e.type,
      payload: JSON.parse(e.payload),
      timestamp: e.created_at,
    })),
  });
}));

app.get('/api/combat', wrap(async (req, res) => {
  const viewer = viewerFromQuery(req.query);
  let [state, participants, pairRows] = await Promise.all([
    one('SELECT * FROM combat_state WHERE id = 1'),
    allParticipants(),
    all('SELECT * FROM combat_pairs ORDER BY pair_index'),
  ]);

  // `initDb` seeds this row on every boot, so its absence means something ate
  // it — and every read below dereferences it, which would throw a TypeError
  // and leave the Arena (and nothing else in the app, since nothing else reads
  // combat_state) loading forever. Re-create it rather than 500: this is
  // precisely what initDb would do, the row carries no history worth mourning,
  // and a fight that has to be restarted beats an Arena nobody can open.
  if (!state) {
    console.error('combat_state row 1 was missing — re-creating it. A fight in progress is lost.');
    await run('INSERT OR IGNORE INTO combat_state (id, uneven_combat_enabled) VALUES (1, 0)');
    state = await one('SELECT * FROM combat_state WHERE id = 1');
  }

  const charIds = [...new Set(participants.map((p) => p.character_id))];
  const marks = charIds.map(() => '?').join(',');

  // Batched IN-clause lookups instead of a per-participant loop — this used
  // to be 3 sequential queries PER seated character (a real N+1 against
  // Turso's networked connection, and the main cause of "adding a
  // character takes ~4 seconds"); now it's 4 total (moves is naturally one
  // per character, getMovesFor's own shape), run concurrently regardless of
  // how many are seated.
  // **Everything that depends on nothing else, in one round trip.**
  //
  // This was already batched by IN-clause rather than looping per participant,
  // which is the right shape — but seven concurrent `all()` calls are still
  // seven requests, and `getMovesFor` sat inside the same group, so it could
  // not be handed the dice this query had just read. That is how one request
  // came to read the same character's dice three times: here in bulk, again
  // inside getMovesFor, and again inside resolveStaminaCosts.
  //
  // One batched read, then the per-character move lists with those dice passed
  // in. Two steps rather than one, but each is a single trip and the duplicate
  // reads are gone.
  // Nobody seated is a real state, and it is written out as its own branch
  // rather than as four conditionals inside the batch: readMany drops falsy
  // entries, so a `null` in the middle of the list would silently shift every
  // result after it onto the wrong name.
  const [charRows, diceRows, stanceRows, weaponRows, counters] = charIds.length
    ? await readMany([
        [`SELECT * FROM characters WHERE id IN (${marks})`, charIds],
        [`SELECT * FROM dice WHERE character_id IN (${marks}) ORDER BY id`, charIds],
        [`SELECT * FROM stances WHERE character_id IN (${marks}) ORDER BY id`, charIds],
        // Who is holding what. Being armed is a plain visible fact — you can see
        // what someone is carrying — and the Arena has to act on it: a Move whose
        // Roll names the Weapon is closed to anyone carrying nothing, greyed
        // exactly as a Movement move is greyed on a broken leg.
        [`SELECT * FROM weapons WHERE character_id IN (${marks})`, charIds],
        [
          `SELECT * FROM counters WHERE character_id IS NULL OR (show_in_combat = 1 AND character_id IN (${marks})) ORDER BY id`,
          charIds,
        ],
      ])
    : [[], [], [], [], await all('SELECT * FROM counters WHERE character_id IS NULL ORDER BY id')];

  // Dice grouped per character, so each getMovesFor below is handed the rows
  // this request is already holding instead of re-reading them.
  const diceByCharacter = new Map();
  for (const die of diceRows ?? []) {
    if (!diceByCharacter.has(die.character_id)) diceByCharacter.set(die.character_id, []);
    diceByCharacter.get(die.character_id).push(die);
  }

  const [movesByChar, declaredMoveRows, openResolutions, viewerSeesAttackHeight, viewerSeesFeints] =
    await Promise.all([
      Promise.all(charIds.map((id) => getMovesFor(id, { knownDice: diceByCharacter.get(id) ?? [] }))),
      fetchDeclaredMoveRows(),
      fetchOpenResolutionsByPair(),
      // Eye Catcher. This endpoint serves exactly ONE viewer, unlike the
      // broadcast, so only that viewer's own entitlement is worth asking about —
      // and it rides in the group above rather than after it, so it costs a slot
      // in a round trip already being made instead of a round trip of its own.
      viewer?.role === 'player' ? perkSeesAttackHeight(viewer.characterId) : false,
      // Never a Fool, on the same footing.
      viewer?.role === 'player' ? perkSeesFeints(viewer.characterId) : false,
    ]);
  const pairsByIndex = new Map(pairRows.map((row) => [row.pair_index, row]));
  const declaredMoves = mapDeclaredMovesForViewer(declaredMoveRows, pairsByIndex, viewer, {
    attackHeightViewers: viewerSeesAttackHeight ? new Set([viewer.characterId]) : null,
    pairIndexByCharacter: new Map(participants.map((p) => [p.character_id, p.pair_index])),
    feintViewers: viewerSeesFeints ? new Set([viewer.characterId]) : null,
    feintDeclaredMoveIds: viewerSeesFeints ? await feintDeclaredMoveIds(declaredMoveRows) : null,
  });

  const characters = {};
  for (const character of charRows) {
    characters[character.id] = { character: omitVitruvianArt(character), dice: [], stances: [], weapon: null };
  }
  for (const weapon of weaponRows) {
    if (characters[weapon.character_id]) characters[weapon.character_id].weapon = weapon;
  }
  for (const die of diceRows) characters[die.character_id]?.dice.push(die);
  for (const stance of stanceRows) characters[stance.character_id]?.stances.push(stance);
  charIds.forEach((id, i) => {
    if (characters[id]) characters[id].moves = movesByChar[i];
  });

  res.json({
    unevenCombatEnabled: Boolean(state.uneven_combat_enabled),
    freshStart: Boolean(state.fresh_start),
    roundLength: state.round_length,
    // pendingGrapple is folded in here as well as in the socket emit, and for
    // the same reason it exists at all: this REST snapshot is what a fresh
    // page load (or a reload mid-prompt) builds its state from, and
    // combat:updated only fires on the *next* event. Without it a fighter who
    // reloaded while the cross was up would sit there with no prompt until
    // something unrelated happened.
    pairs: pairRows.map((row) => ({
      ...shapePair(row, state.round_length, openResolutions.get(row.pair_index), viewer),
      pendingGrapple: mapPendingGrappleForViewer(openResolutions.get(row.pair_index), viewer, participants),
    })),
    participants,
    characters,
    counters,
    declaredMoves,
    stanceMatchups: await fetchPairStanceMatchups(),
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

  // Dice seed at d4 — the ruleset's own starting baseline (see Character
  // Creation in game_rules.md): every Stat starts at d4 and the character
  // spends a budget of step-ups from there, using the sheet's existing
  // step controls. Max Stamina follows from the seeded Stamina die.
  const maxStamina = computeMaxStamina(4, 4, 0);
  const result = await run(
    'INSERT INTO characters (name, character_type, max_stamina, current_stamina, folder_id) VALUES (?, ?, ?, ?, ?)',
    [name, characterType, maxStamina, maxStamina, folderId]
  );
  const id = Number(result.lastInsertRowid);

  // The eight Stat dice in one round trip rather than eight. They were written
  // one at a time in a `for await` loop, which is the most sequential shape
  // there is — and creating a character is the first thing anyone does.
  await writeMany(
    DICE_TEMPLATE.map((t) => [
      'INSERT INTO dice (character_id, pool, slot_name) VALUES (?, ?, ?)',
      [id, t.pool, t.slot_name],
    ])
  );

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
    sets.push('image_data = ?', 'image_mime_type = ?', CROP_COLUMNS);
    args.push(String(req.body.imageData), String(req.body.imageMimeType ?? 'image/jpeg'), ...cropValues(req.body));
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

// **A player's memory outlives the GM's roster (decided).**
//
// When a character is deleted, every Relationships node on somebody ELSE's
// board that pointed at them would be left dangling. Rather than dropping those
// nodes — which would silently destroy part of a player's map because the GM
// tidied up — each one converts into a board-local person on the board it
// already sits on, carrying the last-known name and picture across. Position,
// Nickname, Notes and (from Phase 3) every relationship are untouched: to that
// board, nothing happened except that this person stopped being someone the
// GM tracks.
//
// Runs BEFORE the character row goes, so the name and picture are still there
// to copy, and before the deleted character's own board rows are cleared.
// One person per board, not per node: two placements of the same NPC on one
// board are two views of one person and must not become two people.
async function convertRelationshipNodesToPeople(character) {
  const nodes = await all(
    'SELECT * FROM relationship_nodes WHERE character_id = ?',
    [character.id]
  );
  if (!nodes.length) return;
  const boards = [...new Set(nodes.map((n) => n.owner_character_id))];
  for (const ownerCharacterId of boards) {
    // The owner's own board is about to be deleted wholesale below, so there is
    // nothing worth converting there.
    if (ownerCharacterId === character.id) continue;
    const inserted = await run(
      `INSERT INTO relationship_people (owner_character_id, name, image_data, image_mime_type)
       VALUES (?, ?, ?, ?)`,
      [ownerCharacterId, character.name, character.image_data ?? null, character.image_mime_type ?? null]
    );
    await run(
      `UPDATE relationship_nodes SET person_id = ?, character_id = NULL
       WHERE character_id = ? AND owner_character_id = ?`,
      [Number(inserted.lastInsertRowid), character.id, ownerCharacterId]
    );
    await emitRelationships(ownerCharacterId);
  }
}

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
  await convertRelationshipNodesToPeople(character);
  await run('DELETE FROM relationship_edges WHERE owner_character_id = ?', [character.id]);
  await run('DELETE FROM relationship_nodes WHERE owner_character_id = ?', [character.id]);
  await run('DELETE FROM relationship_people WHERE owner_character_id = ?', [character.id]);
  await run('DELETE FROM character_move_tags WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_move_overrides WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_move_roll_bonuses WHERE character_id = ?', [character.id]);
  await run('DELETE FROM character_perks WHERE character_id = ?', [character.id]);
  // Both columns: a credit this character was owed, and one they left with
  // somebody else. Spelled out rather than trusted to the DDL, like every other
  // line here — and the second half matters, since a row naming a character who
  // no longer exists would sit in the table forever, never matchable and never
  // cleared.
  await run('DELETE FROM temporary_damage WHERE character_id = ?', [character.id]);
  await run('DELETE FROM pending_roll_bonuses WHERE character_id = ? OR against_character_id = ?', [
    character.id,
    character.id,
  ]);
  // Their Counters' Gates go first — spelled out for the same reason every
  // other line in this cascade is, rather than trusting the DDL's ON DELETE.
  await run(
    'DELETE FROM counter_gates WHERE counter_id IN (SELECT id FROM counters WHERE character_id = ?)',
    [character.id]
  );
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

// **How much of the log a page load fetches (decided, new — Phase 4 of the
// round-trip work).**
//
// This used to be the whole thing, every time, with no bound at all — and
// `chat_log` is where pasted images live, base64 in `image_data`, so a session
// with a dozen shared pictures made every reload and every reconnect drag
// several megabytes across the wire before the Chat tab could paint. It is one
// query either way, so this is not about round trips; it is about the size of
// the answer.
//
// Deliberately generous, and deliberately the *tail*: 300 entries is far more
// than a fight produces, the GM clears the log between fights anyway
// (`chat:cleared`), and live entries arrive over the socket regardless of this
// number. The cost is that scrollback older than 300 entries does not come
// back after a reload — nothing in the UI pages further back, so an unbounded
// fetch was only ever serving the part of the log nobody scrolled to.
const CHAT_HISTORY_LIMIT = 300;

app.get('/api/chat', wrap(async (_req, res) => {
  const rows = await all(`
    SELECT c.id, c.kind, c.character_id, c.modifier, c.dice_rolled, c.content,
           c.image_data, c.image_mime_type, c.payload, c.created_at,
           ch.name AS character_name,
           m.id AS move_id, m.name AS move_name, m.image_data AS move_image_data,
           m.image_mime_type AS move_image_mime_type, m.startup_tics AS move_startup_tics,
           m.active_tics AS move_active_tics, m.recovery_tics AS move_recovery_tics,
           m.defense_frame_positions AS move_defense_frame_positions,
           m.stamina_cost AS move_stamina_cost
    FROM (SELECT * FROM chat_log ORDER BY id DESC LIMIT ${CHAT_HISTORY_LIMIT}) c
    LEFT JOIN characters ch ON ch.id = c.character_id
    LEFT JOIN moves m ON m.id = c.move_id
    ORDER BY c.id
  `);
  // **`full` is deliberately NOT attached here any more (decided, revised).**
  // It used to be: every move_reveal row's whole move — Roll, Tags, Stamina
  // Cost, On Hit effects — was fetched and sent to every client, and the
  // Genius Observer gate was only the expand button being disabled. That is
  // the same honour-system weakness the server-side capability check was
  // built to replace, just wearing a different coat: anybody with devtools
  // could read the payload. The gated half is now served on request, per
  // socket, by `move:request_detail` below — see the reveal card's own
  // comment there. This also stops a long chat log re-fetching every revealed
  // move in full on every page load.
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
        // Same rule as logRoll's own broadcast: a die's stored `result` is
        // face + its own bonus, and the shared modifier is applied once here.
        // (Rows written before that change baked the modifier into every die
        // and would double-count — chat is wiped on every server restart, so
        // a deploy leaves none of them behind.)
        total: rollTotal(dice, row.modifier),
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
                defenseFramePositions: JSON.parse(row.move_defense_frame_positions ?? '[]'),
                // Stamina Cost is public here because it is already public
                // elsewhere: mapDeclaredMovesForViewer sends it to everyone
                // the moment a move is `publiclyRevealed`, so withholding it
                // on this card would be theatre. The **description** is not —
                // reading what a move actually does is the thing the Perk
                // buys — so it rides `full` with everything else.
                staminaCost: row.move_stamina_cost,
              }
          : undefined,
        // Historical lane_snapshot rows (the per-reveal card this overhaul
        // replaced) carry their whole snapshot as JSON, self-contained at
        // write time — nothing writes new ones any more, but a live chat log
        // from before the cutover still renders.
        // round_summary rows (Combat Automation overhaul §1.5) spread the
        // same way — a tiny self-contained payload (pairIndex, roundNumber,
        // resolutionId, the two sides' names) that the chat card renders as
        // one "Watch Round N" button; the round's actual events are fetched
        // from the replay endpoint by resolutionId, never inlined here.
        ...((row.kind === 'lane_snapshot' || row.kind === 'round_summary') && row.payload
          ? JSON.parse(row.payload)
          : {}),
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
  // A client joining while the push to the primary is already failing has to
  // find out now, not at the next state change — the alarm exists precisely
  // for the case where nothing else is happening. Only sent when there is
  // something to say; a healthy sync is silent.
  const health = syncHealth();
  if (!health.healthy) socket.emit('db:sync_health', health);

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
      socket.emit('identity:capabilities', await capabilitiesFor(socket.data.identity));
      await emitCombatUpdatedTo(socket);
      return;
    }
    const id = Number(characterId);
    if (role === 'player' && Number.isInteger(id)) {
      const character = await one('SELECT id FROM characters WHERE id = ?', [id]);
      socket.data.identity = character ? { role: 'player', characterId: character.id } : null;
    }
    socket.emit('identity:capabilities', await capabilitiesFor(socket.data.identity));
    // **Answer every identity with a fresh snapshot (bugfix).** Identity is
    // re-sent on every reconnect, which makes this the one moment the server
    // reliably hears "someone is back". It matters because a *paused* pair
    // emits nothing further on its own: a GM whose phone locked while a Dodge
    // or Block prompt went out used to come back to a silent screen and a fight
    // that could not be advanced by anyone. Now reconnecting is the resync.
    await emitCombatUpdatedTo(socket);
  });

  // **The gated half of a move-reveal chat card (decided, new).** The card
  // itself carries name, picture, frame data and Stamina Cost to everyone —
  // all of it already public on `combat:updated` the moment the move reveals.
  // Everything else about the move is what the **Genius Observer** Perk buys,
  // and it is served here, per socket, rather than attached to GET /api/chat
  // for every viewer alike (which is what it used to do, leaving the gate as
  // nothing but a disabled button over a payload anybody could read).
  //
  // Two checks, both necessary:
  //
  //  1. **Does this socket's identity qualify?** `capabilitiesFor` — the same
  //     answer the client was already given for whether to offer the button,
  //     re-asked here because the button is a courtesy and this is the gate.
  //  2. **Has this move actually been revealed in the log?** The Perk reads a
  //     *publicly revealed* move; without this an entitled Player could ask
  //     for any move id in the world and read the GM's unrevealed library.
  //     A `move_reveal` row existing for it is exactly "it came out in front
  //     of everyone", since that is the only thing that writes one.
  //
  // Answers on the requesting socket alone, and answers even when refused, so
  // a client waiting on it never hangs.
  on('move:request_detail', async ({ moveId } = {}) => {
    const id = Number(moveId);
    if (!Number.isInteger(id)) return;
    const { canSeeRevealedDetail } = await capabilitiesFor(socket.data.identity);
    if (!canSeeRevealedDetail) {
      socket.emit('move:detail', { moveId: id, move: null, reason: 'perk' });
      return;
    }
    const revealed = await one(
      "SELECT 1 AS ok FROM chat_log WHERE kind = 'move_reveal' AND move_id = ? LIMIT 1",
      [id]
    );
    if (!revealed) {
      socket.emit('move:detail', { moveId: id, move: null, reason: 'not_revealed' });
      return;
    }
    const [move] = await attachInteractions(await all('SELECT * FROM moves WHERE id = ?', [id]));
    socket.emit('move:detail', { moveId: id, move: move ?? null, reason: move ? null : 'deleted' });
  });

  on('die:roll', async ({ characterId, dieId, modifier }) => {
    const die = await one('SELECT * FROM dice WHERE id = ? AND character_id = ?', [
      dieId,
      characterId,
    ]);
    if (!die || die.status !== 'active') return;
    const character = await getCharacter(die.character_id);
    if (!character) return;
    const mod = clampModifier(modifier) + (await getCombatRollBonus(character.id, { slotNames: [die.slot_name] }));
    // Face + the die's OWN bonus. The shared modifier is applied once to the
    // roll, not to each die — see rollTotal in gameLogic.js. On a single-die
    // roll that is the same number either way; it is done here too so every
    // roll payload in the app has one shape for the client to read.
    const result = rollDie(die.current_size) + die.bonus;
    await logRoll(io, {
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      dice: [{ slot_name: die.slot_name, size: die.current_size, bonus: die.bonus, result }],
    });
  });

  // ---------------------------------------------------------------------
  // The Weapon (decided, new — see server/weapons.js)
  // ---------------------------------------------------------------------
  //
  // A character carries one weapon or none, and none is the default. These
  // three events are the whole player-facing surface; the mechanics live in
  // weapons.js and the engine, and a Perk arming its holder calls the SAME
  // `grantWeapon` these do rather than writing its own row.
  //
  // No ownership check, matching every other sheet edit in this app — the
  // trust-based no-login model is a decided constraint, not an oversight.
  on('weapon:create', async ({ characterId, name, dieSize, bonus, durability }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    const weapon = await grantWeapon(io, character.id, { name, dieSize, bonus, durability });
    if (!weapon) return;
    await postSystemMessage(io, `${character.name} takes up the ${weapon.name}.`);
  });

  // **Taking a weapon a Perk offered (Never Empty-Handed).** The Perk says what
  // it is willing to offer; this is what actually arms anybody, through the
  // same `grantWeapon` seam every other weapon in the game comes through.
  //
  // Everything is re-derived from the character's own granted Perks — the
  // client sends a name and nothing else — so a hand-sent event cannot conjure
  // a weapon, spend a charge twice, or invent a die size.
  // **Answering the Non-Committed window.** Ownership is checked here rather
  // than trusted: the resolver only cancels ids the stored prompt offered, and
  // this refuses a socket that does not control any of the fighters it names.
  on('combat:resolve_noncommit', async ({ pairIndex, declaredMoveIds }) => {
    const identity = socket.data.identity;
    if (!identity) return;
    const index = Number(pairIndex);
    if (!Number.isInteger(index)) return;
    const resolution = await one(
      `SELECT pending_noncommit_json FROM pair_round_resolutions
       WHERE pair_index = ? AND status = 'paused_noncommit'`,
      [index]
    );
    if (!resolution) return;
    const pending = parsePausePayload(resolution.pending_noncommit_json, 'Non-Committed', index);
    const mine = nonCommitForViewer(pending, identity);
    if (!mine) return;
    // Only ids from THIS viewer's own entries — a Player answering cannot
    // cancel the NPC's moves in the same prompt, and vice versa.
    const ownIds = new Set(mine.entries.flatMap((e) => e.moves.map((m) => m.declaredMoveId)));
    const chosen = (declaredMoveIds ?? []).map(Number).filter((id) => ownIds.has(id));
    await resolveNonCommit(index, { declaredMoveIds: chosen }, io);
  });

  on('weapon:take_offer', async ({ characterId, perkName }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    // Refused outright rather than replacing what they are holding: this is
    // finding something on the floor, not swapping kit.
    if (await getWeapon(character.id)) return;
    const offer = await takeWeaponOffer(character.id, String(perkName ?? ''));
    if (!offer) return;
    const weapon = await grantWeapon(io, character.id, {
      name: offer.name,
      dieSize: offer.dieSize,
      bonus: offer.bonus ?? 0,
      durability: offer.durability,
    });
    // Announced, because the table needs to know where a weapon came from —
    // a fighter who was unarmed a moment ago now is not.
    if (weapon) {
      await postSystemMessage(
        io,
        `${character.name} finds something to fight with — ${offer.name} (d${offer.dieSize}, ${offer.durability} Durability), from ${offer.perkName}.`
      );
    }
  });

  on('weapon:delete', async ({ characterId }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    const weapon = await getWeapon(character.id);
    if (!(await removeWeapon(io, character.id))) return;
    await postSystemMessage(io, `${character.name} puts down the ${weapon.name}.`);
  });

  // **Rolling the weapon costs nothing (decided).** This is the sheet's own die
  // widget and a GM's roll request — a check, a flourish, a contest. Durability
  // is spent by USING the weapon in a Move, which happens in the engine
  // (spendWeaponForDeclaredMove), never here.
  on('weapon:roll', async ({ characterId, modifier }) => {
    const [character, weapon] = await Promise.all([getCharacter(characterId), getWeapon(characterId)]);
    if (!character || !weapon) return;
    const die = weaponDie(weapon);
    const mod = clampModifier(modifier) + (await getCombatRollBonus(character.id, { slotNames: [WEAPON_SLOT] }));
    await logRoll(io, {
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      // Same die shape every other roll payload uses, so the chat card renders
      // it without knowing a weapon from a Stat.
      dice: [
        {
          slot_name: WEAPON_SLOT,
          size: die.current_size,
          bonus: die.bonus,
          result: rollDie(die.current_size) + die.bonus,
        },
      ],
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
    const mod =
      clampModifier(modifier) +
      (asGm ? 0 : await getCombatRollBonus(character.id, { moveId: await moveIdOfDeclared(declaredMoveId), declaredMoveId }));
    const result = rollDie(die); // the modifier lands on the total — see die:roll above
    const rollContext = asGm ? null : await buildRollContext(character.id, declaredMoveId);
    await logRoll(io, {
      characterId: asGm ? GM_CHAT_SENTINEL_ID : character.id,
      characterName: asGm ? 'GM' : character.name,
      modifier: mod,
      dice: [{ slot_name: 'Custom', size: die, bonus: 0, result }],
      rollContext,
    });
  });

  // Selection-based pool roll: any set of the character's dice, rolled
  // together with one shared modifier (not tied to a body section).
  // `declaredMoveId` (Combat Automation, sub-phase 3, optional) — see
  // dice:roll_custom's identical comment just above.
  //
  // `includeWeapon` (decided, new): the Weapon is not a die row, so it cannot
  // ride in `dieIds` with the rest. A Move whose Roll names it sends this flag
  // instead and the weapon joins the pool here. Rolling costs no Durability —
  // that is what USING it in a Move costs, and this is not one (see
  // server/weapons.js).
  on('pool:roll', async ({ characterId, dieIds, modifier, declaredMoveId, rollRequestId = null, includeWeapon = false }) => {
    const character = await getCharacter(characterId);
    if (!character || !Array.isArray(dieIds)) return;
    const ids = [...new Set(dieIds.map(Number).filter(Number.isInteger))];
    if (!ids.length && !includeWeapon) return;
    const [statDice, armed] = await Promise.all([
      ids.length
        ? all(
            `SELECT * FROM dice WHERE character_id = ? AND status = 'active' AND id IN (${ids
              .map(() => '?')
              .join(',')}) ORDER BY id`,
            [character.id, ...ids]
          )
        : [],
      includeWeapon ? getWeapon(character.id) : null,
    ]);
    const weaponInPool = weaponDie(armed);
    const dice = weaponInPool ? [...statDice, weaponInPool] : statDice;
    if (!dice.length) return;
    const mod =
      clampModifier(modifier) +
      (await getCombatRollBonus(character.id, {
        moveId: await moveIdOfDeclared(declaredMoveId),
        declaredMoveId,
        slotNames: dice.map((d) => d.slot_name),
      }));
    // **One modifier, applied once (decided, fix).** This used to add `mod` to
    // every die, so a three-Stat pool at +3 collected +9 — see rollTotal in
    // gameLogic.js for why that is not what any modifier in this game means.
    const rolledDice = dice.map((d) => ({
      slot_name: d.slot_name,
      size: d.current_size,
      bonus: d.bonus,
      result: rollDie(d.current_size) + d.bonus,
    }));
    const rollContext = await buildRollContext(character.id, declaredMoveId);
    await logRoll(io, {
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      dice: rolledDice,
      rollContext,
    });
    const total = rollTotal(rolledDice, mod);
    // Out-of-combat checks resolve themselves (decided, new). If this roll
    // is answering a Roll Request the GM gave a target number, the server —
    // which is the only side that ever knew the number — compares and posts
    // the verdict, instead of the GM eyeballing the total against a number
    // they are holding in their head.
    const pendingCheck = rollRequestId ? pendingRollChecks.get(rollRequestId) : null;
    if (pendingCheck && pendingCheck.characterId === character.id) {
      pendingRollChecks.delete(rollRequestId);
      const passed = total >= pendingCheck.target;
      await postSystemMessage(io, 
        `${character.name}'s ${pendingCheck.slotName} check — ${total} vs ${pendingCheck.target}: ${
          passed ? 'PASS' : 'FAIL'
        }.`
      );
    }
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
  // by interactions_resolved so a Partial Block's own reduced damage doesn't
  // also fire 'hit' on top of the 'block' trigger already fired for it.
  // Combat Automation overhaul: in-combat damage is applied by the engine
  // now; this event survives only for genuinely ad-hoc/manual GM damage
  // outside the automated flow (environmental damage, a house rule).
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
      await postSystemMessage(io, `${character.name} took ${steps * 0.5} damage to ${die.slot_name}.`);
    }

    if (attackerDeclaredMoveId != null) {
      const attackerDM = await one(
        'SELECT move_id, character_id, interactions_resolved FROM declared_moves WHERE id = ?',
        [attackerDeclaredMoveId]
      );
      if (attackerDM && !attackerDM.interactions_resolved) {
        await run('UPDATE declared_moves SET interactions_resolved = 1 WHERE id = ?', [attackerDeclaredMoveId]);
        await applyMoveInteractions(io, {
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
    // **half_damage is cleared too (bugfix).** It is not a size, it is *half a
    // step of damage already taken and waiting for its other half* (see
    // applyHalfDamage in gameLogic.js) — so a Stat put back to its base while
    // still flagged is a Stat that reads as undamaged and takes its next hit
    // twice as hard. Reported as "revert stats to base does not heal half
    // damage". The locked baseline has no half_damage of its own by
    // construction: a base value is a whole value, so reverting always clears
    // it rather than restoring some remembered flag.
    await Promise.all(
      reverted.map(({ die, next }) =>
        run('UPDATE dice SET current_size = ?, bonus = ?, status = ?, half_damage = 0 WHERE id = ?', [
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
        diePayload({
          ...die,
          current_size: next.size,
          bonus: next.bonus,
          status: next.status,
          half_damage: 0,
        })
      );
    }
  });


  // **Character Creation (decided, new)** — one event that applies a whole
  // guided build at once, rather than the wizard replaying two dozen
  // die:step/stance:create/move:grant calls from the client.
  //
  // Why it is one event: the point budget is a RULE. Spending it a step at a
  // time over the existing per-action events would leave the only enforcement
  // in the dialog, and a dialog cannot enforce anything — it is the client.
  // Validating the whole draft here, through the same pure module the wizard
  // reads (server/characterCreation.js), is what makes "16 points" mean
  // something.
  //
  // Applied in the order the flow asks for them, and **idempotent where it can
  // be**: Stats are SET from their bought rank rather than stepped, so
  // re-running the flow re-states a spread instead of stacking on top of one.
  // Grants are additive but per-row unique, so re-granting is a no-op.
  on('character:apply_creation', async (payload = {}) => {
    const character = await getCharacter(payload.characterId);
    if (!character) return;

    const [moves, perks, attributes, ownedStances] = await Promise.all([
      all('SELECT id, name, style_attribute_id FROM moves'),
      all('SELECT id FROM perks'),
      all('SELECT id FROM attributes'),
      all('SELECT attribute_a_id, attribute_b_id FROM stances WHERE character_id = ?', [character.id]),
    ]);
    // **The Styles this character will have when the Moves are granted** — the
    // stances they already stand in, plus the one this draft is about to
    // create. That union is exactly what `characterHasStyle` will test against
    // a few lines below, so the validator refuses precisely the Moves the grant
    // loop would have dropped, and no others. Computing it from the new stance
    // alone would refuse a Move the character was always going to be able to
    // learn.
    const ownedStyleIds = [
      ...ownedStances.flatMap((s) => [s.attribute_a_id, s.attribute_b_id]),
      payload?.stance?.attributeAId,
      payload?.stance?.attributeBId,
    ].filter((id) => Number.isInteger(Number(id)));
    const result = validateCreation({
      ...payload,
      validMoveIds: moves.map((m) => m.id),
      validPerkIds: perks.map((p) => p.id),
      validAttributeIds: attributes.map((a) => a.id),
      moveStyles: Object.fromEntries(moves.map((m) => [m.id, m.style_attribute_id])),
      moveNames: Object.fromEntries(moves.map((m) => [m.id, m.name])),
      ownedStyleIds,
    });
    if (!result.ok) {
      // Answered to the caller alone, not broadcast: a rejected draft is that
      // one person's problem, and the wizard shows the same list inline.
      //
      // **Only genuine errors reach here.** Going over a preset's suggested
      // Stat points is a warning, not a refusal — see validateCreation — while
      // the Perk and Move counts, a Move whose Style the character will not
      // have, and a structurally broken stance all block.
      socket.emit('character:creation_rejected', {
        characterId: character.id,
        errors: result.errors,
      });
      return;
    }
    const { preset, ranks, stance, moveIds, perkIds, roleplay } = result.normalized;

    // ---- Stats: set, not stepped ----
    const dice = await getDice(character.id);
    for (const die of dice) {
      const { size, bonus } = dieAtRank(ranks[die.slot_name] ?? 0);
      if (die.current_size === size && die.bonus === bonus && die.status === 'active') continue;
      await run('UPDATE dice SET current_size = ?, bonus = ?, status = ?, half_damage = 0 WHERE id = ?', [
        size,
        bonus,
        'active',
        die.id,
      ]);
      io.emit('die:updated', diePayload({ ...die, current_size: size, bonus, status: 'active', half_damage: 0 }));
    }

    // ---- Stance ----
    if (stance) {
      const created = await run(
        'INSERT INTO stances (character_id, name, attribute_a_id, attribute_b_id) VALUES (?, ?, ?, ?)',
        [character.id, stance.name, stance.attributeAId, stance.attributeBId]
      );
      const row = await one('SELECT * FROM stances WHERE id = ?', [Number(created.lastInsertRowid)]);
      io.emit('stance:created', row);
      // A character built through this flow ends it standing in the stance
      // they just made — the same auto-activate rule stance:create uses for a
      // first stance, applied here whether or not it is their first.
      await run('UPDATE characters SET active_stance_id = ? WHERE id = ?', [row.id, character.id]);
      io.emit('stance:activated', { characterId: character.id, stanceId: row.id });
    }

    // ---- Moves ----
    // **Learnability still applies here (bugfix caught while building this).**
    // move:grant refuses a styled move to a character with no stance carrying
    // that style, and creation must not be a way around it — a flow that
    // handed out any move in the book would make the rule optional. The stance
    // is created above precisely so a move picked in the same sitting can be
    // checked against the stance bought a step earlier.
    const skippedMoves = [];
    for (const moveId of moveIds) {
      const move = await one('SELECT id, name, style_attribute_id FROM moves WHERE id = ?', [moveId]);
      if (!move) continue;
      if (move.style_attribute_id != null && !(await characterHasStyle(character.id, move.style_attribute_id))) {
        skippedMoves.push(move.name);
        continue;
      }
      // Special, for the same reason learnability is checked here: creation
      // must not be a way around a rule the Compendium enforces. It is already
      // filtered out of the picker, so reaching this means a stale view or a
      // hand-sent event — reported in `skippedMoves` rather than dropped
      // silently, exactly as an unlearnable style is.
      if (socket.data.identity?.role !== 'gm' && (await isSpecialMove(move.id))) {
        skippedMoves.push(move.name);
        continue;
      }
      const existing = await one('SELECT id FROM character_moves WHERE character_id = ? AND move_id = ?', [
        character.id,
        moveId,
      ]);
      if (existing) continue;
      await run('INSERT INTO character_moves (character_id, move_id) VALUES (?, ?)', [character.id, moveId]);
      io.emit('move:granted', { characterId: character.id, moveId });
    }

    // ---- Perks ----
    // Routed through the same registry hook perk:grant uses, so a Perk with an
    // onGrant behaves identically however it was handed out.
    for (const perkId of perkIds) {
      // Special is the GM's to hand out — see isSpecialPerk. Already filtered
      // out of the picker; this is the hand-sent-event case.
      if (socket.data.identity?.role !== 'gm' && (await isSpecialPerk(perkId))) continue;
      const existing = await one('SELECT id FROM character_perks WHERE character_id = ? AND perk_id = ?', [
        character.id,
        perkId,
      ]);
      if (existing) continue;
      const granted = await run('INSERT INTO character_perks (character_id, perk_id) VALUES (?, ?)', [
        character.id,
        perkId,
      ]);
      const perk = await one('SELECT name FROM perks WHERE id = ?', [perkId]);
      await perkDefinition(perk?.name)?.onGrant?.({
        characterId: character.id,
        perkId,
        characterPerkId: Number(granted.lastInsertRowid),
        io,
      });
      io.emit('perk:granted', { characterId: character.id, perkId });
    }
    if (perkIds.length) await refreshCapabilities(character.id);

    // ---- Role-play ----
    for (const { question, answer } of roleplay) {
      const existing = await one(
        'SELECT id FROM roleplay_entries WHERE character_id = ? AND question = ? AND is_custom = 0',
        [character.id, question]
      );
      if (existing) await run('UPDATE roleplay_entries SET answer = ? WHERE id = ?', [answer, existing.id]);
      else
        await run(
          'INSERT INTO roleplay_entries (character_id, question, answer, is_custom) VALUES (?, ?, ?, 0)',
          [character.id, question, answer]
        );
    }
    if (roleplay.length) await emitRoleplay(character.id);

    // ---- Lock ----
    // **Last, and not optional.** Locking is what turns the spread just bought
    // into this character's baseline — it writes locked_size/bonus/status and
    // recomputes Max Stamina from the Stamina die. A character who finished
    // creation without it would have no baseline to revert to and a Max
    // Stamina from whatever they were before.
    const lockedDice = await getDice(character.id);
    const staminaDie = lockedDice.find((d) => d.slot_name === 'Stamina');
    const maxStamina = computeMaxStamina(
      character.stamina_multiplier,
      staminaDie.current_size,
      staminaDie.bonus
    );
    await Promise.all([
      run(
        'UPDATE dice SET locked_size = current_size, locked_bonus = bonus, locked_status = status WHERE character_id = ?',
        [character.id]
      ),
      run('UPDATE characters SET max_stamina = ?, current_stamina = ? WHERE id = ?', [
        maxStamina,
        maxStamina,
        character.id,
      ]),
    ]);
    for (const die of lockedDice) {
      io.emit(
        'die:updated',
        diePayload({ ...die, locked_size: die.current_size, locked_bonus: die.bonus, locked_status: die.status })
      );
    }
    io.emit('character:updated', {
      ...(await getCharacter(character.id)),
    });
    await postSystemMessage(
      io,
      preset
        ? `${character.name} is ready to fight — built as ${preset.name}.`
        : `${character.name} is ready to fight — built freehand.`
    );
    // A build that went past its preset's suggestion is announced rather than
    // hidden: the numbers are guidance, and the table is who decides whether a
    // heavier fighter is fine. Nobody should have to notice it themselves.
    for (const warning of result.warnings) {
      await postSystemMessage(io, `${character.name}: ${warning}`);
    }
    // Said out loud rather than silently dropped: a move that did not stick is
    // exactly the thing somebody would otherwise notice three sessions later.
    if (skippedMoves.length) {
      await postSystemMessage(
        io,
        `${character.name} could not learn ${skippedMoves.join(', ')} — those Moves need a stance with their Style.`
      );
    }
    socket.emit('character:creation_applied', {
      characterId: character.id,
      presetKey: preset?.key ?? null,
      warnings: result.warnings,
      skippedMoves,
    });
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
    await logRoll(io, {
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

  on('tell:create', async (payload) => {
    const { name, imageData, imageMimeType } = payload;
    const tellName = String(name ?? '').trim();
    if (!tellName) return;
    const result = await run(
      'INSERT INTO tells (name, image_data, image_mime_type, crop_x, crop_y, crop_w, crop_h) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tellName, imageData ?? null, imageData ? (imageMimeType ?? 'image/png') : null, ...cropValues(payload)]
    );
    io.emit('tell:created', await one('SELECT * FROM tells WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  on('tell:update', async (payload) => {
    const { tellId, name, imageData, imageMimeType } = payload;
    const tell = await one('SELECT * FROM tells WHERE id = ?', [tellId]);
    const tellName = String(name ?? '').trim();
    if (!tell || !tellName) return;
    // image only replaced when a new one is provided — and its crop goes with
    // it, since a crop describes one particular picture.
    if (imageData !== undefined) {
      await run(`UPDATE tells SET name = ?, image_data = ?, image_mime_type = ?, ${CROP_COLUMNS} WHERE id = ?`, [
        tellName,
        imageData,
        imageMimeType ?? 'image/png',
        ...cropValues(payload),
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
      startup + active + recovery,
      { startupTics: startup, activeTics: active }
    );
    const staminaCost = clampStaminaCost(payload.staminaCost);
    const isDefault = payload.isDefault ? 1 : 0;
    const isDefensive = payload.isDefensive ? 1 : 0;
    const isGrappling = payload.isGrappling ? 1 : 0;
    // Secondary (decided, new): granted and readable like any move, but never
    // declared off the picker by hand — see declarableByHand in moveLogic.js
    // for the whole rule and why it is one flag rather than two routes.
    const isSecondary = payload.isSecondary ? 1 : 0;
    const defenseKind = sanitizeDefenseKind(
      payload.defenseKind,
      Boolean(isDefensive),
      defenseFramePositions.length > 0
    );
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
    // Two extra Rolls, each gated on the toggle that gives it meaning and
    // cleared when that toggle goes off — the same shape normalizeInteractions
    // already uses for the defence triggers.
    //
    // **Resist Roll** (Grappling): what the *target* throws to contest a grab.
    // Empty is legal and means they cannot contest at all, so the grapple only
    // has to clear its Success Threshold — "a grab you can only fumble, never
    // muscle out of" is a real authoring choice, not a mistake to validate.
    //
    // **Defensive Roll**: the extra pool a Block/Dodge adds on top of its base
    // Roll. The table and the engine's read of it have existed since sub-phase
    // 2 (roundResolution.js's `defensiveSlotRows`); this is the first code that
    // ever *writes* it, so until now every defensive roll resolved with an
    // empty extra pool no matter what the design said.
    const resistRollSlots = isGrappling ? sanitizeRollSlots(payload.resistRollSlots) : [];
    const defensiveRollSlots = isDefensive ? sanitizeRollSlots(payload.defensiveRollSlots) : [];
    // Never ambiguous-Tell-forming: the Tell is about what the *opponent* sees
    // coming, and neither of these is thrown by the person showing the Tell at
    // the moment it is shown. Only the base Roll can raise that question.
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

    // Combat Style (decided, new): a separate, always-optional style that
    // joins its user's stance when the Stance matchup is scored for this
    // move's roll. Unlike the gate above it is NOT dropped on a Default move
    // — a Default move is usable by anyone, which is a statement about who
    // may throw it, not about what it is made of, and a styleless Default
    // library would put the whole mechanic out of reach of the moves every
    // character actually has.
    let combatStyleId = null;
    if (payload.combatStyleAttributeId != null) {
      const style = await one('SELECT id FROM attributes WHERE id = ?', [
        payload.combatStyleAttributeId,
      ]);
      if (!style) return null;
      combatStyleId = style.id;
    }

    let folderId = null;
    if (payload.folderId != null) {
      const folder = await one('SELECT id FROM move_folders WHERE id = ?', [payload.folderId]);
      if (folder) folderId = folder.id;
    }

    // 0-10 tags, all must exist
    let tagIds = [];
    let tagNames = [];
    if (Array.isArray(payload.tagIds) && payload.tagIds.length) {
      const unique = [...new Set(payload.tagIds.map(Number).filter(Number.isInteger))].slice(0, 10);
      if (unique.length) {
        // Names as well as ids now (Block Stamina): the Block Tag is what
        // decides whether this move has an up-front Stamina Cost at all, and
        // tag automation is keyed by name, never by id — see
        // server/tagAutomations.js for why.
        const found = await all(
          `SELECT id, name FROM tags WHERE id IN (${unique.map(() => '?').join(',')})`,
          unique
        );
        tagIds = found.map((t) => t.id);
        tagNames = found.map((t) => t.name);
      }
    }

    // Block Stamina (decided, new — the Block Tag's automation): a Block has
    // no up-front Stamina Cost. Forced to 0 here regardless of what the
    // client sent, the same server-authoritative pattern writeMove already
    // uses for a Default move's style and for the Stat/Custom roll split — a
    // rule the UI merely reflects, rather than one the UI enforces.
    const isBlockTagged = carriesBlockTag(tagNames);
    const effectiveStaminaCost = isBlockTagged ? 0 : staminaCost;
    const staminaModifier = clampStaminaModifier(payload.staminaModifier);
    // The No Damage Tag's own field. Stored unconditionally rather than only
    // when the tag is present: a GM who tags a move No Damage, sets a
    // Threshold of 12, then unticks the tag to compare it against the
    // damaging version should find the 12 still there when they tick it back.
    // The engine only ever reads it on a No Damage move, so an unused value
    // on an ordinary move is inert.
    const successThreshold = clampSuccessThreshold(payload.successThreshold);

    // Every move id that currently exists, fetched at most once per save and
    // shared by the two fields that point at other moves (Requirement here,
    // the grapple directions further down). Lazy because most saves set
    // neither and shouldn't pay for the query.
    let moveIdsPromise = null;
    const existingMoveIds = () => {
      moveIdsPromise ??= all('SELECT id FROM moves').then((rows) => rows.map((r) => r.id));
      return moveIdsPromise;
    };

    // Requirement (decided, new): the move this one may only follow. Validated
    // against the library so an arrow at something deleted while the form was
    // open is dropped rather than stored — the rest of the move still saves,
    // matching how a missing folder and a stale grapple direction are handled.
    // A self-reference is dropped by normalizeRequirement itself.
    //
    // On a *create* there is no id yet, so `moveId` is null and the
    // self-reference rule is vacuous — a move that doesn't exist can't be
    // named by the form that is creating it.
    const requirementMoveId =
      payload.requirementMoveId == null || payload.requirementMoveId === ''
        ? null
        : normalizeRequirement(payload.requirementMoveId, {
            moveId,
            validMoveIds: await existingMoveIds(),
          });

    let id = moveId;
    if (id == null) {
      // Copying a move (decided, new): a copy is filed **beside its source**
      // rather than at position 0. The Compendium orders by (sort_order, id),
      // so reusing the source's sort_order and letting the newer id break the
      // tie drops the copy immediately after the original — which is where a
      // GM making a variant is looking. Only honoured on INSERT: putting it
      // in the UPDATE would reset the GM's drag order on every plain edit.
      // Everything else keeps the 0 default, where the id tiebreak already
      // appends it to the end of a library nobody has reordered.
      const sortOrder = Number.isInteger(payload.sortOrder) ? payload.sortOrder : 0;
      const result = await run(
        `INSERT INTO moves (name, is_default, tell_id, startup_tics, active_tics, recovery_tics,
          stamina_cost, description, style_attribute_id, folder_id, image_data, image_mime_type,
          roll_modifier, right_tell_id, left_tell_id, is_defensive, defense_frame_positions,
          roll_type, custom_roll_size, attack_targets, defense_kind, stamina_modifier,
          combat_style_attribute_id, success_threshold, is_grappling, requirement_move_id, sort_order,
          is_secondary, crop_x, crop_y, crop_w, crop_h)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, isDefault, tellId, startup, active, recovery, effectiveStaminaCost, description, styleId,
          folderId, payload.imageData ?? null,
          payload.imageData ? (payload.imageMimeType ?? 'image/png') : null,
          rollModifier, rightTellId, leftTellId, isDefensive, JSON.stringify(defenseFramePositions),
          rollType, customRollSize, JSON.stringify(attackTargets), defenseKind, staminaModifier,
          combatStyleId, successThreshold, isGrappling, requirementMoveId, sortOrder, isSecondary,
          ...cropValues(payload)]
      );
      id = Number(result.lastInsertRowid);
    } else {
      await run(
        `UPDATE moves SET name = ?, is_default = ?, tell_id = ?, startup_tics = ?, active_tics = ?,
          recovery_tics = ?, stamina_cost = ?, description = ?, style_attribute_id = ?, folder_id = ?,
          roll_modifier = ?, right_tell_id = ?, left_tell_id = ?, is_defensive = ?,
          defense_frame_positions = ?, roll_type = ?, custom_roll_size = ?, attack_targets = ?,
          defense_kind = ?, stamina_modifier = ?, combat_style_attribute_id = ?,
          success_threshold = ?, is_grappling = ?, requirement_move_id = ?, is_secondary = ?
          WHERE id = ?`,
        [name, isDefault, tellId, startup, active, recovery, effectiveStaminaCost, description, styleId,
          folderId, rollModifier, rightTellId, leftTellId, isDefensive,
          JSON.stringify(defenseFramePositions), rollType, customRollSize, JSON.stringify(attackTargets),
          defenseKind, staminaModifier, combatStyleId, successThreshold, isGrappling,
          requirementMoveId, isSecondary, id]
      );
      // image only replaced when a new one is provided — and its crop goes
      // with it, since a crop describes one particular picture.
      if (payload.imageData !== undefined) {
        await run(`UPDATE moves SET image_data = ?, image_mime_type = ?, ${CROP_COLUMNS} WHERE id = ?`, [
          payload.imageData,
          payload.imageMimeType ?? 'image/png',
          ...cropValues(payload),
          id,
        ]);
      }
      await run('DELETE FROM move_interactions WHERE move_id = ?', [id]);
    }
    await run('DELETE FROM move_tags WHERE move_id = ?', [id]);
    for (const tagId of tagIds) {
      await run('INSERT INTO move_tags (move_id, tag_id) VALUES (?, ?)', [id, tagId]);
    }
    // All three Rolls store one row per distinct slot carrying how many of it
    // the Roll takes — the tables' UNIQUE(move_id, slot_name) means a doubled
    // Hand can't be two rows (see server/db.js's count column). Delete-then-
    // reinsert, so an emptied Roll genuinely empties rather than leaving
    // orphans behind.
    const writeSlots = async (table, slots) => {
      await run(`DELETE FROM ${table} WHERE move_id = ?`, [id]);
      for (const { slot_name, count } of collapseRollSlots(slots)) {
        await run(`INSERT INTO ${table} (move_id, slot_name, count) VALUES (?, ?, ?)`, [
          id,
          slot_name,
          count,
        ]);
      }
    };
    await writeSlots('move_roll_slots', rollSlots);
    await writeSlots('move_resist_roll_slots', resistRollSlots);
    await writeSlots('move_defensive_roll_slots', defensiveRollSlots);

    // Grappling directions. Validated against the moves that actually exist,
    // so an arrow pointing at something deleted while the form was open is
    // dropped rather than stored — the rest of the move still saves, matching
    // how a missing folder is handled above. A self-reference is dropped by
    // normalizeGrappleDirections itself.
    await run('DELETE FROM move_grapple_directions WHERE move_id = ?', [id]);
    if (isGrappling) {
      for (const { direction, targetMoveId } of normalizeGrappleDirections(payload.grappleDirections, {
        moveId: id,
        validMoveIds: await existingMoveIds(),
      })) {
        await run(
          'INSERT INTO move_grapple_directions (move_id, direction, target_move_id) VALUES (?, ?, ?)',
          [id, direction, targetMoveId]
        );
      }
    }

    for (const row of normalizeInteractions(
      payload.interactions,
      Boolean(isDefensive),
      Boolean(isGrappling)
    )) {
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
    await run('DELETE FROM move_resist_roll_slots WHERE move_id = ?', [move.id]);
    await run('DELETE FROM move_defensive_roll_slots WHERE move_id = ?', [move.id]);
    await run('DELETE FROM move_grapple_directions WHERE move_id = ?', [move.id]);
    // **By target too, not just by owner.** A grappling move somewhere else in
    // the library may point one of its four arrows at this move; leaving that
    // row behind would render a direction whose move no longer exists, and the
    // FK to moves(id) would refuse the delete outright.
    await run('DELETE FROM move_grapple_directions WHERE target_move_id = ?', [move.id]);
    // Same reasoning for Requirement, which is a column rather than a child
    // table: any move that could only be thrown after this one becomes freely
    // declarable again rather than permanently unusable. Cleared, not
    // cascaded — the requiring move is still a perfectly good move.
    await run('UPDATE moves SET requirement_move_id = NULL WHERE requirement_move_id = ?', [move.id]);
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
    // Special is the GM's to hand out. Silent no-op on refusal, matching every
    // other rejection in this handler.
    if (socket.data.identity?.role !== 'gm' && (await isSpecialMove(move.id))) return;
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

  // Perk Tags — the same three verbs as the Move tag events above, against
  // the separate perk_tags vocabulary. Unlike a Move tag, deleting one of
  // these can never change how anything resolves: they carry no mechanics by
  // design, so there is no in-use guard, just the link cleanup.
  on('perk_tag:create', async ({ name, description }) => {
    const tagName = String(name ?? '').trim();
    if (!tagName) return;
    const result = await run('INSERT INTO perk_tags (name, description) VALUES (?, ?)', [
      tagName,
      String(description ?? '').trim(),
    ]);
    io.emit('perk_tag:created', await one('SELECT * FROM perk_tags WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
  });

  on('perk_tag:update', async ({ tagId, name, description }) => {
    const tag = await one('SELECT * FROM perk_tags WHERE id = ?', [tagId]);
    const tagName = String(name ?? '').trim();
    if (!tag || !tagName) return;
    await run('UPDATE perk_tags SET name = ?, description = ? WHERE id = ?', [
      tagName,
      String(description ?? '').trim(),
      tag.id,
    ]);
    io.emit('perk_tag:updated', await one('SELECT * FROM perk_tags WHERE id = ?', [tag.id]));
  });

  on('perk_tag:delete', async ({ tagId }) => {
    const tag = await one('SELECT * FROM perk_tags WHERE id = ?', [tagId]);
    if (!tag) return;
    await run('DELETE FROM perk_tag_links WHERE perk_tag_id = ?', [tag.id]);
    await run('DELETE FROM perk_tags WHERE id = ?', [tag.id]);
    io.emit('perk_tag:deleted', { tagId: tag.id });
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

  // Custom Compendium ordering (decided, new). The client sends the full
  // ordered list of move ids for the view it just rearranged, and the server
  // writes positions across **that list only** — a Discipline is a window
  // onto one global order, so reordering inside it must not renumber the
  // moves that weren't on screen.
  //
  // Positions are taken from the sort_order values those same moves already
  // occupy, re-sorted and handed back out in the new sequence. That keeps
  // every reorder local: a move dragged within "Boxing" can never jump ahead
  // of something in "Karate" that it was already behind, and "All Moves"
  // stays consistent with every filtered view of it.
  on('move:reorder', async ({ moveIds }) => {
    if (!Array.isArray(moveIds) || moveIds.length < 2) return;
    const ids = [...new Set(moveIds.map(Number).filter(Number.isInteger))];
    if (ids.length < 2) return;
    const marks = ids.map(() => '?').join(',');
    // Only ids that actually exist, and their current positions. A move
    // deleted while someone had the Compendium open is dropped rather than
    // reintroduced by the write below.
    const rows = await all(
      `SELECT id, sort_order FROM moves WHERE id IN (${marks}) ORDER BY sort_order, id`,
      ids
    );
    if (rows.length < 2) return;
    const known = new Set(rows.map((r) => r.id));
    const sequence = ids.filter((id) => known.has(id));
    // The slots these moves collectively occupy, ascending. Ties on
    // sort_order (an un-reordered library is all zeroes) are broken by the
    // same (sort_order, id) rule every read path uses, so the first write
    // against a fresh library spreads them out in their existing order.
    const slots = rows.map((r) => r.sort_order).sort((a, b) => a - b);
    // A library that has never been reordered has every slot at 0, so there
    // is nothing to redistribute — fall back to the row's index, which is
    // exactly the (sort_order, id) order they were just read in.
    const distinct = new Set(slots).size > 1 ? slots : rows.map((_, i) => i);
    for (const [i, id] of sequence.entries()) {
      await run('UPDATE moves SET sort_order = ? WHERE id = ?', [distinct[i], id]);
    }
    io.emit('moves:reordered', { moveIds: sequence, sortOrders: distinct });
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
  // picture/name/description here — mechanical effects are per-Perk code bound
  // by name (server/perks/index.js), never stored automation data.
  const writePerk = async (perkId, payload) => {
    const name = String(payload.name ?? '').trim();
    if (!name) return null;
    const description = String(payload.description ?? '').trim();

    // **An automated Perk's name is frozen (decided, new).** Its mechanics bind
    // to that exact string, so a rename does not adjust the binding — it breaks
    // it, silently, leaving a Perk that still looks granted and does nothing.
    // That is the one failure mode name-keyed registries actually have, and the
    // only place a user can trigger it. Everything else about the Perk —
    // description, picture, Perk Tags — stays freely editable; refusing the
    // whole save would be a worse trade.
    if (perkId != null) {
      const current = await one('SELECT name FROM perks WHERE id = ?', [perkId]);
      if (current && isAutomatedPerk(current.name) && name !== current.name) {
        await postSystemMessage(
          io,
          `"${current.name}" has automated rules attached to its name, so it can't be renamed. Its description, picture and tags are still editable.`
        );
        return null;
      }
    }

    let id = perkId;
    if (id == null) {
      const result = await run(
        'INSERT INTO perks (name, description, image_data, image_mime_type, crop_x, crop_y, crop_w, crop_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [name, description, payload.imageData ?? null, payload.imageData ? (payload.imageMimeType ?? 'image/png') : null,
          ...cropValues(payload)]
      );
      id = Number(result.lastInsertRowid);
    } else {
      await run('UPDATE perks SET name = ?, description = ? WHERE id = ?', [name, description, id]);
      if (payload.imageData !== undefined) {
        await run(`UPDATE perks SET image_data = ?, image_mime_type = ?, ${CROP_COLUMNS} WHERE id = ?`, [
          payload.imageData,
          payload.imageMimeType ?? 'image/png',
          ...cropValues(payload),
          id,
        ]);
      }
    }

    // Perk Tags: purely categorisation, so the only validation is that each
    // id names a real tag. Rewritten wholesale on every save, same as a
    // move's tags — an omitted tagIds means "no tags", not "leave alone",
    // which is what a form that always sends its full selection wants.
    const tagIds = Array.isArray(payload.tagIds)
      ? [...new Set(payload.tagIds.map(Number).filter(Number.isInteger))]
      : [];
    const knownTags = tagIds.length
      ? (await all(
          `SELECT id FROM perk_tags WHERE id IN (${tagIds.map(() => '?').join(',')})`,
          tagIds
        )).map((t) => t.id)
      : [];
    await run('DELETE FROM perk_tag_links WHERE perk_id = ?', [id]);
    for (const tagId of knownTags) {
      await run('INSERT INTO perk_tag_links (perk_id, perk_tag_id) VALUES (?, ?)', [id, tagId]);
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
    // See isSpecialMove above — the same rule, in the Perk vocabulary.
    if (socket.data.identity?.role !== 'gm' && (await isSpecialPerk(perk.id))) return;
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

    // Tier 3 of the Perk architecture — the imperative escape hatch, for a Perk
    // whose effect is a permanent change made once at grant time. `io` is
    // handed in rather than imported by the Perk file, so a definition never
    // has to reach into this module (see server/perks/index.js).
    await perkDefinition(perk.name)?.onGrant?.({
      characterId: character.id,
      perkId: perk.id,
      characterPerkId,
      io,
    });

    io.emit('perk:granted', { characterId: character.id, perkId: perk.id });
    await refreshCapabilities(character.id);
  });

  on('perk:revoke', async ({ characterId, perkId }) => {
    const characterPerk = await one(
      'SELECT * FROM character_perks WHERE character_id = ? AND perk_id = ?',
      [characterId, perkId]
    );
    if (!characterPerk) return;
    const perk = await one('SELECT * FROM perks WHERE id = ?', [characterPerk.perk_id]);

    // Move-scoped rows an onGrant may have tagged with this grant — cleaned up
    // in bulk here rather than by the hook itself. `character_perk_state` needs
    // no line of its own: it cascades off character_perks.
    await run('DELETE FROM character_move_tags WHERE source_character_perk_id = ?', [characterPerk.id]);
    await run('DELETE FROM character_move_overrides WHERE source_character_perk_id = ?', [characterPerk.id]);
    await run('DELETE FROM character_move_roll_bonuses WHERE source_character_perk_id = ?', [characterPerk.id]);

    // **Before the grant row goes**, so a hook can still read its own state.
    await perkDefinition(perk?.name)?.onRevoke?.({
      characterId: characterPerk.character_id,
      perkId: characterPerk.perk_id,
      characterPerkId: characterPerk.id,
      io,
    });
    await run('DELETE FROM character_perks WHERE id = ?', [characterPerk.id]);

    io.emit('perk:revoked', { characterId: characterPerk.character_id, perkId: characterPerk.perk_id });
    await refreshCapabilities(characterPerk.character_id);
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

  // -------------------------------------------------------------------
  // Relationships board
  // -------------------------------------------------------------------
  //
  // Every handler starts with the same gate. There is no per-event variation
  // because there is no per-event rule: you may write a board if you own it or
  // you are the GM, full stop. A caller who is neither is dropped silently, the
  // way move:declare treats a declaration for a character it doesn't own.
  const mayWriteBoard = (ownerCharacterId) =>
    maySeeBoard(socket.data.identity, ownerCharacterId);

  // Node writes arrive by node id, not by board id, so the owner has to be
  // read back off the row before the gate can be applied — otherwise a caller
  // could move a node on somebody else's board by naming its id.
  const loadOwnedNode = async (nodeId) => {
    const node = await one('SELECT * FROM relationship_nodes WHERE id = ?', [nodeId]);
    if (!node || !mayWriteBoard(node.owner_character_id)) return null;
    return node;
  };

  // Half a node's width/height. Kept as a literal rather than imported from the
  // client's geometry module — the server has no business importing client code
  // — and pinned against NODE_W/NODE_H by relationshipGeometry.test.js so the
  // two cannot drift.
  const NODE_CENTER_OFFSET = 56;

  const clampText = (value, max) => String(value ?? '').slice(0, max);
  // A world coordinate. Bounded because the plane is infinite but a number is
  // not: a NaN or an Infinity here would put a node nowhere and take the whole
  // board's layout with it.
  const coord = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(-1e6, Math.min(1e6, n)) : 0;
  };

  on('relationships:add_node', async ({ characterId, targetCharacterId, personId, x, y }) => {
    if (!mayWriteBoard(characterId)) return;
    const owner = await getCharacter(characterId);
    if (!owner) return;
    // Exactly one source, matching the table's own CHECK. Asked here as well so
    // a malformed payload is a dropped event rather than a constraint error.
    const hasCharacter = targetCharacterId != null;
    const hasPerson = personId != null;
    if (hasCharacter === hasPerson) return;
    await pushUndo(owner.id);
    if (hasCharacter && !(await getCharacter(targetCharacterId))) return;
    if (hasPerson) {
      const person = await one(
        'SELECT id FROM relationship_people WHERE id = ? AND owner_character_id = ?',
        [personId, owner.id]
      );
      // A person belongs to one board. Placing somebody else's is not a thing.
      if (!person) return;
    }
    await run(
      `INSERT INTO relationship_nodes (owner_character_id, character_id, person_id, x, y)
       VALUES (?, ?, ?, ?, ?)`,
      [owner.id, hasCharacter ? Number(targetCharacterId) : null, hasPerson ? Number(personId) : null, coord(x), coord(y)]
    );
    await emitRelationships(owner.id);
  });

  // One write per drag, sent on pointerup. Nothing hits the DB mid-gesture.
  on('relationships:move_node', async ({ nodeId, x, y }) => {
    const node = await loadOwnedNode(nodeId);
    if (!node) return;
    await pushUndo(node.owner_character_id);
    await run('UPDATE relationship_nodes SET x = ?, y = ? WHERE id = ?', [coord(x), coord(y), node.id]);
    await emitRelationships(node.owner_character_id);
  });

  on('relationships:update_node', async ({ nodeId, nickname, notes }) => {
    const node = await loadOwnedNode(nodeId);
    if (!node) return;
    await pushUndo(node.owner_character_id);
    await run('UPDATE relationship_nodes SET nickname = ?, notes = ? WHERE id = ?', [
      clampText(nickname ?? node.nickname, 80),
      clampText(notes ?? node.notes, 8000),
      node.id,
    ]);
    await emitRelationships(node.owner_character_id);
  });

  // **The ✕ menu's two options.**
  //
  // `keepRelationships` leaves every line touching this node hanging exactly
  // where its portrait was: the last-known anchor is written into from_x/from_y
  // (or to_x/to_y) and the node reference nulled, in ONE statement per side, so
  // there is no instant where a row has neither an anchor nor a coordinate.
  // The line keeps its colour, its label and its arrowhead, and can be dragged
  // onto somebody else later.
  //
  // The loose end lands at the node's CENTRE rather than at the dot it was
  // attached to. The dot is a property of a portrait that no longer exists; the
  // middle of where that person used to be is the honest answer, and it is the
  // one place that reads the same for all four sides.
  on('relationships:delete_node', async ({ nodeId, keepRelationships }) => {
    const node = await loadOwnedNode(nodeId);
    if (!node) return;
    await pushUndo(node.owner_character_id);
    if (keepRelationships) {
      const cx = node.x + NODE_CENTER_OFFSET;
      const cy = node.y + NODE_CENTER_OFFSET;
      await run(
        `UPDATE relationship_edges SET from_node_id = NULL, from_x = ?, from_y = ? WHERE from_node_id = ?`,
        [cx, cy, node.id]
      );
      await run(
        `UPDATE relationship_edges SET to_node_id = NULL, to_x = ?, to_y = ? WHERE to_node_id = ?`,
        [cx, cy, node.id]
      );
    } else {
      await run('DELETE FROM relationship_edges WHERE from_node_id = ? OR to_node_id = ?', [
        node.id,
        node.id,
      ]);
    }
    await run('DELETE FROM relationship_nodes WHERE id = ?', [node.id]);
    await emitRelationships(node.owner_character_id);
  });

  // -------------------------------------------------------------------
  // Relationships: the lines
  // -------------------------------------------------------------------

  const SIDE_NAMES = new Set(['top', 'right', 'bottom', 'left']);
  const side = (value, fallback) => (SIDE_NAMES.has(value) ? value : fallback);

  // Both endpoints must be nodes on the SAME board — the board this caller may
  // write. Checked by reading them back rather than trusting the payload, the
  // same way loadOwnedNode does, so naming a node id from another board buys
  // nothing.
  on('relationships:add_edge', async ({ fromNodeId, fromSide, toNodeId, toSide }) => {
    const from = await loadOwnedNode(fromNodeId);
    const to = await loadOwnedNode(toNodeId);
    if (!from || !to) return;
    if (from.owner_character_id !== to.owner_character_id) return;
    // A line from somebody to themselves is a loop with nothing to say, and the
    // curve maths would have to special-case a zero-length span to draw it.
    if (from.id === to.id) return;
    await pushUndo(from.owner_character_id);
    await run(
      `INSERT INTO relationship_edges (owner_character_id, from_node_id, from_side, to_node_id, to_side)
       VALUES (?, ?, ?, ?, ?)`,
      [from.owner_character_id, from.id, side(fromSide, 'right'), to.id, side(toSide, 'left')]
    );
    await emitRelationships(from.owner_character_id);
  });

  const loadOwnedEdge = async (edgeId) => {
    const edge = await one('SELECT * FROM relationship_edges WHERE id = ?', [edgeId]);
    if (!edge || !mayWriteBoard(edge.owner_character_id)) return null;
    return edge;
  };

  // **Colour is user data that reaches a renderer.** It goes straight into an
  // SVG `stroke` and into a `<marker>` id, so it is the one field on this board
  // that is validated rather than merely clamped: a strict `#rrggbb`, and
  // anything else falls back to the column default rather than being stored.
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const DEFAULT_EDGE_COLOR = '#f87179';
  const colour = (value, fallback = DEFAULT_EDGE_COLOR) =>
    HEX.test(String(value ?? '')) ? String(value).toLowerCase() : fallback;

  const ARROWS = new Set(['none', 'from', 'to']);

  // **The hand-drawn arc, as a perpendicular offset.** Bounded for exactly the
  // reason `coord` is bounded: the plane is infinite and a number is not, and
  // one NaN here would take the line off the board entirely.
  //
  // `null` is a real value here and means "no hand bend" — the line goes back
  // to whatever the automatic fan gives it. That is distinct from the field
  // being absent, which like every other field on this event means "leave it
  // alone", so the three cases have to stay apart: undefined keeps, null
  // clears, a number sets.
  // **The hand-drawn arc, as two fractions of the line's own frame.** `bend` is
  // the control point's offset ACROSS the chord and `bendU` is where along it
  // that offset sits. Bounded for exactly the reason `coord` is bounded: the
  // plane is infinite and a number is not, and one NaN here would take the line
  // off the board entirely.
  const BEND_LIMIT = 4000;
  const BEND_U_LIMIT = 2;
  const bounded = (value, limit, fallback = null) => {
    // Explicitly, before Number() gets its hands on it: `Number(null)` is 0,
    // which is a perfectly finite number and would store "hand-bent, straight"
    // where the caller asked for "not hand-bent at all".
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(-limit, Math.min(limit, n));
  };

  // What a relationship SAYS, as opposed to where it is attached (move_end).
  // Every field is optional: the editor applies each control live, so a single
  // change sends a single field and everything else keeps its stored value.
  on('relationships:update_edge', async (payload) => {
    const { edgeId, label, color, arrow, retired, bend, bendU } = payload;
    const edge = await loadOwnedEdge(edgeId);
    if (!edge) return;
    await pushUndo(edge.owner_character_id);
    // **The two halves of a bend move together.** `bend: null` clears the whole
    // hand bend, so `bend_u` has to go with it or a later re-bend would inherit
    // a stale along-the-line position from an arc nobody can see any more.
    const clearing = bend === null;
    await run(
      `UPDATE relationship_edges SET label = ?, color = ?, arrow = ?, retired = ?, bend = ?, bend_u = ? WHERE id = ?`,
      [
        clampText(label ?? edge.label, 60),
        colour(color ?? edge.color, edge.color),
        // Validated here as well as by the column's CHECK so a bad value is a
        // dropped event rather than a thrown constraint — the same shape
        // `side()` uses for the four dot names.
        ARROWS.has(arrow) ? arrow : ARROWS.has(edge.arrow) ? edge.arrow : 'none',
        retired == null ? edge.retired : retired ? 1 : 0,
        bend === undefined ? edge.bend : bounded(bend, BEND_LIMIT),
        clearing ? null : bendU === undefined ? edge.bend_u : bounded(bendU, BEND_U_LIMIT, 0.5),
        edge.id,
      ]
    );
    await emitRelationships(edge.owner_character_id);
  });

  on('relationships:delete_edge', async ({ edgeId }) => {
    const edge = await loadOwnedEdge(edgeId);
    if (!edge) return;
    await pushUndo(edge.owner_character_id);
    await run('DELETE FROM relationship_edges WHERE id = ?', [edge.id]);
    await emitRelationships(edge.owner_character_id);
  });

  // Moving or re-attaching one end of a line. Both are the same write: an end
  // is either a node and a side, or a point in space, and this swaps between
  // them. `nodeId: null` drops it loose at (x, y); a node id picks it back up.
  on('relationships:move_end', async ({ edgeId, end, nodeId, side: toSide, x, y }) => {
    const edge = await loadOwnedEdge(edgeId);
    if (!edge || (end !== 'from' && end !== 'to')) return;
    let target = null;
    if (nodeId != null) {
      target = await loadOwnedNode(nodeId);
      if (!target || target.owner_character_id !== edge.owner_character_id) return;
      // Re-attaching an end onto the node the OTHER end already holds would
      // make the loop add_edge refuses to create, so it is refused here too.
      const otherNodeId = end === 'from' ? edge.to_node_id : edge.from_node_id;
      if (otherNodeId != null && Number(otherNodeId) === target.id) return;
    }
    await pushUndo(edge.owner_character_id);
    const columns =
      end === 'from'
        ? ['from_node_id', 'from_side', 'from_x', 'from_y']
        : ['to_node_id', 'to_side', 'to_x', 'to_y'];
    await run(
      `UPDATE relationship_edges SET ${columns[0]} = ?, ${columns[1]} = ?, ${columns[2]} = ?, ${columns[3]} = ? WHERE id = ?`,
      [
        target ? target.id : null,
        side(toSide, end === 'from' ? 'right' : 'left'),
        target ? null : coord(x),
        target ? null : coord(y),
        edge.id,
      ]
    );
    await emitRelationships(edge.owner_character_id);
  });

  on('relationships:create_person', async (payload) => {
    const { characterId, name, imageData, imageMimeType } = payload;
    if (!mayWriteBoard(characterId)) return;
    const owner = await getCharacter(characterId);
    const personName = clampText(name, 80).trim();
    // Name is the one mandatory field: a face with no name is not a person you
    // can think about, and the rail would show a blank row.
    if (!owner || !personName) return;
    await pushUndo(owner.id);
    await run(
      `INSERT INTO relationship_people (owner_character_id, name, image_data, image_mime_type, crop_x, crop_y, crop_w, crop_h)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner.id, personName, imageData ? String(imageData) : null, imageData ? String(imageMimeType ?? 'image/jpeg') : null,
        ...cropValues(payload)]
    );
    await emitRelationships(owner.id);
  });

  on('relationships:update_person', async (payload) => {
    const { personId, name, imageData, imageMimeType } = payload;
    const person = await one('SELECT * FROM relationship_people WHERE id = ?', [personId]);
    if (!person || !mayWriteBoard(person.owner_character_id)) return;
    const personName = clampText(name ?? person.name, 80).trim();
    if (!personName) return;
    // An absent picture means "leave it alone", not "clear it" — the editor
    // only sends one when the file picker actually produced one.
    await pushUndo(person.owner_character_id);
    await run(
      imageData
        ? `UPDATE relationship_people SET name = ?, image_data = ?, image_mime_type = ?, ${CROP_COLUMNS} WHERE id = ?`
        : 'UPDATE relationship_people SET name = ? WHERE id = ?',
      imageData
        ? [personName, String(imageData), String(imageMimeType ?? 'image/jpeg'), ...cropValues(payload), person.id]
        : [personName, person.id]
    );
    await emitRelationships(person.owner_character_id);
  });

  // Deleting a person takes their placements with them — they are that person
  // and nothing else. Explicit, because ON DELETE actions cannot be relied on
  // here (see the tables' own note in db.js).
  on('relationships:delete_person', async ({ personId }) => {
    const person = await one('SELECT * FROM relationship_people WHERE id = ?', [personId]);
    if (!person || !mayWriteBoard(person.owner_character_id)) return;
    await pushUndo(person.owner_character_id);
    // Their lines go with them. Deleting the person is the one destructive
    // choice on the board that offers no "keep the relationships" option — the
    // ✕ menu on a node is where that choice lives, and this is a level above it.
    await run(
      `DELETE FROM relationship_edges WHERE from_node_id IN (SELECT id FROM relationship_nodes WHERE person_id = ?)
          OR to_node_id IN (SELECT id FROM relationship_nodes WHERE person_id = ?)`,
      [person.id, person.id]
    );
    await run('DELETE FROM relationship_nodes WHERE person_id = ?', [person.id]);
    await run('DELETE FROM relationship_people WHERE id = ?', [person.id]);
    await emitRelationships(person.owner_character_id);
  });

  // **Ctrl+Z.** Pops the most recent snapshot and puts the board back exactly as
  // it was — same rows, same ids — so relationships that pointed at a deleted
  // node point at it again rather than at nothing.
  //
  // The stack is per board and shared: the GM and the owner edit the same web,
  // so they undo the same history. Whoever presses it takes back the last
  // change made to that board, not the last change made by them — which is the
  // only version that can be coherent when two people are drawing at once.
  on('relationships:undo', async ({ characterId }) => {
    if (!mayWriteBoard(characterId)) return;
    const id = Number(characterId);
    const stack = undoStacks.get(id);
    if (!stack?.length) return;
    await restoreBoard(id, stack.pop());
    if (!stack.length) undoStacks.delete(id);
    await emitRelationships(id);
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
  // GM Tools — Roll Requester (decided, new). The GM asks one character's
  // player to roll one Stat; that player gets a prompt wherever they are in
  // the app, and answering it runs an ordinary pool:roll, so the result is
  // an ordinary chat roll with every usual bonus already folded in. No new
  // roll mechanic — only a way to *ask*.
  //
  // Delivered to the character's own player socket(s) plus every GM (so the
  // requesting GM sees their own request land, and a second GM tab doesn't
  // sit blind). Deliberately not a broadcast: a request naming a character
  // is that player's business, and a fail-closed filter matches how every
  // other targeted push in this app already behaves.
  on('roll:request', async ({ characterId, slotName, targetNumber = null }) => {
    if (socket.data?.identity?.role !== 'gm') return;
    if (!VALID_INJURY_SLOTS.has(slotName)) return;
    const character = await getCharacter(characterId);
    if (!character) return;
    const die = await one('SELECT * FROM dice WHERE character_id = ? AND slot_name = ?', [
      character.id,
      slotName,
    ]);
    if (!die) return;
    const requestId = `${character.id}:${slotName}:${Date.now()}`;
    // An optional target number the roll is resolved against, so the GM
    // stops comparing totals by eye. Held SERVER-SIDE against the request
    // id and never sent to the player being asked: a check whose number you
    // can see is a different thing to attempt, and the verdict is posted
    // publicly the moment they roll anyway. GMs get it back so their own
    // widget can show what they asked for.
    const target = Number.isFinite(Number(targetNumber)) ? Math.trunc(Number(targetNumber)) : null;
    if (target != null) {
      pendingRollChecks.set(requestId, { characterId: character.id, slotName, target });
      // Bounded: a request nobody answers would otherwise pin its entry
      // forever. Dropping it just means no verdict is posted — the roll
      // itself is unaffected, which is why this can live in memory at all
      // (unlike a Dodge pause, nothing waits on it).
      setTimeout(() => pendingRollChecks.delete(requestId), 30 * 60 * 1000).unref?.();
    }
    const payload = {
      requestId,
      characterId: character.id,
      characterName: character.name,
      slotName,
      dieId: die.id,
      size: die.current_size,
      bonus: die.bonus,
      status: die.status,
    };
    for (const viewerSocket of io.sockets.sockets.values()) {
      const identity = viewerSocket.data?.identity;
      if (!identity) continue;
      const isTargetPlayer = identity.role === 'player' && identity.characterId === character.id;
      if (identity.role === 'gm') viewerSocket.emit('roll:requested', { ...payload, targetNumber: target });
      else if (isTargetPlayer) viewerSocket.emit('roll:requested', payload);
    }
  });

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

    // **Reaching a Gate is announced.** That is the whole reason a Gate exists:
    // a point of progress the table agreed would matter, said out loud at the
    // moment it arrives rather than noticed later. Computed against the CLAMPED
    // value, so a +5 on a counter with two pips left announces the two Gates it
    // actually reached and not the three it did not.
    const gates = await all('SELECT * FROM counter_gates WHERE counter_id = ?', [counter.id]);
    const reached = gatesCrossed(gates, counter.current_pips, currentPips);
    if (reached.length) {
      const owner = counter.character_id != null ? await getCharacter(counter.character_id) : null;
      const label = owner ? `${owner.name} - ${counter.name}` : counter.name;
      for (const gate of reached) {
        await postSystemMessage(io, gateChatLine(label, gate, currentPips, counter.target_pips));
      }
    }
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
    // Spelled out rather than left to ON DELETE CASCADE. The pragma is on and
    // the cascade would fire, but every other delete in this file states its own
    // cascade (see DELETE /api/characters/:id), and one that quietly relies on
    // the DDL is the one a future rebuild breaks.
    await run('DELETE FROM counter_gates WHERE counter_id = ?', [counter.id]);
    await run('DELETE FROM counters WHERE id = ?', [counter.id]);
    io.emit('counter:deleted', { counterId: counter.id });
    await emitGates();
  });

  // ---- Gates -------------------------------------------------------------
  //
  // **GM-only, and that is the mechanic rather than a permission.** A Gate is
  // the GM writing on a Counter's future, and `secret` is meaningless if the
  // person it is kept from can author it. Counters themselves stay open to
  // whoever controls the character, exactly as before.
  const isGm = () => socket.data?.identity?.role === 'gm';

  on('counter_gate:save', async ({ counterId, pipIndex, name, description, secret }) => {
    if (!isGm()) return;
    const counter = await one('SELECT * FROM counters WHERE id = ?', [counterId]);
    if (!counter) return;
    const pip = Math.trunc(Number(pipIndex));
    if (!isValidPip(pip, counter.target_pips)) return;
    // One Gate per pip, so saving is an upsert rather than a create-or-fail:
    // the editor opens on a pip and does not know or care whether the row it is
    // about to write already exists.
    await run(
      `INSERT INTO counter_gates (counter_id, pip_index, name, description, secret)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(counter_id, pip_index)
       DO UPDATE SET name = excluded.name, description = excluded.description, secret = excluded.secret`,
      [counter.id, pip, clampText(name, 60).trim(), clampText(description, 2000), secret ? 1 : 0]
    );
    await emitGates();
  });

  on('counter_gate:delete', async ({ gateId }) => {
    if (!isGm()) return;
    await run('DELETE FROM counter_gates WHERE id = ?', [gateId]);
    await emitGates();
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

  // "Fresh" (decided, new): whether Start Combat restores everyone to full
  // Stamina. Off by default and reset to off whenever a fight ends, so a run
  // of back-to-back fights wears people down unless the GM says otherwise.
  // Governs the first round only — the per-round Stamina Regen from round 2
  // on is a separate rule and keeps running either way.
  on('combat:toggle_fresh', async () => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    await run('UPDATE combat_state SET fresh_start = ? WHERE id = 1', [state.fresh_start ? 0 : 1]);
    await emitCombatUpdated();
  });

  on('combat:toggle_uneven', async () => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    await run('UPDATE combat_state SET uneven_combat_enabled = ? WHERE id = 1', [
      state.uneven_combat_enabled ? 0 : 1,
    ]);
    await emitCombatUpdated();
  });

  // A round that finished has a stored replay someone may still want to
  // watch — its "Watch Round N" chat card outlives the fight, and a dead
  // button is worse than no button. Only unfinished resolutions are dropped:
  // a half-resolved round has nothing worth replaying, and leaving one
  // 'running' would have the boot-time sweep try to finish a fight that no
  // longer exists. round_events cascades off whatever this deletes, so the
  // kept rows keep their events too.
  const discardUnfinishedResolutions = () =>
    run(`DELETE FROM pair_round_resolutions WHERE status != 'complete'`);

  on('combat:clear', async () => {
    await run('DELETE FROM combat_participants');
    await run('DELETE FROM declared_moves');
    await run('DELETE FROM combat_pairs');
    // Fight-scoped Perk charges. Cleared globally rather than per seat, because
    // a fight ending here IS global — every pair and every seat goes with it —
    // and a character who left the arena mid-fight has to lose theirs too.
    await clearAllPerkState('fight');
    // Fresh is a per-fight choice, never a standing setting — see its own
    // note on combat:toggle_fresh. Ending or clearing a fight puts it back
    // off so the next one has to opt in again.
    await run('UPDATE combat_state SET fresh_start = 0 WHERE id = 1');
    await discardUnfinishedResolutions();
    await emitCombatUpdated();
  });

  // End Combat — the other half of the Start/End Combat toggle shown in the
  // global Tic Counter header (visible on every page while any pair's own
  // phase is non-null). Unlike combat:clear ("Clear Arena"), this only
  // turns the fight itself off; everyone stays seated so the GM can start a
  // fresh fight for the same roster without re-seating. Deleting every
  // combat_pairs row (rather than just resetting their round/phase/Tic
  // columns) is deliberate: a fresh Start Combat afterward should seed
  // brand-new pair rows exactly like a never-before-fought roster would,
  // not resume mid-round-5 state from the fight that just ended.
  on('combat:end', async () => {
    await run('DELETE FROM declared_moves');
    await run('DELETE FROM combat_pairs');
    await clearAllPerkState('fight'); // see combat:clear
    await run('UPDATE combat_state SET fresh_start = 0 WHERE id = 1'); // see combat:clear
    await discardUnfinishedResolutions();
    await run('UPDATE combat_participants SET declared_this_round = 0, idle_regen_progress = 0');
    await emitCombatUpdated();
  });

  // Phase 7 — Combat Timing. Uses server/combatTiming.js's pure functions
  // for all placement/reveal/overflow math; see that module + the plan's
  // Combat Timing mechanic section for the decided rules wired together
  // here. GM-only client-side for next_round (matching the plan's own
  // event contract);
  // move:declare and character_done_declaring are open-access, matching how
  // declaring/rolling for a character already works everywhere else.
  //
  // Combat Automation overhaul: each pair now runs its own independent
  // round/phase/Tic clock (combat_pairs), so "Next Round" seeds a new round
  // for every currently-seated pair that ISN'T already mid-Declaration —
  // fight A can be well into round 5 while fight B only just finished
  // seating, and pressing this button doesn't disturb whichever pairs are
  // still declaring. combat_pairs rows are no longer deleted/recreated each
  // round (a genuinely per-pair round counter has to persist across
  // presses) — this upserts each eligible pair's row in place instead.
  //
  // Phase 9 combat redesign: initiative and declaration order are resolved
  // independently PER PAIR, not once across the whole arena — pair 1's
  // losing side and pair 2's losing side can be declaring at the same time
  // even though they might be literal opposite "sides" (see combat_pairs in
  // db.js).
  on('combat:next_round', async () => {
    const [state, participants, existingPairRows] = await Promise.all([
      one('SELECT * FROM combat_state WHERE id = 1'),
      all('SELECT * FROM combat_participants'),
      all('SELECT * FROM combat_pairs'),
    ]);
    if (!participants.length) return;
    const existingPairByIndex = new Map(existingPairRows.map((p) => [p.pair_index, p]));

    // combat:end deletes every combat_pairs row, so no pairs at all means
    // this press is starting a *fresh fight* rather than opening the next
    // round of one already running. Completed resolutions from the previous
    // fight are kept now (their replays outlive it), and this fight is about
    // to restart each pair at round 1 — so bump the fight counter to keep
    // "pair P, round N" unambiguous. Only when the current fight actually
    // used the number, so a first-ever Start Combat stays on fight 1.
    if (!existingPairRows.length) {
      const used = await one(
        'SELECT id FROM pair_round_resolutions WHERE fight_number = ? LIMIT 1',
        [state.fight_number ?? 1]
      );
      if (used) {
        await run('UPDATE combat_state SET fight_number = fight_number + 1 WHERE id = 1');
      }
    }

    // Skip any pair still mid-Declaration from a previous press — everyone
    // else (brand new, or done Resolving a previous round) gets a new round
    // seeded for them right now.
    const allPairIndices = [...new Set(participants.map((p) => p.pair_index))];
    const pairIndices = allPairIndices.filter((idx) => existingPairByIndex.get(idx)?.phase !== 'declaration');
    if (!pairIndices.length) return;
    const eligiblePairSet = new Set(pairIndices);
    const eligibleParticipants = participants.filter((p) => eligiblePairSet.has(p.pair_index));

    const charIds = [...new Set(eligibleParticipants.map((p) => p.character_id))];

    // Everything a Round Start does to a fighter's Perks — the once-per-round
    // charge reset and Healing Factor — lives in one shared function, because
    // this handler and roundResolution.js's startPairDeclaration are two copies
    // of "open a round" and had already drifted apart over exactly this (the
    // charge reset used to exist only in the other one). See
    // openRoundForCharacters for the full note.
    await openRoundForCharacters(io, charIds);

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

    // Computed per pair up front (needed by the Brain-roll loop below) —
    // see the Declaration Phase bullet in the plan for why this floor
    // exists. Each pair floors against its OWN previous phase/current_tic/
    // round_start_tic now, not one shared combat_state clock — a brand new
    // pair (no existing row) behaves exactly like the old "phase === null"
    // first-round case.
    const nextRoundStartTicByPair = new Map();
    for (const pairIndex of pairIndices) {
      const existing = existingPairByIndex.get(pairIndex);
      nextRoundStartTicByPair.set(
        pairIndex,
        computeNextRoundStartTic({
          phase: existing?.phase ?? null,
          currentTic: existing?.current_tic ?? 0,
          roundStartTic: existing?.round_start_tic ?? 0,
          roundLength: state.round_length,
        })
      );
    }

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

    // Start Combat (a pair's own very first round, no existing combat_pairs
    // row) restores that pair's seated characters to full Stamina — a fresh
    // fight starts fresh, even if someone was topped up mid-round from an
    // earlier encounter. Only that pair's first round, not every subsequent
    // Next Round: ongoing Stamina spend across rounds is the whole point of
    // Stamina Cost. Split per-participant now (not one global phase===null
    // branch) since different pairs can each hit their own "first round" at
    // different real-world times.
    const firstRoundParticipants = eligibleParticipants.filter(
      (p) => existingPairByIndex.get(p.pair_index) == null
    );
    const regenParticipants = eligibleParticipants.filter(
      (p) => existingPairByIndex.get(p.pair_index) != null
    );
    // "Fresh" (decided, new): the full restore only happens when the GM has
    // turned Fresh on for this fight. Off — the default — the fight starts
    // with whatever Stamina everyone was already carrying, so consecutive
    // fights wear people down. Filtering to an empty list here is what turns
    // it off: the emit and the UPDATE below are both driven by this array,
    // so nothing else needs a branch.
    const firstRoundChars = state.fresh_start
      ? firstRoundParticipants.map((p) => charById.get(p.character_id)).filter(Boolean)
      : [];
    await Promise.all(
      firstRoundChars
        .filter((c) => c.current_stamina !== c.max_stamina)
        .map((c) => run('UPDATE characters SET current_stamina = ? WHERE id = ?', [c.max_stamina, c.id]))
    );
    for (const c of firstRoundChars) {
      if (c.current_stamina !== c.max_stamina) {
        io.emit('character:updated', { ...c, current_stamina: c.max_stamina });
      }
    }

    // Stamina Regen (decided, new rule): every round from a pair's 2nd on
    // rolls each of its seated characters' Stamina die at its current
    // size/bonus and adds the result to current_stamina, clamped to max —
    // same math/log shape as the manual stamina:regen button, just
    // automatic now and for everyone at once. A pair's round 1 is the Start
    // Combat full-restore above instead (already at max, nothing to regen
    // there).
    const regenRolls = regenParticipants
      .map((p) => charById.get(p.character_id))
      .filter(Boolean)
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

    // Brain rolls per PAIR per side, posted to chat as normal initiative
    // rolls exactly as before — an incapacitated/missing Brain die is
    // silently dropped from its side's initiative, same as pool:roll drops
    // incapacitated dice elsewhere. Grouped by pair_index now instead of
    // pooled across the whole arena, since each pair resolves its own
    // initiative independently.
    // **Initiative gets NO Stance matchup (decided, revised).** It used to,
    // and the two copies of this roll being kept in step about it was itself a
    // bugfix — but Initiative is a pure **Brain** roll, and Brain is one of the
    // two Stats the matchup does not reach at all now (see
    // MATCHUP_EXEMPT_SLOTS in combatBonuses.js: the matchup scores an exchange
    // of styles, and thinking is not part of that exchange). Reasons to Fight
    // and the overflow penalty are untouched and still apply.

    const rollsByPair = new Map(); // pair_index -> { left: [], right: [] }
    for (const p of eligibleParticipants) {
      const die = brainByChar.get(p.character_id);
      const character = charById.get(p.character_id);
      if (!die || die.status !== 'active' || !character) continue;
      // Reasons to Fight applies to Initiative rolls too — "+1 to all rolls
      // during combat" — on every round including the first, same as any
      // other roll. The Stance matchup does NOT; see the note above.
      // The overflow penalty (decided, new rule) subtracts
      // however many of this new round's own Tics are still occupied by
      // this character's own carried-over move, if any (0 on round 1, since
      // there's no previous round to overflow from). Neither ever affects
      // the currentBrain/lockedBrain tie-break values below (those are raw
      // stats) — only the roll itself. Folded into `modifier`, not baked
      // silently into `result`, so the chat log's dice-breakdown display
      // (raw die face + bonus/modifier = result) actually shows it instead
      // of misattributing it to the die face.
      const modifier =
        (p.reasons_to_fight || 0) -
        computeInitiativeOverflowPenalty({
          blockedUntilTic: blockedUntilByChar.get(p.character_id) ?? null,
          nextRoundStartTic: nextRoundStartTicByPair.get(p.pair_index),
        });
      const brainDice = [
        { slot_name: 'Brain', size: die.current_size, bonus: die.bonus, result: rollDie(die.current_size) + die.bonus },
      ];
      const result = rollTotal(brainDice, modifier);
      if (!rollsByPair.has(p.pair_index)) rollsByPair.set(p.pair_index, { left: [], right: [] });
      rollsByPair.get(p.pair_index)[p.side].push({
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
        dice: brainDice,
      });
    }

    const pairDeclaringSide = new Map();
    for (const pairIndex of pairIndices) {
      const pairParticipants = eligibleParticipants.filter((p) => p.pair_index === pairIndex);
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

    // Upsert (not delete-then-insert): a pair's round_number has to persist
    // and increment across presses now that pairs advance independently.
    // nextRoundStartTicByPair was already computed above (needed earlier,
    // by the Brain-roll loop's overflow penalty) — floored a full
    // round_length past that pair's own previous round start, not just set
    // to wherever its current_tic happens to sit, so a round that never
    // actually finished its own Tic Countdown (or only partially did) can't
    // leave its declared moves' Tics "occupied" again in the new round.
    // current_tic is advanced to match, keeping it in sync with the new
    // round_start_tic.
    await Promise.all(
      pairIndices.map((pairIndex) => {
        const nextRoundStartTic = nextRoundStartTicByPair.get(pairIndex);
        const existing = existingPairByIndex.get(pairIndex);
        const nextRoundNumber = (existing?.round_number ?? 0) + 1;
        return existing
          ? run(
              `UPDATE combat_pairs
               SET declaring_side = ?, round_number = ?, phase = 'declaration',
                   round_start_tic = ?, current_tic = ?
               WHERE pair_index = ?`,
              [pairDeclaringSide.get(pairIndex), nextRoundNumber, nextRoundStartTic, nextRoundStartTic, pairIndex]
            )
          : run(
              `INSERT INTO combat_pairs
                 (pair_index, declaring_side, round_number, phase, round_start_tic, current_tic)
               VALUES (?, ?, ?, 'declaration', ?, ?)`,
              [pairIndex, pairDeclaringSide.get(pairIndex), nextRoundNumber, nextRoundStartTic, nextRoundStartTic]
            );
      })
    );
    await Promise.all(
      eligibleParticipants.map((p) =>
        run('UPDATE combat_participants SET declared_this_round = 0 WHERE character_id = ?', [p.character_id])
      )
    );

    await emitCombatUpdated();
  });

  on('move:declare', async ({ characterId, moveId, placementTic: requestedPlacementTic, appendageChoice, targetCharacterId }) => {
    // The three lookups below are all independent of each other (none reads
    // a value the others produce), so they run as one round trip instead
    // of three sequential ones; `pair` depends on participant.pair_index so
    // it has to wait for that one to land first.
    const [participant, character, move] = await Promise.all([
      one('SELECT * FROM combat_participants WHERE character_id = ?', [characterId]),
      getCharacter(characterId),
      one('SELECT * FROM moves WHERE id = ?', [moveId]),
    ]);
    // Declaration runs independently per pair now (Phase 9 combat redesign,
    // Combat Automation overhaul) — a character may only declare while
    // their OWN pair is in its Declaration phase AND that pair's own
    // declaring_side matches their own side, and only until they
    // themselves have pressed "done declaring" for the round
    // (declared_this_round).
    if (!participant || participant.declared_this_round) return;
    const pair = await one('SELECT * FROM combat_pairs WHERE pair_index = ?', [participant.pair_index]);
    if (!pair || pair.phase !== 'declaration' || pair.declaring_side !== participant.side) return;
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

    // **Uneven Combat: who this move is coming for (decided, new).** Accepted
    // only when it names someone actually seated on the other side of this
    // pair; anything else is stored as NULL and the engine falls back to its
    // own deterministic rule. Not a rejection — a stale pick is a worse reason
    // to refuse a declaration than it is to ignore.
    const opposingSide = participant.side === 'left' ? 'right' : 'left';
    const targetSeat = Number.isInteger(targetCharacterId)
      ? await one(
          'SELECT character_id FROM combat_participants WHERE character_id = ? AND pair_index = ? AND side = ?',
          [targetCharacterId, participant.pair_index, opposingSide]
        )
      : null;
    const storedTargetId = targetSeat ? targetSeat.character_id : null;

    // **A Movement move needs both Legs (decided, new).** Silent no-op like
    // every other rejection here; the picker greys it and says why, so reaching
    // this line means a stale view or a hand-sent event.
    const legStatuses = (await all(
      "SELECT status FROM dice WHERE character_id = ? AND slot_name IN ('Left Leg', 'Right Leg')",
      [character.id]
    )).map((d) => d.status);
    // Resolved once and reused: the leg gate needs it, and so does the Off The
    // Ground floor below. A Perk may add or strip a Tag, so this is the
    // per-character resolved set, never the move template's raw list.
    const declaredTagNames = await moveTagNamesFor(character.id, move.id);
    if (movementBlockedByLegs({ tagNames: declaredTagNames, legStatuses })) {
      return;
    }

    // **A Move that swings a weapon needs one in hand (decided, new).** The
    // Weapon Roll slot resolves to whatever the character is carrying, and a
    // fighter carrying nothing would simply roll one die fewer — a move quietly
    // worth less than it says it is, which is exactly the kind of silence this
    // engine keeps having to be taught not to do. Refused instead, and the
    // picker greys the card the same way it greys a Movement move on a broken
    // leg, so this line is only ever reached by a stale view.
    if (move.roll_type !== 'custom') {
      const rollsWeapon = await one(
        'SELECT 1 AS yes FROM move_roll_slots WHERE move_id = ? AND slot_name = ?',
        [move.id, WEAPON_SLOT]
      );
      if (rollsWeapon && !(await getWeapon(character.id))) return;
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
        // dm.move_id rides along for the Requirement gate below: the move
        // whose footprint ends last IS the one this declaration would come
        // right after, which is exactly what a Requirement asks about.
        `SELECT dm.move_id, dm.trip_recovery_tics,
                (dm.reveal_tic + m.active_tics + m.recovery_tics + dm.recovery_extension_tics) AS blocked_until_tic
         FROM declared_moves dm JOIN moves m ON m.id = dm.move_id
         WHERE dm.character_id = ?
         ORDER BY blocked_until_tic DESC LIMIT 1`,
        [character.id]
      ),
    ]);
    // The effective cost, not the column — see resolveStaminaCosts. Getting
    // this one wrong is the visible failure: the picker would offer a Dodge as
    // affordable and this would silently refuse it.
    const declareCost = await getEffectiveStaminaCost(character.id, move);
    if (character.current_stamina - pending - declareCost < 0) return;

    // Requirement (decided, new): this move may only be thrown IMMEDIATELY
    // after the one it names — "not later, not without it, but right after".
    //
    // The queue is checked, not the outcome: whether that earlier move
    // actually connected is unknowable here, because a round is declared in
    // full before any of it resolves. Gating on a hit would mean striking a
    // declared move mid-resolution, which is the rollback problem Grappling
    // deliberately designed itself out of.
    //
    // Silent no-op on failure, matching every other rejection in this handler
    // (unavailable move, wrong stance, unaffordable). The declare picker
    // greys these out client-side, so reaching here means a stale view or a
    // hand-sent event.
    if (
      !declarableByHand({
        isSecondary: Boolean(move.is_secondary),
        requirementMoveId: move.requirement_move_id,
        previousMoveId: last?.move_id ?? null,
      })
    ) {
      return;
    }

    // A player can drag a move onto any Tic they like on the Tic Counter —
    // never earlier than the character's own next-eligible Tic, which is
    // why this is a floor, not an exact placement: dropping too early just
    // snaps forward to the earliest legal Tic instead of failing. That
    // floor is the previous move's full footprint end (Startup+Active+
    // Recovery, not just Startup) — a new move can't be placed while an
    // earlier one is still active or recovering (revised: an earlier
    // version of this rule blocked only through Startup, letting a
    // still-Active/Recovering move get silently overlapped by a new one).
    // **Off The Ground (decided, new).** A move carrying the Tag may start
    // early enough that its Startup overlaps the trip frames this character is
    // already lying in — you are getting up as you wind up. Two caps, both in
    // `placementFloorAfterTrip`: never further back than the trip window
    // itself (ordinary Recovery is still untouchable) and never more than this
    // move's own Startup (its Active frames cannot begin before you are back
    // on your feet).
    //
    // The floor only, exactly like every other rule here — the round's own
    // start Tic still wins, so this can never reach back into a previous round.
    const previousBlockedUntilTic = last
      ? placementFloorAfterTrip({
          blockedUntilTic: last.blocked_until_tic,
          tripRecoveryTics: last.trip_recovery_tics ?? 0,
          startupTics: move.startup_tics,
          offTheGround: carriesOffTheGroundTag(declaredTagNames),
        })
      : null;
    const minPlacementTic = computePlacementTic({
      roundStartTic: pair.round_start_tic,
      previousBlockedUntilTic,
    });
    // A Requirement move doesn't get to pick its Tic: "right after" is a
    // timing claim, not just an ordering one, so it starts exactly where the
    // required move's footprint ends and the dragged Tic is ignored. For
    // everything else the drop is honored as a floor, snapping forward when
    // it lands too early. Both cases end at the same expression when the
    // player drags onto the earliest legal square anyway — the difference is
    // that a Requirement move cannot be held back for a later one.
    const placementTic =
      move.requirement_move_id != null || !Number.isInteger(requestedPlacementTic)
        ? minPlacementTic
        : Math.max(requestedPlacementTic, minPlacementTic);
    const { revealTic } = computeMoveFootprint({
      placementTic,
      startupTics: move.startup_tics,
      activeTics: move.active_tics,
      recoveryTics: move.recovery_tics,
    });
    const countRow = await one(
      'SELECT COUNT(*) AS count FROM declared_moves WHERE character_id = ? AND round_number = ?',
      [character.id, pair.round_number]
    );
    const queueOrder = countRow.count + 1;

    // Feint Tag (decided, new): "show the Feint Tell like a normal move, then
    // if a Move is placed RIGHT AFTER it, it is hidden." Two conditions, both
    // required, and both asked here once rather than re-derived on every read
    // (see the column's comment in db.js for why it is frozen):
    //
    //   1. the move this one comes right after carries the Feint Tag — the
    //      same `last` row and the same "right after" the Requirement gate
    //      above already uses, and the same per-character resolved tag set
    //      the rest of tag automation reads (a Perk may grant or strip it);
    //   2. it is contiguous in time — it starts exactly where the Feint's
    //      own frames end (feintMasksDeclaration).
    //
    // A move with no Feint before it takes the default 0 and nothing changes.
    // The tag lookup is skipped entirely in that overwhelmingly common case,
    // so an ordinary declaration costs no extra query.
    const feintMasked =
      last != null &&
      placementTic === last.blocked_until_tic &&
      feintMasksDeclaration({
        previousCarriesFeint: carriesFeintTag(await moveTagNamesFor(character.id, last.move_id)),
        previousFootprintEndTic: last.blocked_until_tic,
        placementTic,
      });

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

    // **Grounding (decided, new).** The move puts its own user on the floor:
    // every Recovery frame it has is a Trip Recovery frame instead of an
    // ordinary one. Written here, from the same per-character resolved tag set
    // every other Tag mechanic reads (a Perk may grant or strip it), and frozen
    // onto the row like every other declare-time snapshot — editing the
    // template's Recovery afterwards must not reach into an attack already on
    // the clock.
    //
    // It is the only thing that writes this column at declare time; Movement
    // Punisher adds to it mid-round, from the other side of the fight.
    const groundingTripTics = groundingTripRecoveryTics({
      tagNames: declaredTagNames,
      recoveryTics: move.recovery_tics,
    });
    await run(
      `INSERT INTO declared_moves (character_id, move_id, round_number, queue_order, placement_tic, reveal_tic, appendage_choice, effective_attack_targets, attack_target_source, feint_masked, target_character_id, trip_recovery_tics)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'move', ?, ?, ?)`,
      [character.id, move.id, pair.round_number, queueOrder, placementTic, revealTic, storedAppendageChoice, JSON.stringify(effectiveAttackTargets), feintMasked ? 1 : 0, storedTargetId, groundingTripTics]
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
    // + the move's own Active/Recovery, for the Feint un-masking below.
    const row = await one(
      `SELECT dm.*, m.active_tics, m.recovery_tics
       FROM declared_moves dm JOIN moves m ON m.id = dm.move_id WHERE dm.id = ?`,
      [declaredMoveId]
    );
    if (!row || row.stamina_committed) return;
    const participant = await one('SELECT pair_index FROM combat_participants WHERE character_id = ?', [
      row.character_id,
    ]);
    const pair = participant
      ? await one('SELECT phase FROM combat_pairs WHERE pair_index = ?', [participant.pair_index])
      : null;
    if (!pair || pair.phase !== 'declaration') return;
    await run('DELETE FROM declared_moves WHERE id = ?', [row.id]);
    // Feint Tag: whatever was declared right after this one was masked BY
    // this one (see feint_masked in move:declare — the flag is frozen at
    // declare time, so nothing else would ever unset it). Taking the Feint
    // back has to take its concealment back too, or a player could feint,
    // hide their real move behind it, then undeclare the feint and keep the
    // free invisibility. Unconditional: clearing a flag that is already 0 on
    // a non-Feint's follow-up costs nothing.
    const footprintEnd =
      row.reveal_tic + row.active_tics + row.recovery_tics + row.recovery_extension_tics;
    await run(
      'UPDATE declared_moves SET feint_masked = 0 WHERE character_id = ? AND placement_tic = ? AND id <> ?',
      [row.character_id, footprintEnd, row.id]
    );
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
    const participant = await one('SELECT * FROM combat_participants WHERE character_id = ?', [characterId]);
    if (!participant || participant.declared_this_round) return;
    const pair = await one('SELECT * FROM combat_pairs WHERE pair_index = ?', [participant.pair_index]);
    if (!pair || pair.phase !== 'declaration' || pair.declaring_side !== participant.side) return;

    // Commit this character's own pending moves' Stamina Cost now — this is
    // the one and only place cost actually leaves/returns to
    // current_stamina (move:declare only ever checked affordability).
    // Clamped defensively to [0, max]; the up-front affordability check
    // already keeps this from going negative in the normal flow. Per
    // character now rather than batched per side, since declaring itself is.
    // Through the same resolver the picker and the affordability check use, so
    // what is actually spent is the number the player was shown.
    const [pending, character] = await Promise.all([
      getPendingStaminaCost(characterId),
      getCharacter(characterId),
    ]);
    if (character && pending !== 0) {
      const newStamina = clamp(character.current_stamina - pending, 0, character.max_stamina);
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
    let resolveNow = false;
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
      // Combat Automation overhaul §2.1: a pair whose declaring_side just
      // cleared is fully done declaring, so it drops straight into
      // Resolving and its round resolves itself — this is what replaced
      // the manual "Start Tic Countdown" button, which no longer exists.
      resolveNow = nextDeclaringSide === null;
      await run('UPDATE combat_pairs SET declaring_side = ?, phase = ? WHERE pair_index = ?', [
        nextDeclaringSide,
        resolveNow ? 'resolving' : 'declaration',
        participant.pair_index,
      ]);
    }

    await emitCombatUpdated();

    if (resolveNow) {
      // Runs this pair's whole round synchronously — to completion, or to
      // the first Dodge/move-conflict pause. Every round_event it produces
      // is pushed to that pair's audience as it's persisted, so clients
      // are already animating while this is still running; the engine
      // itself applies no artificial pacing (all pacing is a client
      // concern — see the plan's core architecture principle). Other pairs
      // are untouched and keep running independently.
      //
      // **Awaiting this costs the caller nothing, which is worth writing down
      // because it looks like it should.** Socket.io does not serialise a
      // socket's handlers — it invokes each one and ignores the returned
      // promise — so a long `await` here has never held up the next event from
      // this or any other client. Detaching it was tried and reverted: it
      // bought no responsiveness and opened a window for two resolutions of
      // the same pair to overlap. The way to make this faster is to make the
      // round shorter, not to look away while it runs.
      await advancePairResolution(participant.pair_index, io);
      // The engine moves current_tic, and on a clean finish rolls this
      // pair into its next round's Declaration phase — the snapshot every
      // client holds is stale by now either way.
      await emitCombatUpdated();
    }
  });

  // Combat Automation overhaul §3 — the GM's answer to a full-coverage
  // Dodge prompt: the one human decision left in an otherwise fully
  // automatic round (decision #2). Block resolves itself from dice math
  // and never prompts; a Dodge that isn't fully covering the attack's
  // Active window auto-fails without prompting either. GM-only by design —
  // this is explicitly the GM's call, so a Player socket can't answer it
  // even if they somehow received the prompt.
  //
  // Applying the decision and resuming the paused round both happen inside
  // resolveDodge, which also rejects a stale/duplicate click from a second
  // GM tab (see its own guard).
  on('combat:resolve_dodge', async ({ pairIndex, outcome, attackerDeclaredMoveId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    await resolveDodge(pairIndex, { outcome, attackerDeclaredMoveId }, io);
    await emitCombatUpdated();
  });

  // The same call for a Block (decided, reversed — Block used to resolve with
  // no human input at all). Identical shape, identical GM-only gate, and
  // resolveBlock owns the same stale-click rejection resolveDodge does.
  on('combat:resolve_block', async ({ pairIndex, outcome, attackerDeclaredMoveId }) => {
    if (socket.data.identity?.role !== 'gm') return;
    await resolveBlock(pairIndex, { outcome, attackerDeclaredMoveId }, io);
    await emitCombatUpdated();
  });

  // **The manual way back to a pause (decided, new).** Everything around this
  // is automatic and, after the delivery rework, should never need it — but
  // "should never" is how a table ends up with a fight paused, no prompt on any
  // screen, and nobody able to go on, which is exactly what was reported from
  // play. GM Tools' **Fight Pauses** reads this.
  //
  // Read-only: it re-sends and re-describes, and resolves nothing. It answers
  // with every pause currently open, each already shaped into the question it
  // is asking, so the tool can put the dialog back up from the server's own
  // answer *without going through the combat snapshot at all*. That
  // independence is the whole point — a fallback that shares its plumbing with
  // the thing it is backing up is not a fallback.
  //
  // Grappling's pause is listed but never carries its payload: the directions
  // are the mini-game, they differ per viewer, and this is one socket asking.
  on('combat:resummon_pause', async () => {
    if (socket.data.identity?.role !== 'gm') return;
    const rows = await all(
      `SELECT id, pair_index, round_number, status, pending_dodge_json, pending_defense_json,
              pending_conflict_json, pending_grapple_json
         FROM pair_round_resolutions
        WHERE status LIKE 'paused_%'
        ORDER BY pair_index`
    );
    const parse = (json) => {
      try {
        return json ? JSON.parse(json) : null;
      } catch {
        return null;
      }
    };
    const pauses = [];
    for (const row of rows) {
      const base = { pairIndex: row.pair_index, roundNumber: row.round_number, status: row.status };
      if (row.status === 'paused_dodge' || row.status === 'paused_defense') {
        const kind = row.status === 'paused_dodge' ? 'dodge' : 'block';
        const stored = parse(kind === 'dodge' ? row.pending_dodge_json : row.pending_defense_json);
        const prompt = defensePromptPayload(stored, kind);
        if (!prompt) continue;
        const line = prompt.targetSlotName ? ` — the strike to ${prompt.targetSlotName}` : '';
        pauses.push({
          ...base,
          kind,
          answeredBy: 'gm',
          gmCanAnswer: true,
          prompt,
          summary: `${prompt.defenderCharacterName ?? 'The defender'} ${
            kind === 'dodge' ? 'dodging' : 'blocking'
          } ${prompt.attackerCharacterName ?? 'the attacker'}${line}`,
        });
      } else if (row.status === 'paused_conflict') {
        const conflict = parse(row.pending_conflict_json);
        if (!conflict) continue;
        // Whose call it is decides whether the tool offers to summon it at all:
        // the GM runs the NPCs, but a PC's commitment is that player's to spend.
        // Worked out here because this is the layer that knows what a character
        // is — the tool would only be guessing.
        const fighter = conflict.characterId != null ? await getCharacter(conflict.characterId) : null;
        pauses.push({
          ...base,
          kind: 'conflict',
          answeredBy: 'fighter',
          gmCanAnswer: fighter?.character_type === 'npc',
          conflict,
          summary: `${conflict.characterName ?? 'A fighter'} — ${
            conflict.blockerMoveName ? `“${conflict.blockerMoveName}”` : 'a guard'
          } held longer and ran into what came next`,
        });
      } else if (row.status === 'paused_grapple') {
        const grapple = parse(row.pending_grapple_json);
        pauses.push({
          ...base,
          kind: 'grapple',
          answeredBy: 'fighter',
          // Never summonable: the directions are the mini-game and they differ
          // per viewer, so there is no single prompt to hand to one socket.
          gmCanAnswer: false,
          summary:
            grapple?.phase === 'guess'
              ? `${grapple?.targetCharacterName ?? 'The target'} still has to guess where the grapple goes`
              : `${grapple?.grapplerCharacterName ?? 'The grappler'} still has to pick where the grapple goes`,
        });
      }
    }
    // The ordinary path gets first refusal: re-push the snapshot, so if it was
    // only ever a missed broadcast the dialog is back before the GM reads the
    // list at all.
    await emitCombatUpdatedTo(socket);
    socket.emit('combat:pauses', { pauses });
  });

  // Grappling's mini-game — the app's first genuinely TWO-party pause. The
  // grappler picks a direction in secret; the target guesses it. Two events
  // rather than one because two different people answer, each owning their
  // own half, and **neither half resolves anything on its own**: the contest
  // waits until both are in, so whoever clicks first learns nothing from
  // having clicked.
  //
  // Ownership is the app's canonical predicate — a Player owns their own
  // character, the GM owns every NPC — checked here because this is the only
  // layer that knows who a socket is. An answer from anyone else is dropped
  // silently, the same way move:declare treats a declaration for a character
  // the caller doesn't own.
  const ownsCharacter = async (characterId) => {
    const identity = socket.data.identity;
    if (!identity || characterId == null) return false;
    if (identity.role === 'player') return identity.characterId === characterId;
    const ch = await getCharacter(characterId);
    return ch?.character_type === 'npc';
  };

  const answerGrappleHalf = async (half, { pairIndex, direction, grapplerDeclaredMoveId }) => {
    const resolution = await one(
      `SELECT pending_grapple_json FROM pair_round_resolutions
       WHERE pair_index = ? AND status = 'paused_grapple'`,
      [pairIndex]
    );
    if (!resolution?.pending_grapple_json) return;
    const pending = JSON.parse(resolution.pending_grapple_json);
    const mustOwn = half === 'choice' ? pending.grapplerCharacterId : pending.targetCharacterId;
    if (!(await ownsCharacter(mustOwn))) return;

    const { ready } = await answerGrapple(pairIndex, { half, direction, grapplerDeclaredMoveId }, io);
    // Broadcast either way: the answerer's own prompt has to stop asking, and
    // the per-viewer mapping makes sure that does not tell the other side
    // anything (see mapPendingGrappleForViewer).
    await emitCombatUpdated();
    if (ready) {
      await resumeGrapple(pairIndex, io);
      await emitCombatUpdated();
    }
  };

  on('combat:grapple_choose', (payload) => answerGrappleHalf('choice', payload ?? {}));
  on('combat:grapple_guess', (payload) => answerGrappleHalf('guess', payload ?? {}));

  // Combat Automation overhaul §3 — Forfeit/Postpone for a declared move a
  // Block's extended Recovery ran into. Payload shape and audience are
  // deliberately unchanged (decision #3: this stays the *affected player's*
  // call, not the GM's); only the trigger moved. The automatic engine is
  // now the sole source of these prompts — the old manual path that used to
  // live here went away with combat:resolve_defense — so this just resolves
  // which paused pair the answer belongs to and hands off. resolveMoveConflict
  // owns applying the choice, resuming the round, and re-pausing if the
  // postponed move collides with yet another declared move.
  //
  // Parsed in JS rather than via json_extract to avoid depending on libSQL's
  // JSON1 surface for a list that is at most one row per pair.
  on('combat:resolve_move_conflict', async ({ declaredMoveId, choice }) => {
    // Defence rework decision #4 renamed the two answers: 'postpone' became
    // 'extend', because it no longer slides one move — it wears the guard's
    // extension and pushes the whole queue back.
    if (!['forfeit', 'extend'].includes(choice)) return;
    const pausedRows = await all(
      `SELECT pair_index, pending_conflict_json FROM pair_round_resolutions WHERE status = 'paused_conflict'`
    );
    const pausedPair = pausedRows.find((r) => {
      try {
        return JSON.parse(r.pending_conflict_json)?.declaredMoveId === declaredMoveId;
      } catch {
        return false;
      }
    });
    if (!pausedPair) return;
    await resolveMoveConflict(pausedPair.pair_index, { declaredMoveId, choice }, io);
    await emitCombatUpdated();
  });
});

// ---------- static frontend ----------

const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// Pull the embedded replica up to date before touching the schema — see
// syncReplica in db.js for why an unsynced replica must never reach initDb.
// A no-op (and instant) when running against a plain local file.
//
// Deliberately fatal. The alternative is a server that came up holding an
// empty replica, whose seed functions would then look at a world with no
// ruleset, no Tells and no Perks and helpfully write a second copy of all
// three into the primary.
let syncMs = null;
try {
  syncMs = await syncReplica();
} catch (err) {
  console.error(
    'Could not sync the embedded replica from the Turso primary, so the server is stopping ' +
      'rather than starting against an empty database.\n' +
      'Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, and that the primary is reachable.\n',
    err
  );
  process.exit(1);
}
console.log(
  syncMs == null
    ? 'Database: local file (no replica)'
    : `Database: embedded replica with offline writes, synced from the primary in ${syncMs}ms — ` +
      `reads AND writes are local, pushed every ${SYNC_SECONDS}s`
);

// **The alarm (Phase 5).** Offline writes bound a crash to one sync window
// *only while the push is actually succeeding*. A sync that starts failing
// quietly — expired token, network partition — looks exactly like a sync that
// is working, right up until Render recycles the container and takes the whole
// unsynced backlog with it. So a health *change* is announced in both
// directions: it goes to the server log, and to every connected client, which
// puts it in front of the one person who can do something about it.
let syncsLogged = 0;
if (
  startSyncLoop((health) => {
    if (health.healthy) {
      console.log(`Database: sync to the primary recovered after ${health.consecutiveFailures} failure(s)`);
    } else {
      console.error(
        `Database: NOT syncing to the primary — ${health.consecutiveFailures} consecutive failures, ` +
          `last success ${health.staleSeconds ?? 'never'}s ago. Local writes are accumulating and ` +
          `will be LOST if this container restarts. Last error: ${health.lastError}`
      );
    }
    io.emit('db:sync_health', health);
  },
  (health) => {
    // How long a real sync against the real primary costs was the one number
    // this could not be reasoned about without — `db.sync()` blocks the event
    // loop for exactly this long, so it is also the length of time the server
    // answers nothing. Logged for the first few, then only when it is slow
    // enough to have widened the interval, so a healthy server stays quiet.
    const slow = health.nextInSeconds > health.everySeconds;
    if (syncsLogged < 5 || slow) {
      syncsLogged += 1;
      console.log(
        `Database: sync took ${health.lastSyncMs}ms` +
          (slow ? ` — slow, so the next one is in ${health.nextInSeconds}s instead of ${health.everySeconds}s` : '')
      );
    }
  })
) {
  // Render sends SIGTERM before recycling a service, which is the one moment a
  // final push is both possible and worth the most — it turns the common,
  // planned case (a redeploy, a free-tier spin-down) from "lose up to one
  // window" into "lose nothing". Best effort and time-boxed: a shutdown that
  // hangs waiting on an unreachable primary is worse than one that gives up.
  let shuttingDown = false;
  const flushAndExit = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — pushing unsynced writes to the primary before exit`);
    try {
      await Promise.race([syncOnce(), new Promise((r) => setTimeout(r, 5000))]);
      console.log('Final sync complete');
    } catch (err) {
      console.error('Final sync failed; the last writes may be lost:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => flushAndExit('SIGTERM'));
  process.on('SIGINT', () => flushAndExit('SIGINT'));
}

await initDb();
// Chat is intentionally ephemeral — see chat:clear below — and clearing it
// on every boot doubles as clearing it between sessions on Render's free
// tier, which spins the server down after inactivity.
await run('DELETE FROM chat_log');
// Combat Automation overhaul §2.4 — crash recovery. Render's free tier can
// sleep or cold-start mid-round; any pair left mid-resolution picks up from
// its own resolved_through_tic and runs to completion (or back to a
// genuine Dodge/conflict pause, both of which are DB-durable and so
// survived the restart intact). Deliberately not awaited before listen():
// a pair that can't finish resolving must not stop the server from coming
// up, and the sweep needs no client to be connected to make progress.
resumeAllPairsOnBoot(io).catch((err) => {
  console.error('Failed to resume in-flight round resolutions on boot:', err);
});
httpServer.listen(PORT, () => {
  console.log(`Dogfight server listening on port ${PORT}`);
});
