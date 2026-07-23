import { createClient } from '@libsql/client';
import { STYLES, COUNTER_BONUS, DEFEATS } from './ruleset.js';

// Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN env vars);
// a local libSQL file otherwise — same client, same SQL.
const url = process.env.TURSO_DATABASE_URL || 'file:local.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

export const db = createClient(authToken ? { url, authToken } : { url });

// Safe helpers that always return plain objects keyed by column name.
export async function all(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows.map((row) => {
    const obj = {};
    result.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

export async function one(sql, args = []) {
  const rows = await all(sql, args);
  return rows[0] ?? null;
}

export async function run(sql, args = []) {
  return db.execute({ sql, args });
}

// Column-adding migration that works on both local files and Turso:
// checks the table's stored CREATE statement rather than PRAGMA.
async function ensureColumn(table, column, ddl) {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table]
  );
  if (row && !new RegExp(`\\b${column}\\b`).test(row.sql)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export async function initDb() {
  // Phase 0's demo table is no longer used.
  await run('DROP TABLE IF EXISTS pings');

  await run(`
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      character_type TEXT NOT NULL DEFAULT 'pc' CHECK(character_type IN ('pc','npc')),
      image_data TEXT,          -- base64-encoded image, stored directly in Turso
      image_mime_type TEXT,     -- e.g. 'image/jpeg', needed to render image_data correctly
      active_stance_id INTEGER, -- FK to stances(id), set once stances exist (Phase 2)
      stamina_multiplier INTEGER NOT NULL DEFAULT 4,
      max_stamina INTEGER NOT NULL DEFAULT 0,
      current_stamina INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS dice (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      pool TEXT NOT NULL CHECK(pool IN ('head','core','legs')),
      slot_name TEXT NOT NULL,
      current_size INTEGER NOT NULL DEFAULT 8 CHECK(current_size IN (4,6,8,10,12)),
      bonus INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','incapacitated')),
      locked_size INTEGER NOT NULL DEFAULT 8 CHECK(locked_size IN (4,6,8,10,12)),
      locked_bonus INTEGER NOT NULL DEFAULT 0,
      locked_status TEXT NOT NULL DEFAULT 'active' CHECK(locked_status IN ('active','incapacitated'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    )
  `);
  // Existing deployments predate the description field
  await ensureColumn('inventory_items', 'description', "TEXT NOT NULL DEFAULT ''");

  await run(`
    CREATE TABLE IF NOT EXISTS attributes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      icon TEXT NOT NULL DEFAULT '' -- lucide icon name, rendered client-side
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS attribute_counters (
      id INTEGER PRIMARY KEY,
      attacker_attribute_id INTEGER NOT NULL REFERENCES attributes(id),
      defender_attribute_id INTEGER NOT NULL REFERENCES attributes(id),
      bonus INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stances (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      attribute_a_id INTEGER NOT NULL REFERENCES attributes(id),
      attribute_b_id INTEGER NOT NULL REFERENCES attributes(id) CHECK(attribute_b_id != attribute_a_id)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS injuries (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      effect TEXT NOT NULL
    )
  `);

  // No FK clause on character_id: libsql enforces foreign keys, and chat
  // entries must survive character deletion (history shows "(deleted)").
  await run(`
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL, -- JSON array of {slot_name, size, bonus, result}
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER, -- moves table arrives in Phase 3
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await seedRuleset();
}

// Seed the 7 styles and their complete counter tournament exactly once.
async function seedRuleset() {
  const { count } = await one('SELECT COUNT(*) AS count FROM attributes');
  if (Number(count) === 0) {
    for (const style of STYLES) {
      await run('INSERT INTO attributes (name, icon) VALUES (?, ?)', [
        style.name,
        style.icon,
      ]);
    }
  }
  const counters = await one('SELECT COUNT(*) AS count FROM attribute_counters');
  if (Number(counters.count) === 0) {
    const rows = await all('SELECT id, name FROM attributes');
    const idByName = Object.fromEntries(rows.map((r) => [r.name, r.id]));
    for (const [winner, losers] of Object.entries(DEFEATS)) {
      for (const loser of losers) {
        await run(
          'INSERT INTO attribute_counters (attacker_attribute_id, defender_attribute_id, bonus) VALUES (?, ?, ?)',
          [idByName[winner], idByName[loser], COUNTER_BONUS]
        );
      }
    }
  }
}
