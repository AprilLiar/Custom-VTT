import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { db, all, one, run, initDb } from './db.js';
import {
  DICE_TEMPLATE,
  clamp,
  clampModifier,
  computeMaxStamina,
  rollDie,
  stepDie,
} from './gameLogic.js';
import {
  clampFrame,
  validFrames,
  normalizeInteractions,
  clampRollBonus,
  sanitizeRollSlots,
  hasAmbiguousRollSlot,
  AMBIGUOUS_ROLL_SLOTS,
} from './moveLogic.js';
import { effectiveFrames, PERK_HOOKS } from './perkAutomations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '3mb' })); // portraits arrive as base64 JSON
const httpServer = createServer(app);
// Exported so a future server/perkAutomations.js PERK_HOOKS entry can
// broadcast (die:updated/character:updated/etc.) after a manual effect.
export const io = new Server(httpServer);

// ---------- shared lookups ----------

const getCharacter = (id) => one('SELECT * FROM characters WHERE id = ?', [id]);
const getDice = (characterId) =>
  all('SELECT * FROM dice WHERE character_id = ? ORDER BY id', [characterId]);
const getInventory = (characterId) =>
  all('SELECT * FROM inventory_items WHERE character_id = ? ORDER BY id', [characterId]);
const getInjuries = (characterId) =>
  all('SELECT * FROM injuries WHERE character_id = ? ORDER BY id', [characterId]);
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
});

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC
const sqliteToIso = (ts) =>
  ts && !ts.includes('T') ? new Date(ts.replace(' ', 'T') + 'Z').toISOString() : ts;

// Broadcasts the Combat Arena's current seating + toggle — called from the
// combat:* socket handlers below and from character delete (a seated
// character leaving the roster needs the arena to drop them too).
async function emitCombatUpdated() {
  const state = await one('SELECT * FROM combat_state WHERE id = 1');
  const participants = await all(
    'SELECT * FROM combat_participants ORDER BY side, pair_index, id'
  );
  io.emit('combat:updated', {
    unevenCombatEnabled: Boolean(state.uneven_combat_enabled),
    participants,
  });
}

async function logRoll({ characterId, characterName, modifier, dice }) {
  const total = dice.reduce((sum, d) => sum + d.result, 0);
  await run('INSERT INTO chat_log (character_id, dice_rolled, modifier) VALUES (?, ?, ?)', [
    characterId,
    JSON.stringify(dice),
    modifier,
  ]);
  io.emit('roll:result', {
    characterId,
    characterName,
    modifier,
    dice,
    total,
    timestamp: new Date().toISOString(),
  });
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
  res.json(await all('SELECT * FROM characters ORDER BY id'));
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
// character:updated/die:updated/stance:activated broadcasts), and every
// counter relevant to the arena (standalone ones, plus any character
// counter flagged Show in Combat).
app.get('/api/combat', wrap(async (_req, res) => {
  const [state, participants] = await Promise.all([
    one('SELECT * FROM combat_state WHERE id = 1'),
    all('SELECT * FROM combat_participants ORDER BY side, pair_index, id'),
  ]);

  const charIds = [...new Set(participants.map((p) => p.character_id))];
  const marks = charIds.map(() => '?').join(',');

  // Batched IN-clause lookups instead of a per-participant loop — this used
  // to be 3 sequential queries PER seated character (a real N+1 against
  // Turso's networked connection, and the main cause of "adding a
  // character takes ~4 seconds"); now it's 3 total, run concurrently,
  // regardless of how many are seated.
  const [charRows, diceRows, stanceRows, counters] = await Promise.all([
    charIds.length ? all(`SELECT * FROM characters WHERE id IN (${marks})`, charIds) : [],
    charIds.length ? all(`SELECT * FROM dice WHERE character_id IN (${marks}) ORDER BY id`, charIds) : [],
    charIds.length ? all(`SELECT * FROM stances WHERE character_id IN (${marks}) ORDER BY id`, charIds) : [],
    charIds.length
      ? all(
          `SELECT * FROM counters WHERE character_id IS NULL OR (show_in_combat = 1 AND character_id IN (${marks})) ORDER BY id`,
          charIds
        )
      : all('SELECT * FROM counters WHERE character_id IS NULL ORDER BY id'),
  ]);

  const characters = {};
  for (const character of charRows) {
    characters[character.id] = { character, dice: [], stances: [] };
  }
  for (const die of diceRows) characters[die.character_id]?.dice.push(die);
  for (const stance of stanceRows) characters[stance.character_id]?.stances.push(stance);

  res.json({
    unevenCombatEnabled: Boolean(state.uneven_combat_enabled),
    participants,
    characters,
    counters,
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
    SELECT c.id, c.character_id, c.modifier, c.dice_rolled, c.created_at,
           ch.name AS character_name
    FROM chat_log c
    LEFT JOIN characters ch ON ch.id = c.character_id
    ORDER BY c.id
  `);
  res.json(
    rows.map((row) => {
      const dice = JSON.parse(row.dice_rolled);
      return {
        id: row.id,
        characterId: row.character_id,
        characterName: row.character_name ?? '(deleted)',
        modifier: row.modifier,
        dice,
        total: dice.reduce((sum, d) => sum + d.result, 0),
        timestamp: sqliteToIso(row.created_at),
      };
    })
  );
}));

// ---------- Socket.io game events ----------

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

  on('die:roll', async ({ characterId, dieId, modifier }) => {
    const die = await one('SELECT * FROM dice WHERE id = ? AND character_id = ?', [
      dieId,
      characterId,
    ]);
    if (!die || die.status !== 'active') return;
    const character = await getCharacter(die.character_id);
    if (!character) return;
    const mod = clampModifier(modifier);
    const result = rollDie(die.current_size) + die.bonus + mod;
    await logRoll({
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      dice: [{ slot_name: die.slot_name, size: die.current_size, bonus: die.bonus, result }],
    });
  });

  // Selection-based pool roll: any set of the character's dice, rolled
  // together with one shared modifier (not tied to a body section).
  on('pool:roll', async ({ characterId, dieIds, modifier }) => {
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
    const mod = clampModifier(modifier);
    await logRoll({
      characterId: character.id,
      characterName: character.name,
      modifier: mod,
      dice: dice.map((d) => ({
        slot_name: d.slot_name,
        size: d.current_size,
        bonus: d.bonus,
        result: rollDie(d.current_size) + d.bonus + mod,
      })),
    });
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

  on('character:lock_stats', async ({ characterId }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    await run(
      'UPDATE dice SET locked_size = current_size, locked_bonus = bonus, locked_status = status WHERE character_id = ?',
      [character.id]
    );
    const stamina = await getStaminaDie(character.id);
    const maxStamina = computeMaxStamina(
      character.stamina_multiplier,
      stamina.current_size,
      stamina.bonus
    );
    const currentStamina = Math.min(character.current_stamina, maxStamina);
    await run('UPDATE characters SET max_stamina = ?, current_stamina = ? WHERE id = ?', [
      maxStamina,
      currentStamina,
      character.id,
    ]);
    io.emit('character:updated', await getCharacter(character.id));
    for (const die of await getDice(character.id)) io.emit('die:updated', diePayload(die));
  });

  on('character:revert_stats', async ({ characterId }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    await run(
      'UPDATE dice SET current_size = locked_size, bonus = locked_bonus, status = locked_status WHERE character_id = ?',
      [character.id]
    );
    for (const die of await getDice(character.id)) io.emit('die:updated', diePayload(die));
  });

  on('stamina:regen', async ({ characterId }) => {
    const character = await getCharacter(characterId);
    if (!character) return;
    const stamina = await getStaminaDie(character.id);
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
    io.emit('character:updated', await getCharacter(character.id));
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
    io.emit('character:updated', await getCharacter(character.id));
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
    const isDefault = payload.isDefault ? 1 : 0;
    const isDefensive = payload.isDefensive ? 1 : 0;
    const description = String(payload.description ?? '').trim();

    // Roll is optional — a move with no slots has no Roll at all. An
    // ambiguous Hand/Leg slot means this move needs two Tells (one per
    // appendage choice) instead of the usual one.
    const rollModifier = clampRollBonus(payload.rollModifier);
    const rollSlots = sanitizeRollSlots(payload.rollSlots);
    const ambiguousRoll = hasAmbiguousRollSlot(rollSlots);

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

    // Style: one of the 7 (required for new moves; legacy rows may be NULL)
    let styleId = null;
    if (payload.styleAttributeId != null) {
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
          description, style_attribute_id, folder_id, image_data, image_mime_type, roll_modifier,
          right_tell_id, left_tell_id, is_defensive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, isDefault, tellId, startup, active, recovery, description, styleId, folderId,
          payload.imageData ?? null, payload.imageData ? (payload.imageMimeType ?? 'image/png') : null,
          rollModifier, rightTellId, leftTellId, isDefensive]
      );
      id = Number(result.lastInsertRowid);
    } else {
      await run(
        `UPDATE moves SET name = ?, is_default = ?, tell_id = ?, startup_tics = ?, active_tics = ?,
          recovery_tics = ?, description = ?, style_attribute_id = ?, folder_id = ?, roll_modifier = ?,
          right_tell_id = ?, left_tell_id = ?, is_defensive = ?
          WHERE id = ?`,
        [name, isDefault, tellId, startup, active, recovery, description, styleId, folderId,
          rollModifier, rightTellId, leftTellId, isDefensive, id]
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
    io.emit('character:updated', await getCharacter(character.id));
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

  on('injury:add', async ({ characterId, name, effect }) => {
    const character = await getCharacter(characterId);
    const injuryName = String(name ?? '').trim();
    if (!character || !injuryName) return;
    await run('INSERT INTO injuries (character_id, name, effect) VALUES (?, ?, ?)', [
      character.id,
      injuryName,
      String(effect ?? '').trim(),
    ]);
    io.emit('injuries:updated', {
      characterId: character.id,
      injuries: await getInjuries(character.id),
    });
  });

  on('injury:update', async ({ injuryId, name, effect }) => {
    const injury = await one('SELECT * FROM injuries WHERE id = ?', [injuryId]);
    const injuryName = String(name ?? '').trim();
    if (!injury || !injuryName) return;
    await run('UPDATE injuries SET name = ?, effect = ? WHERE id = ?', [
      injuryName,
      String(effect ?? '').trim(),
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
  on('counter:create', async ({ characterId, name, targetPips }) => {
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
    const result = await run(
      'INSERT INTO counters (character_id, name, target_pips) VALUES (?, ?, ?)',
      [charId, counterName, target]
    );
    io.emit('counter:created', await one('SELECT * FROM counters WHERE id = ?', [
      Number(result.lastInsertRowid),
    ]));
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

  on('combat:toggle_uneven', async () => {
    const state = await one('SELECT * FROM combat_state WHERE id = 1');
    await run('UPDATE combat_state SET uneven_combat_enabled = ? WHERE id = 1', [
      state.uneven_combat_enabled ? 0 : 1,
    ]);
    await emitCombatUpdated();
  });

  on('combat:clear', async () => {
    await run('DELETE FROM combat_participants');
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
httpServer.listen(PORT, () => {
  console.log(`Custom VTT server listening on port ${PORT}`);
});
