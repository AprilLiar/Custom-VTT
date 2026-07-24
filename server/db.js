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

  // World-level Tell list, GM-editable at any time (unlike the fixed styles).
  // Tells carry small uploaded images (commissioned art), not icons — the
  // legacy icon column remains on old deployments but is unused.
  await run(`
    CREATE TABLE IF NOT EXISTS tells (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      image_data TEXT,      -- base64 small image
      image_mime_type TEXT
    )
  `);
  await ensureColumn('tells', 'image_data', 'TEXT');
  await ensureColumn('tells', 'image_mime_type', 'TEXT');

  // GM-created folders for organizing the Moves compendium
  await run(`
    CREATE TABLE IF NOT EXISTS move_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);

  // The compendium: master list of move templates with frame data
  await run(`
    CREATE TABLE IF NOT EXISTS moves (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0, -- 1 = auto-granted to every character
      tell_id INTEGER NOT NULL REFERENCES tells(id),
      startup_tics INTEGER NOT NULL DEFAULT 1,
      active_tics INTEGER NOT NULL DEFAULT 1,
      recovery_tics INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      style_attribute_id INTEGER REFERENCES attributes(id), -- NULL only on legacy rows
      folder_id INTEGER,    -- compendium folder; NULL = root
      image_data TEXT,      -- base64 small image (commissioned art)
      image_mime_type TEXT
    )
  `);
  await ensureColumn('moves', 'style_attribute_id', 'INTEGER REFERENCES attributes(id)');
  await ensureColumn('moves', 'folder_id', 'INTEGER');
  await ensureColumn('moves', 'image_data', 'TEXT');
  await ensureColumn('moves', 'image_mime_type', 'TEXT');

  // World-level Tag list, GM-managed like Tells (Phase 4 pulls in
  // per-character tag overrides; the base tables land now for Move tagging)
  await run(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    )
  `);
  await ensureColumn('tags', 'description', "TEXT NOT NULL DEFAULT ''");

  await run(`
    CREATE TABLE IF NOT EXISTS move_tags (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      UNIQUE(move_id, tag_id)
    )
  `);

  // On Hit / On Block / On Miss: text plus optional automations (JSON)
  await run(`
    CREATE TABLE IF NOT EXISTS move_interactions (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss')),
      text TEXT NOT NULL DEFAULT '',
      automations TEXT NOT NULL DEFAULT '[]' -- JSON [{type, amount}]
    )
  `);

  // Grants a Unique move to a specific character (Default moves need no row)
  await run(`
    CREATE TABLE IF NOT EXISTS character_moves (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      UNIQUE(character_id, move_id)
    )
  `);

  // Role-play tab: per-character question/answer entries. The 6 canonical
  // questions live in client code; their answers are upserted here keyed by
  // question text (is_custom = 0). Custom questions are rows with is_custom = 1.
  await run(`
    CREATE TABLE IF NOT EXISTS roleplay_entries (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      is_custom INTEGER NOT NULL DEFAULT 0
    )
  `);

  // The Perks compendium: master list of Perk templates. Just picture, name,
  // description, and automations (per user instruction) — no folders/style
  // filter, unlike Moves.
  await run(`
    CREATE TABLE IF NOT EXISTS perks (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      image_mime_type TEXT
    )
  `);

  // One or more automation entries per Perk template. payload shape depends
  // on automation_type — see server/perkAutomations.js.
  await run(`
    CREATE TABLE IF NOT EXISTS perk_automations (
      id INTEGER PRIMARY KEY,
      perk_id INTEGER NOT NULL REFERENCES perks(id) ON DELETE CASCADE,
      automation_type TEXT NOT NULL CHECK(automation_type IN
        ('die_step','stamina_multiplier','move_tag','move_frame_override','move_roll_bonus')),
      payload TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS character_perks (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      perk_id INTEGER NOT NULL REFERENCES perks(id) ON DELETE CASCADE,
      UNIQUE(character_id, perk_id)
    )
  `);

  // A snapshot, taken at grant time, of the Perk's automations as they stood
  // then. Revoke reverses THIS, not the live perk_automations template — so
  // editing a Perk after granting it never retroactively changes what an
  // existing grant applied or what revoking it undoes.
  await run(`
    CREATE TABLE IF NOT EXISTS character_perk_automations (
      id INTEGER PRIMARY KEY,
      character_perk_id INTEGER NOT NULL REFERENCES character_perks(id) ON DELETE CASCADE,
      automation_type TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);

  // Per-character Move Tag overrides granted by a Perk (personal, not
  // global — the shared move_tags template is untouched). A character's
  // effective tags on a move = move_tags, plus 'add' rows, minus 'remove'
  // rows here.
  await run(`
    CREATE TABLE IF NOT EXISTS character_move_tags (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('add','remove')),
      source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
    )
  `);

  // Per-character frame-data deltas on a specific move, granted by a Perk —
  // "the move copy on the character," not the shared template. Multiple
  // Perks can each contribute deltas to the same move; they sum.
  await run(`
    CREATE TABLE IF NOT EXISTS character_move_overrides (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      startup_delta INTEGER NOT NULL DEFAULT 0,
      active_delta INTEGER NOT NULL DEFAULT 0,
      recovery_delta INTEGER NOT NULL DEFAULT 0,
      source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
    )
  `);

  // Per-character bonus that only applies to rolls made using a specific
  // move. Stored and displayed now; there is no move-triggered roll yet to
  // apply it to (that's Phase 7's declared-move reveal-and-roll) — see the
  // plan's open items.
  await run(`
    CREATE TABLE IF NOT EXISTS character_move_roll_bonuses (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      source_character_perk_id INTEGER REFERENCES character_perks(id) ON DELETE CASCADE
    )
  `);

  await seedRuleset();
  await seedTells();
}

// Two placeholder Tells so moves can be created immediately; the GM replaces
// them with real Tells (name + icon) in the Compendium.
async function seedTells() {
  const { count } = await one('SELECT COUNT(*) AS count FROM tells');
  if (Number(count) === 0) {
    await run("INSERT INTO tells (name) VALUES ('Tell 1')");
    await run("INSERT INTO tells (name) VALUES ('Tell 2')");
  }
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
