import { createClient } from '@libsql/client';

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
      item_name TEXT NOT NULL
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
}
