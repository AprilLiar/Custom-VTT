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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '3mb' })); // portraits arrive as base64 JSON
const httpServer = createServer(app);
const io = new Server(httpServer);

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

app.get('/api/characters/:id', wrap(async (req, res) => {
  const character = await getCharacter(req.params.id);
  if (!character) return res.status(404).json({ error: 'not found' });
  res.json({
    character,
    dice: await getDice(character.id),
    inventory: await getInventory(character.id),
    injuries: await getInjuries(character.id),
    stances: await getStances(character.id),
  });
}));

// The fixed ruleset: 7 styles + the complete counter tournament (seeded once)
app.get('/api/ruleset', wrap(async (_req, res) => {
  res.json({
    attributes: await all('SELECT * FROM attributes ORDER BY id'),
    counters: await all('SELECT * FROM attribute_counters ORDER BY id'),
  });
}));

app.post('/api/characters', wrap(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const characterType = req.body?.characterType === 'npc' ? 'npc' : 'pc';

  // Dice seed at d8, so starting Max Stamina = 4 x (8 + 0); Current starts at Max.
  const maxStamina = computeMaxStamina(4, 8, 0);
  const result = await run(
    'INSERT INTO characters (name, character_type, max_stamina, current_stamina) VALUES (?, ?, ?, ?)',
    [name, characterType, maxStamina, maxStamina]
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
  await run('DELETE FROM characters WHERE id = ?', [character.id]);

  io.emit('character:deleted', { id: character.id });
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
