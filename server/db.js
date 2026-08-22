import { createClient } from '@libsql/client';
import { STYLES, COUNTER_BONUS, DEFEATS } from './ruleset.js';
import { PERK_REGISTRY } from './perks/index.js';

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

// move_interactions.trigger originally had a 3-value CHECK ('hit','block',
// 'miss'). SQLite can't ALTER a CHECK constraint in place, so an existing
// table stuck with the old constraint gets rebuilt: a v2 table with the
// expanded 5-value CHECK, every row copied across, the old table dropped,
// then v2 renamed into place. A fresh database's CREATE TABLE IF NOT EXISTS
// above already gets the expanded CHECK directly, so this only fires
// against a database created before defense_success/defense_failure existed.
async function migrateMoveInteractionsTrigger() {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'move_interactions'"
  );
  if (!row || row.sql.includes('defense_success')) return;
  await run(`
    CREATE TABLE move_interactions_v2 (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss','defense_success','defense_failure')),
      text TEXT NOT NULL DEFAULT '',
      automations TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await run(`
    INSERT INTO move_interactions_v2 (id, move_id, trigger, text, automations)
    SELECT id, move_id, trigger, text, automations FROM move_interactions
  `);
  await run('DROP TABLE move_interactions');
  await run('ALTER TABLE move_interactions_v2 RENAME TO move_interactions');
}

// Grappling (decided, new) adds a sixth trigger: **On Successful Grapple**,
// which fires when a grapple wins its contest. Same table-rebuild shape and
// the same reason as the migration above — SQLite cannot ALTER a CHECK.
// Guarded on the new value rather than on a version number, so this is a
// no-op on a database that already has it.
async function migrateMoveInteractionsGrappleTrigger() {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'move_interactions'"
  );
  if (!row || row.sql.includes('grapple_success')) return;
  await run(`
    CREATE TABLE move_interactions_v3 (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL
        CHECK(trigger IN ('hit','block','miss','defense_success','defense_failure','grapple_success')),
      text TEXT NOT NULL DEFAULT '',
      automations TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await run(`
    INSERT INTO move_interactions_v3 (id, move_id, trigger, text, automations)
    SELECT id, move_id, trigger, text, automations FROM move_interactions
  `);
  await run('DROP TABLE move_interactions');
  await run('ALTER TABLE move_interactions_v3 RENAME TO move_interactions');
}

// chat_log.kind originally had a 2-value CHECK ('roll','message'), then grew
// to 3 ('move_reveal'), then 4 ('lane_snapshot'), now 5 ('round_summary',
// the Combat Automation overhaul's once-per-pair-per-round replay card —
// §1.5). Same rebuild pattern each time, since SQLite can't ALTER a CHECK
// constraint in place — a fresh database's CREATE TABLE IF NOT EXISTS below
// already gets the current CHECK directly, so this only fires against a
// database whose stored table SQL still has an older one (which, as of this
// overhaul, is every database that predates it — including the
// currently-deployed production one).
async function migrateChatLogKind() {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_log'"
  );
  if (!row || row.sql.includes('round_summary')) return;
  await run(`
    CREATE TABLE chat_log_v2 (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot','round_summary')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL,
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER,
      content TEXT,
      image_data TEXT,
      image_mime_type TEXT,
      payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    INSERT INTO chat_log_v2 (id, kind, character_id, dice_rolled, modifier, move_id, content, image_data, image_mime_type, payload, created_at)
    SELECT id, kind, character_id, dice_rolled, modifier, move_id, content, image_data, image_mime_type, payload, created_at FROM chat_log
  `);
  await run('DROP TABLE chat_log');
  await run('ALTER TABLE chat_log_v2 RENAME TO chat_log');
}

// A finished round's replay ("Watch Round N" in chat) used to die with the
// fight: combat:end/combat:clear deleted every pair_round_resolutions row,
// and round_events cascades off it. Those rows are kept now — but a fresh
// fight restarts each pair at round 1, which collides with the old
// UNIQUE(pair_index, round_number). Scoping that uniqueness to the fight
// (combat_state.fight_number, bumped per Start Combat) is what lets both
// coexist. A CHECK/UNIQUE can't be ALTERed in SQLite, so this rebuilds the
// table — same shape as migrateChatLogKind above. Existing rows all belong
// to whatever fight was last running, which is fight 1 by definition of the
// column's own default.
async function migratePairRoundResolutionsFightNumber() {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pair_round_resolutions'"
  );
  if (!row || row.sql.includes('fight_number')) return;
  // Foreign keys are ON in this database (unlike stock SQLite), so dropping
  // the old table would cascade every round_events row — i.e. delete exactly
  // the replay history this change exists to preserve. SQLite's own
  // documented table-rebuild procedure is to turn them off for the swap;
  // safe here because the copy below preserves `id` exactly, so every
  // round_events.resolution_id still points at the same row afterwards.
  await run('PRAGMA foreign_keys = OFF');
  await run(`
    CREATE TABLE pair_round_resolutions_v2 (
      id INTEGER PRIMARY KEY,
      pair_index INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      fight_number INTEGER NOT NULL DEFAULT 1,
      round_start_tic INTEGER NOT NULL,
      round_length INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused_dodge','paused_conflict','complete')),
      resolved_through_tic INTEGER NOT NULL DEFAULT 0,
      pending_dodge_json TEXT,
      pending_conflict_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(pair_index, round_number, fight_number)
    )
  `);
  await run(`
    INSERT INTO pair_round_resolutions_v2
      (id, pair_index, round_number, fight_number, round_start_tic, round_length, status,
       resolved_through_tic, pending_dodge_json, pending_conflict_json, created_at, completed_at)
    SELECT id, pair_index, round_number, 1, round_start_tic, round_length, status,
           resolved_through_tic, pending_dodge_json, pending_conflict_json, created_at, completed_at
    FROM pair_round_resolutions
  `);
  await run('DROP TABLE pair_round_resolutions');
  await run('ALTER TABLE pair_round_resolutions_v2 RENAME TO pair_round_resolutions');
  await run('PRAGMA foreign_keys = ON');
}

// Defences now stop for the GM (decided, revised — this reverses the
// overhaul's own decision #1, "Block is fully automatic, zero GM clicks
// ever"). The reason is a rule no amount of code can decide: a Straight and
// a Haymaker can both target the head, but a front block stops one and not
// the other. Only a human knows whether the defence that happened to overlap
// was the RIGHT defence, so any defence covering the attack's first Active
// frame now pauses and asks — a third pause status alongside the Dodge and
// move-conflict ones, with its own pending payload. Same table-rebuild shape
// as the two migrations above; a CHECK can't be ALTERed in SQLite.
async function migratePairRoundResolutionsDefenseConfirm() {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pair_round_resolutions'"
  );
  if (!row || row.sql.includes('paused_defense')) return;
  // Same foreign-key dance and the same reason as the fight_number rebuild:
  // round_events cascades off this table, and `id` is preserved exactly so
  // every stored replay still points at its own resolution afterwards.
  await run('PRAGMA foreign_keys = OFF');
  await run(`
    CREATE TABLE pair_round_resolutions_v3 (
      id INTEGER PRIMARY KEY,
      pair_index INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      fight_number INTEGER NOT NULL DEFAULT 1,
      round_start_tic INTEGER NOT NULL,
      round_length INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running','paused_dodge','paused_conflict','paused_defense','complete')),
      resolved_through_tic INTEGER NOT NULL DEFAULT 0,
      pending_dodge_json TEXT,
      pending_conflict_json TEXT,
      pending_defense_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(pair_index, round_number, fight_number)
    )
  `);
  await run(`
    INSERT INTO pair_round_resolutions_v3
      (id, pair_index, round_number, fight_number, round_start_tic, round_length, status,
       resolved_through_tic, pending_dodge_json, pending_conflict_json, created_at, completed_at)
    SELECT id, pair_index, round_number, fight_number, round_start_tic, round_length, status,
           resolved_through_tic, pending_dodge_json, pending_conflict_json, created_at, completed_at
    FROM pair_round_resolutions
  `);
  await run('DROP TABLE pair_round_resolutions');
  await run('ALTER TABLE pair_round_resolutions_v3 RENAME TO pair_round_resolutions');
  await run('PRAGMA foreign_keys = ON');
}

// Grappling (decided, new) is the engine's **fourth** pause, and the first
// that is genuinely two-party: a grapple stops and asks the grappler which
// direction they are taking the grab AND asks the target to guess it, and
// cannot continue until both have answered. Both halves live in one
// pending_grapple_json, filled in independently — see resolveGrappleContest
// and the grapple branch in roundResolution.js.
//
// Fourth rebuild of this table, same shape and the same foreign-key dance as
// the two above. The dormant 'paused_defense' status (groundwork for the
// queued Defence rework, still unwired) is carried through untouched — this
// change must not disturb it.
async function migratePairRoundResolutionsGrapple() {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pair_round_resolutions'"
  );
  if (!row || row.sql.includes('paused_grapple')) return;
  await run('PRAGMA foreign_keys = OFF');
  await run(`
    CREATE TABLE pair_round_resolutions_v4 (
      id INTEGER PRIMARY KEY,
      pair_index INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      fight_number INTEGER NOT NULL DEFAULT 1,
      round_start_tic INTEGER NOT NULL,
      round_length INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running','paused_dodge','paused_conflict','paused_defense','paused_grapple','complete')),
      resolved_through_tic INTEGER NOT NULL DEFAULT 0,
      pending_dodge_json TEXT,
      pending_conflict_json TEXT,
      pending_defense_json TEXT,
      pending_grapple_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(pair_index, round_number, fight_number)
    )
  `);
  await run(`
    INSERT INTO pair_round_resolutions_v4
      (id, pair_index, round_number, fight_number, round_start_tic, round_length, status,
       resolved_through_tic, pending_dodge_json, pending_conflict_json, pending_defense_json,
       created_at, completed_at)
    SELECT id, pair_index, round_number, fight_number, round_start_tic, round_length, status,
           resolved_through_tic, pending_dodge_json, pending_conflict_json, pending_defense_json,
           created_at, completed_at
    FROM pair_round_resolutions
  `);
  await run('DROP TABLE pair_round_resolutions');
  await run('ALTER TABLE pair_round_resolutions_v4 RENAME TO pair_round_resolutions');
  await run('PRAGMA foreign_keys = ON');
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
      vitruvian_image_data TEXT,      -- GM-uploaded replacement for the default Tab 1 backdrop figure
      vitruvian_image_mime_type TEXT,
      active_stance_id INTEGER, -- FK to stances(id), set once stances exist (Phase 2)
      stamina_multiplier INTEGER NOT NULL DEFAULT 4,
      max_stamina INTEGER NOT NULL DEFAULT 0,
      current_stamina INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      folder_id INTEGER -- character list folder; NULL = root
    )
  `);
  await ensureColumn('characters', 'folder_id', 'INTEGER');
  await ensureColumn('characters', 'vitruvian_image_data', 'TEXT');
  await ensureColumn('characters', 'vitruvian_image_mime_type', 'TEXT');

  // GM-created folders for organizing the character list — same structural
  // pattern as move_folders (create/rename/delete). Nested: parent_id is a
  // self-reference (NULL = root); ON DELETE SET NULL is metadata only — the
  // actual reparenting-on-delete logic is explicit in character_folder:delete
  // (promote to the deleted folder's own parent, not unconditionally to root).
  await run(`
    CREATE TABLE IF NOT EXISTS character_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES character_folders(id) ON DELETE SET NULL
    )
  `);
  await ensureColumn('character_folders', 'parent_id', 'INTEGER REFERENCES character_folders(id) ON DELETE SET NULL');

  await run(`
    CREATE TABLE IF NOT EXISTS dice (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      pool TEXT NOT NULL CHECK(pool IN ('head','core','legs')),
      slot_name TEXT NOT NULL,
      -- d4 is the ruleset's starting baseline for every Stat (Character
      -- Creation in game_rules.md); a new character then spends a budget of
      -- step-ups. Only affects rows inserted from here on.
      current_size INTEGER NOT NULL DEFAULT 4 CHECK(current_size IN (4,6,8,10,12)),
      bonus INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','incapacitated')),
      -- Matches current_size's baseline: a brand-new character must not read
      -- as already two steps below their own locked base, and Revert Stats
      -- must not jump every die up to a base they never had.
      locked_size INTEGER NOT NULL DEFAULT 4 CHECK(locked_size IN (4,6,8,10,12)),
      locked_bonus INTEGER NOT NULL DEFAULT 0,
      locked_status TEXT NOT NULL DEFAULT 'active' CHECK(locked_status IN ('active','incapacitated')),
      -- Half-Damage (decided): a raw on/off flag, toggled manually (a plain
      -- flip, no other side effect) or by a future automated effect via
      -- applyHalfDamage in gameLogic.js, which — only when called — clears
      -- this flag and steps current_size/bonus/status down by one rank
      -- instead of just setting the flag a second time.
      half_damage INTEGER NOT NULL DEFAULT 0
    )
  `);
  await ensureColumn('dice', 'half_damage', 'INTEGER NOT NULL DEFAULT 0');

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
      effect TEXT NOT NULL,
      -- Optional die slot this Injury penalizes (decided): NULL for a purely
      -- descriptive Injury with no mechanical stat effect. Applied only when
      -- the character reverts to their locked/base stats (character:revert_stats)
      -- — see applyRankPenalty in gameLogic.js — never live, and never during
      -- character:lock_stats itself.
      slot_name TEXT CHECK(slot_name IN ('Skull','Brain','Left Hand','Stamina','Body','Right Hand','Left Leg','Right Leg')),
      penalty INTEGER NOT NULL DEFAULT 0
    )
  `);
  await ensureColumn(
    'injuries',
    'slot_name',
    "TEXT CHECK(slot_name IN ('Skull','Brain','Left Hand','Stamina','Body','Right Hand','Left Leg','Right Leg'))"
  );
  await ensureColumn('injuries', 'penalty', 'INTEGER NOT NULL DEFAULT 0');

  // No FK clause on character_id: libsql enforces foreign keys, and chat
  // entries must survive character deletion (history shows "(deleted)").
  // kind='message' rows are free-text chat posts (optionally with an
  // attached image/GIF); kind='move_reveal' rows mark a declared move's
  // reveal (move_id set, posted automatically — see combat:tic_forward);
  // dice_rolled stays '[]' for both rather than NULL, since it predates
  // them and was already NOT NULL on existing databases. The text column is
  // named `content`, not `message` — a column literally named "message"
  // would collide with ensureColumn's word-boundary detection, which would
  // then false-positive-match the CHECK constraint's own `'message'` enum
  // literal above and skip adding the column entirely.
  // kind='lane_snapshot' rows (Chat Log redesign, item 4) mark a cumulative
  // per-lane Tic Counter snapshot posted every time any move in that lane
  // reveals — payload carries the whole snapshot (pairIndex, round/Tic
  // window, and every currently-revealed move in the lane with its own
  // footprint + embedded full move data for the Genius Observer expand) as
  // JSON, since (unlike declared_moves' per-viewer secrecy) a chat card is
  // broadcast identically to everyone and so only ever needs to carry
  // already-public data. Replaces the old single-move move_reveal card
  // going forward; move_reveal rows already in a live chat log keep
  // rendering exactly as before (see ChatPanel.jsx) for history's sake.
  // Combat Automation (Phase 9, planned — see vttprojectplan.md): a
  // kind='roll' row optionally carries this same payload column too, when
  // (and only when) the roll is for a declared move's own reveal-time Roll
  // — never for a bare Dice Tray/manual Stat/Pool roll, which have no move
  // to attack with. Documented shape (not yet populated by any handler —
  // that's the socket-event sub-phase):
  //   { declaredMoveId, moveId, pairIndex, side: 'left'|'right',
  //     targetCandidateIds: number[] }
  // targetCandidateIds is every character currently seated on the opposing
  // side of the roller's own pair at roll time — trivially one id for a
  // normal 1-on-1 pair, more than one under Uneven Combat, where the future
  // Apply-damage flow will need to ask which target(s) it actually hit.
  await run(`
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot','round_summary')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL, -- JSON array of {slot_name, size, bonus, result}
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER, -- set for kind='move_reveal'; no FK, same survive-deletion reasoning as character_id
      content TEXT, -- free-text message content; kind='message' only
      image_data TEXT, -- base64; kind='message' only. GIFs stored raw/unresized to keep animation
      image_mime_type TEXT,
      payload TEXT, -- JSON; kind='lane_snapshot' always, kind='roll' optionally (see above)
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn(
    'chat_log',
    'kind',
    "TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot'))"
  );
  await ensureColumn('chat_log', 'content', 'TEXT');
  await ensureColumn('chat_log', 'image_data', 'TEXT');
  await ensureColumn('chat_log', 'image_mime_type', 'TEXT');
  await ensureColumn('chat_log', 'payload', 'TEXT');
  await migrateChatLogKind();

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

  // GM-created folders for organizing the Moves compendium. Nested, same
  // parent_id self-reference pattern as character_folders above.
  await run(`
    CREATE TABLE IF NOT EXISTS move_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES move_folders(id) ON DELETE SET NULL
    )
  `);
  await ensureColumn('move_folders', 'parent_id', 'INTEGER REFERENCES move_folders(id) ON DELETE SET NULL');

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
      -- Current Stamina spent by the declaring character the moment their
      -- side finishes declaring (combat:side_done_declaring) — required at
      -- creation, but 0 is a valid "free" cost; a negative cost restores
      -- Stamina instead of spending it.
      stamina_cost INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      style_attribute_id INTEGER REFERENCES attributes(id), -- NULL only on legacy rows
      folder_id INTEGER,    -- compendium folder; NULL = root
      image_data TEXT,      -- base64 small image (commissioned art)
      image_mime_type TEXT,
      -- Flat bonus baked into this move's own Roll (distinct from the
      -- per-character roll_bonus a Perk can separately grant a move).
      roll_modifier INTEGER NOT NULL DEFAULT 0,
      -- Only set when the Roll includes an ambiguous Hand/Leg slot (see
      -- move_roll_slots): the two Tells the header shows side by side, one
      -- per appendage choice. tell_id above is left pointing at one of them
      -- in that case, purely to satisfy its NOT NULL constraint — the
      -- Tell header ignores it once right/left are both set.
      right_tell_id INTEGER REFERENCES tells(id),
      left_tell_id INTEGER REFERENCES tells(id),
      -- 1 = this move has On Successful Defense / On Failed Defense
      -- interactions available (see move_interactions below)
      is_defensive INTEGER NOT NULL DEFAULT 0,
      -- Roll type (decided, new): 'stat' is the original body-part Roll
      -- (move_roll_slots below); 'custom' replaces it entirely with one
      -- flat base die (custom_roll_size), not tied to any character stat —
      -- for weapons, where the damage die belongs to the item, not the
      -- wielder. Mutually exclusive: a 'custom' move always has empty
      -- move_roll_slots (writeMove enforces this), and a 'stat' move always
      -- has a NULL custom_roll_size.
      roll_type TEXT NOT NULL DEFAULT 'stat' CHECK(roll_type IN ('stat','custom')),
      custom_roll_size INTEGER CHECK(custom_roll_size IN (4,6,8,10,12)),
      -- Combat Automation overhaul: which of the two defensive mechanics
      -- this move's Defense Frames represent. Block resolves fully
      -- automatically (dice math only); Dodge is the one remaining
      -- human-in-the-loop call (the GM's Successful/Failed prompt). Required
      -- by writeMove whenever is_defensive=1 with at least one Defense Frame
      -- placed (see the sibling positions column below); NULL otherwise.
      -- See the migration below for how every pre-existing Defensive move
      -- is backfilled. (Deliberately not spelling out that sibling column's
      -- own name here in full, word for word — ensureColumn's "does this
      -- column already exist" check matches against the whole stored CREATE
      -- TABLE text, comments included, so writing it out would make that
      -- check see a false match and skip adding it on a fresh database.)
      defense_kind TEXT CHECK(defense_kind IN ('block','dodge'))
    )
  `);
  await ensureColumn('moves', 'style_attribute_id', 'INTEGER REFERENCES attributes(id)');
  await ensureColumn('moves', 'folder_id', 'INTEGER');
  await ensureColumn('moves', 'image_data', 'TEXT');
  await ensureColumn('moves', 'image_mime_type', 'TEXT');
  await ensureColumn('moves', 'roll_modifier', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('moves', 'right_tell_id', 'INTEGER REFERENCES tells(id)');
  await ensureColumn('moves', 'left_tell_id', 'INTEGER REFERENCES tells(id)');
  await ensureColumn('moves', 'is_defensive', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('moves', 'stamina_cost', 'INTEGER NOT NULL DEFAULT 0');
  // Block Stamina (decided, new — the first Tag automation): a move carrying
  // the **Block** Tag has no up-front Stamina Cost at all. It pays at
  // resolution instead, for exactly as much of the attack as its guard
  // actually absorbed, scaled by this multiplier. REAL, not INTEGER: the
  // whole point is that it can sit either side of 1 (a cheap guard at 0.5, a
  // punishing one at 2). Never 0 or negative — see clampStaminaModifier.
  // Meaningless on a move without the Block Tag, and simply ignored there.
  await ensureColumn('moves', 'stamina_modifier', 'REAL NOT NULL DEFAULT 1');
  await ensureColumn('moves', 'roll_type', "TEXT NOT NULL DEFAULT 'stat' CHECK(roll_type IN ('stat','custom'))");
  await ensureColumn('moves', 'custom_roll_size', 'INTEGER CHECK(custom_roll_size IN (4,6,8,10,12))');
  // JSON array of 0-based indices into the move's full frame sequence
  // (Startup squares first, then Active, then Recovery) marking which
  // squares also grant a defensive window — see sanitizeDefensePositions in
  // moveLogic.js. Purely a display annotation, not a timing phase.
  await ensureColumn('moves', 'defense_frame_positions', "TEXT NOT NULL DEFAULT '[]'");
  // Attack Target (Change 001): JSON array of the abstract Stat names (see
  // ATTACK_TARGET_NAMES in moveLogic.js) a Roll's damage may be applied to.
  // Default '["Skull"]' is a one-time migration value for every pre-existing
  // Move (every legacy Move gets exactly Skull); a brand-new Move created
  // after this column exists is written with an explicit [] by writeMove —
  // the DB default only ever fires for the migration, never for new rows.
  await ensureColumn('moves', 'attack_targets', `TEXT NOT NULL DEFAULT '["Skull"]'`);
  await ensureColumn('moves', 'defense_kind', "TEXT CHECK(defense_kind IN ('block','dodge'))");
  // Combat Style (decided, new): the move's OWN style, joined onto its user's
  // active stance when the Stance matchup is scored for that move's roll —
  // three styles against three instead of two against two. Deliberately a
  // second column rather than a mechanical reading of style_attribute_id
  // above: that one is a *gate* (which characters may learn and use this move
  // at all) and is required, this one is a *contribution* and is optional.
  // They may be the same style or different ones, and a move may carry this
  // and no gate style or the reverse. Duplicates are the point — a Strength
  // move in a Strength stance counts Strength twice, doubling that style's
  // half of the matchup in both directions. See getStanceMatchupBonus.
  await ensureColumn('moves', 'combat_style_attribute_id', 'INTEGER REFERENCES attributes(id)');
  // Grappling (decided, new). A grappling move does not simply land or miss:
  // it opens a four-way branch (see move_grapple_directions below), the
  // grappler picks a direction in secret and the target guesses it, and the
  // whole thing is settled by an opposed roll against the target's Resist
  // Roll rather than by the ordinary damage flow. **Dodge can evade a
  // grapple; Block cannot** — a declared Block is never consulted against
  // one.
  await ensureColumn('moves', 'is_grappling', 'INTEGER NOT NULL DEFAULT 0');
  // The floor a **No Damage** move's roll must clear to count as successful.
  // Belongs to the No Damage tag rather than to grappling — a non-grappling
  // No Damage move uses it on its own — but a grapple must clear it AND beat
  // the target, so it can fail two distinct ways. Default 5 matches the
  // Half-Damage step size, which is the only other threshold in the game.
  await ensureColumn('moves', 'success_threshold', 'INTEGER NOT NULL DEFAULT 5');
  // Requirement (decided, new). A non-mandatory pointer at another move: this
  // move may only be declared **immediately** after that one — not later in
  // the round, and never without it. Combo Moves and Grappling Chains are the
  // motivating cases. Deliberately a plain nullable column rather than a child
  // table: a move has at most one Requirement, so there is nothing to group.
  //
  // The self-referencing FK is load-bearing in the same way
  // move_grapple_directions.target_move_id is: it makes deleting a move that
  // something else requires fail loudly unless move:delete clears the inbound
  // pointers first, rather than leaving a Requirement aimed at nothing.
  await ensureColumn('moves', 'requirement_move_id', 'INTEGER REFERENCES moves(id)');
  // Secondary (decided, new) — a move that can be granted, read and seen on a
  // character's sheet, but never declared off the picker by hand. It reaches
  // the board only the two ways the engine puts a move there for you: as a
  // Requirement follow-up (declarable, but only in the slot right after the
  // move it names) or as a Grappling direction the grappler picks mid-hold.
  //
  // A plain flag rather than an enum of those two routes: which one applies is
  // already implied by the rest of the move (a Requirement, or being named by
  // some grapple's cross), and storing it twice would let the two disagree.
  await ensureColumn('moves', 'is_secondary', 'INTEGER NOT NULL DEFAULT 0');
  // The `opponent_next_roll_penalty` automation's debt (decided, new): points
  // owed on this character's NEXT roll, of any kind, after which it is spent.
  //
  // **On the character, not the seat.** Every other combat modifier is a
  // standing fact re-read at each roll (see combatBonuses.js) and lives on
  // combat_participants, where it evaporates when the fight ends. This one is
  // a debt someone already incurred, so it has to survive the fight ending and
  // must not be sheddable by being re-seated.
  //
  // Accumulates: two moves can each leave a mark before the victim rolls, and
  // the next roll pays both.
  await ensureColumn('characters', 'pending_roll_penalty', 'INTEGER NOT NULL DEFAULT 0');
  // Custom Compendium ordering (decided, new) — the position a GM dragged
  // this move to. Rows created before this column read back as 0, and every
  // read path orders by (sort_order, id), so an un-reordered library keeps
  // its old id order exactly.
  await ensureColumn('moves', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  // Every move that was already Defensive before this column existed was
  // authored back when Block/Dodge were an in-the-moment GM call rather than
  // data on the move — migrate them all to 'block' (the fully-automatic,
  // no-judgment-call default) since that's what most of them are; a GM
  // reviewing a move that was narratively meant as a Dodge can flip it once.
  await run(
    `UPDATE moves SET defense_kind = 'block' WHERE is_defensive = 1 AND defense_kind IS NULL`
  );
  // A Default move is usable by anyone, anytime — it never made sense for
  // one to also carry a Style gate. writeMove now refuses to set one going
  // forward; this is the one-time cleanup for any Default move that already
  // had one from before that rule existed.
  await run(
    `UPDATE moves SET style_attribute_id = NULL WHERE is_default = 1 AND style_attribute_id IS NOT NULL`
  );

  // Which of a move's optional Roll dice it's made of — a move with no rows
  // here has no Roll. slot_name is either a concrete DICE_TEMPLATE slot
  // (Skull/Brain/Stamina/Body) or one of the two ambiguous appendage
  // choices, 'Hand' or 'Leg' — resolved to the character's actual Left or
  // Right die only at roll time, per the player's choice (see moveLogic.js).
  await run(`
    CREATE TABLE IF NOT EXISTS move_roll_slots (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      slot_name TEXT NOT NULL,
      UNIQUE(move_id, slot_name)
    )
  `);
  // How many of that slot the Roll takes. Only ever >1 for the two ambiguous
  // appendage slots, where 2 means "both sides at once" — a Straight Block
  // guards with both hands (see maxRollSlotCount in moveLogic.js). Stored as
  // a count on the existing one-row-per-slot shape rather than by relaxing
  // the UNIQUE above, because SQLite can't drop a constraint without
  // rebuilding the table, and every reader already groups by slot anyway.
  // Defaulting to 1 makes every pre-existing row mean exactly what it meant
  // before, so no data migration is needed.
  await ensureColumn('move_roll_slots', 'count', 'INTEGER NOT NULL DEFAULT 1');

  // Combat Automation (Phase 9, planned — see vttprojectplan.md): an
  // additional pool of Stat slots a Defensive move rolls *only* during
  // Block/Dodge resolution (4.2), on top of its own normal Roll (whichever
  // of move_roll_slots/custom_roll_size that is). Same slot_name vocabulary
  // and ambiguous-Hand/Leg handling as move_roll_slots — mirrors it exactly,
  // just a separate table since a slot can independently be in one, the
  // other, both, or neither. Only ever populated when the move's own
  // is_defensive = 1 (enforced in writeMove, same pattern move_roll_slots'
  // ambiguous-Tell requirement already uses) — not yet wired up; this table
  // exists ahead of the socket-event/UI work that will actually populate it.
  await run(`
    CREATE TABLE IF NOT EXISTS move_defensive_roll_slots (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      slot_name TEXT NOT NULL,
      UNIQUE(move_id, slot_name)
    )
  `);
  // Same count column, same meaning, for the same reason as move_roll_slots'
  // above — this table mirrors that one exactly and its readers expand it
  // through the same helper.
  await ensureColumn('move_defensive_roll_slots', 'count', 'INTEGER NOT NULL DEFAULT 1');

  // What the TARGET of a grapple throws to resist it (Grappling, decided).
  // Authored on the grappling move itself, so a headlock and an ankle pick
  // can contest different Stats. A literal mirror of the defensive table
  // above — same columns, same UNIQUE, read through the same
  // expandRollSlotRows helper — because it is the same idea pointed at the
  // other fighter. Empty means the target resists with nothing and the
  // grappler need only clear the Success Threshold.
  await run(`
    CREATE TABLE IF NOT EXISTS move_resist_roll_slots (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      slot_name TEXT NOT NULL,
      UNIQUE(move_id, slot_name)
    )
  `);
  await ensureColumn('move_resist_roll_slots', 'count', 'INTEGER NOT NULL DEFAULT 1');

  // The four-way branch on a grappling move. Each direction may name ANY
  // move — grappling or not — which is temporarily declared right after the
  // grapple if that direction wins. One row per assigned direction; an
  // unassigned direction simply has no row, so counting rows is what decides
  // whether the mini-game runs at all (it needs at least 2).
  //
  // target_move_id is ON DELETE CASCADE on the *pointed-at* move: deleting a
  // move that some grapple branches into removes that branch rather than
  // leaving a dangling direction that would resolve into nothing.
  await run(`
    CREATE TABLE IF NOT EXISTS move_grapple_directions (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('up','down','left','right')),
      target_move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      UNIQUE(move_id, direction)
    )
  `);

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

  // On Hit / On Block / On Miss (every move) plus On Successful Defense /
  // On Failed Defense (Defensive moves only, gated client + server side by
  // moves.is_defensive) — text plus optional automations (JSON).
  await run(`
    CREATE TABLE IF NOT EXISTS move_interactions (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
      trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss','defense_success','defense_failure')),
      text TEXT NOT NULL DEFAULT '',
      automations TEXT NOT NULL DEFAULT '[]' -- JSON [{type, amount}]
    )
  `);
  await migrateMoveInteractionsTrigger();
  await migrateMoveInteractionsGrappleTrigger();

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
  // and description — no generic automation system (removed; see
  // server/perkAutomations.js for the manual per-Perk hook skeleton that
  // replaced it) and no folders/style filter, unlike Moves.
  await run(`
    CREATE TABLE IF NOT EXISTS perks (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      image_mime_type TEXT
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

  // One grant's private scratch space — charges, cooldowns, "once per round"
  // (decided, new; see server/perks/index.js for the whole Perk architecture).
  //
  // **This is data storage, not an effect system**, which is the distinction
  // that keeps it clear of the generic Perk-automation registry that was built
  // and removed. Nothing here describes what a Perk *does*; a Perk's code says
  // that, and uses this to remember what it has already done.
  //
  // `scope` is when the row is wiped, and it is the whole reason the column
  // exists — "once per round" and "once per fight" are the two shapes almost
  // every stateful Perk turns out to want, and neither can be expressed by a
  // value alone. Keyed on character_perk_id, not character_id: revoking the
  // Perk takes its state with it, which is what ON DELETE CASCADE is for.
  await run(`
    CREATE TABLE IF NOT EXISTS character_perk_state (
      id INTEGER PRIMARY KEY,
      character_perk_id INTEGER NOT NULL REFERENCES character_perks(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'round' CHECK(scope IN ('round','fight','permanent')),
      UNIQUE(character_perk_id, key)
    )
  `);

  // Perk Tags (decided, new): a categorisation vocabulary for Perks, and
  // **deliberately its own list**, not the `tags` table Moves use. Move tags
  // are no longer purely cosmetic — the Block tag drives real Stamina
  // automation (see tagAutomations.js) — so sharing one vocabulary would put
  // mechanically-loaded names in a Perk's picker where they mean nothing.
  // These are optional and carry no mechanics at all, now or by design.
  await run(`
    CREATE TABLE IF NOT EXISTS perk_tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    )
  `);

  // Join table — mirrors move_tags' shape against the vocabulary above.
  await run(`
    CREATE TABLE IF NOT EXISTS perk_tag_links (
      id INTEGER PRIMARY KEY,
      perk_id INTEGER NOT NULL REFERENCES perks(id) ON DELETE CASCADE,
      perk_tag_id INTEGER NOT NULL REFERENCES perk_tags(id) ON DELETE CASCADE,
      UNIQUE(perk_id, perk_tag_id)
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

  // Character-owned counters (Phase 5). character_id nullable for standalone
  // arena counters (GM-only, created directly in the Combat Arena) — that
  // creation path arrives in Phase 6, this table just already accepts it.
  await run(`
    CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY,
      character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      target_pips INTEGER NOT NULL CHECK(target_pips BETWEEN 2 AND 20),
      current_pips INTEGER NOT NULL DEFAULT 0,
      show_in_combat INTEGER NOT NULL DEFAULT 0,
      -- Purely cosmetic tracking tag — no mechanical effect. Character-owned
      -- counters only (server rejects it for a standalone character_id=NULL
      -- counter); still shown if that counter is flagged Show in Combat.
      reward_type TEXT CHECK(reward_type IN ('story','statistic','perk','move','combat_prowess'))
    )
  `);
  await ensureColumn(
    'counters',
    'reward_type',
    "TEXT CHECK(reward_type IN ('story','statistic','perk','move','combat_prowess'))"
  );

  // Singleton row holding the Combat Arena's global state. Phase 7 adds the
  // round/Tic timing columns: phase is null until the first Next Round press.
  // declaring_side/pending_declare_side are Phase 7 leftovers, now unused —
  // Phase 9's combat redesign moved declaration ordering to per-pair state
  // (combat_pairs below) since declaration now runs independently per pair
  // instead of as one global side-vs-side batch. The columns stay (SQLite
  // migrations in this app are additive-only) but nothing reads/writes them
  // anymore.
  await run(`
    CREATE TABLE IF NOT EXISTS combat_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      uneven_combat_enabled INTEGER NOT NULL DEFAULT 0,
      phase TEXT CHECK(phase IN ('declaration','tic_countdown')),
      round_number INTEGER NOT NULL DEFAULT 0,
      current_tic INTEGER NOT NULL DEFAULT 0,
      round_start_tic INTEGER NOT NULL DEFAULT 0,
      round_length INTEGER NOT NULL DEFAULT 7,
      declaring_side TEXT CHECK(declaring_side IN ('left','right')),
      pending_declare_side TEXT CHECK(pending_declare_side IN ('left','right'))
    )
  `);
  await run(`INSERT OR IGNORE INTO combat_state (id, uneven_combat_enabled) VALUES (1, 0)`);
  // "Fresh" (decided, new): whether starting a fight restores every seated
  // character to full Stamina. OFF by default and reset to off by End
  // Combat / Clear Arena, so it is a deliberate per-fight choice rather than
  // something that quietly carries over — a run of consecutive fights is
  // supposed to wear people down. It governs the fight's FIRST round only;
  // the automatic per-round Stamina Regen from round 2 on is a separate rule
  // and is unaffected either way.
  await ensureColumn('combat_state', 'fresh_start', 'INTEGER NOT NULL DEFAULT 0');
  // Which fight the arena is currently on. Bumped once per Start Combat, and
  // stamped onto every pair_round_resolutions row so a finished round's
  // stored replay stays addressable after that fight ends — see the
  // fight_number note on that table below. Starts at 1 so a database created
  // before this column reads as "fight 1", matching the rows already in it.
  await ensureColumn('combat_state', 'fight_number', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('combat_state', 'phase', "TEXT CHECK(phase IN ('declaration','tic_countdown'))");
  await ensureColumn('combat_state', 'round_number', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combat_state', 'current_tic', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combat_state', 'round_start_tic', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combat_state', 'round_length', 'INTEGER NOT NULL DEFAULT 7');
  // Round length was extended from 5 to 7 Tics after playtesting — bump any
  // existing singleton row still sitting at the old default (a GM who has
  // since customized it, if that's ever exposed, is left alone).
  await run(`UPDATE combat_state SET round_length = 7 WHERE id = 1 AND round_length = 5`);
  await ensureColumn(
    'combat_state',
    'declaring_side',
    "TEXT CHECK(declaring_side IN ('left','right'))"
  );
  await ensureColumn(
    'combat_state',
    'pending_declare_side',
    "TEXT CHECK(pending_declare_side IN ('left','right'))"
  );

  // Who's currently seated in the arena. side + pair_index group participants
  // into facing pairs; a side/pair_index can hold more than one character
  // when Uneven Combat is on (the app doesn't enforce the toggle, it's just
  // a GM-facing flag). A character can only be seated once.
  // declared_this_round (Phase 9 combat redesign): has THIS character
  // individually pressed "done declaring" for the round currently in
  // combat_state.round_number — declaration is per-character now, not a
  // single batched press for a whole side (see combat_pairs below). Reset to
  // 0 for everyone at combat:next_round/clear/end.
  await run(`
    CREATE TABLE IF NOT EXISTS combat_participants (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK(side IN ('left','right')),
      pair_index INTEGER NOT NULL,
      declared_this_round INTEGER NOT NULL DEFAULT 0,
      -- "Reasons to Fight": 0-3, GM/player-adjustable while seated, +1 to all
      -- of this character's rolls (die:roll/pool:roll) per point while
      -- combat is active. Lives on the seat, not the character, so it
      -- naturally resets whenever they're re-seated for a new fight.
      reasons_to_fight INTEGER NOT NULL DEFAULT 0 CHECK(reasons_to_fight BETWEEN 0 AND 3),
      -- Idle-Tic Stamina Regen (see plan, server/staminaRegen.js): qualifying
      -- idle Tics accumulated toward this character's next +1 Stamina.
      -- Resets to 0 (with carryover of any remainder) every time it crosses
      -- the required threshold — see applyIdleTicStaminaRegen in index.js.
      -- Base rate is 1 Tic per point; a future Perk can require more via
      -- IDLE_STAMINA_REGEN_HOOKS in perkAutomations.js.
      idle_regen_progress INTEGER NOT NULL DEFAULT 0,
      UNIQUE(character_id)
    )
  `);
  await ensureColumn('combat_participants', 'declared_this_round', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(
    'combat_participants',
    'reasons_to_fight',
    'INTEGER NOT NULL DEFAULT 0 CHECK(reasons_to_fight BETWEEN 0 AND 3)'
  );
  await ensureColumn('combat_participants', 'idle_regen_progress', 'INTEGER NOT NULL DEFAULT 0');
  // Grappling (decided, new): while a grapple has hold of you, every roll you
  // make takes -2. The window ends with the grappling move's last ACTIVE Tic
  // (inclusive) — not its Recovery, and not the end of the round. Null means
  // no penalty. Read by getCombatRollBonus, which every roll path already
  // goes through and which already receives the Tic being resolved.
  await ensureColumn('combat_participants', 'grapple_penalty_until_tic', 'INTEGER');

  // Phase 9 combat redesign: declaration now runs independently per pair —
  // pair 1's losing side and pair 2's losing side can be declaring
  // simultaneously even though they might be literal opposite "sides", so a
  // single global declaring_side (combat_state, now unused — see above) no
  // longer describes who may currently call move:declare. One row per
  // pair_index that has participants, (re)computed fresh every
  // combat:next_round from that pair's own per-side Brain initiative
  // (resolveSideInitiative, scoped to just this pair's seated characters).
  // declaring_side is whichever side of THIS pair may currently declare —
  // NULL once both sides of this pair have every character marked
  // declared_this_round (both trivially "done" if a pair has only one side
  // seated). Rows are cleared and recreated by combat:next_round, and wiped
  // entirely by combat:clear/combat:end.
  await run(`
    CREATE TABLE IF NOT EXISTS combat_pairs (
      pair_index INTEGER PRIMARY KEY,
      declaring_side TEXT CHECK(declaring_side IN ('left','right')),
      -- Combat Automation overhaul: each pair now runs its own independent
      -- round/phase/Tic clock instead of sharing combat_state's single
      -- global one (see vttprojectplan.md) — fight A can be on round 5 while
      -- fight B is still on round 3. Unlike declaring_side above, these
      -- columns are NOT reset by combat:next_round; they're only ever
      -- updated in place, since they must persist and increment
      -- independently per pair across rounds. phase is NULL until this
      -- pair's first round is seeded.
      round_number INTEGER NOT NULL DEFAULT 0,
      phase TEXT CHECK(phase IN ('declaration','resolving')),
      round_start_tic INTEGER NOT NULL DEFAULT 0,
      current_tic INTEGER NOT NULL DEFAULT 0
    )
  `);
  await ensureColumn('combat_pairs', 'round_number', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combat_pairs', 'phase', "TEXT CHECK(phase IN ('declaration','resolving'))");
  await ensureColumn('combat_pairs', 'round_start_tic', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('combat_pairs', 'current_tic', 'INTEGER NOT NULL DEFAULT 0');

  // Combat Automation overhaul: one row per pair-round that has started
  // automatic resolution. Tracks the resumable stepper's progress
  // (advancePairResolution in index.js) — resolved_through_tic is the last
  // Tic fully computed and persisted, so a crash/restart mid-round can
  // safely redo just that one Tic rather than needing a transaction. The
  // pending_*_json columns hold the one piece of state that genuinely can't
  // be recomputed: a human decision that's still outstanding.
  await run(`
    CREATE TABLE IF NOT EXISTS pair_round_resolutions (
      id INTEGER PRIMARY KEY,
      pair_index INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      fight_number INTEGER NOT NULL DEFAULT 1,
      round_start_tic INTEGER NOT NULL,
      round_length INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused_dodge','paused_conflict','complete')),
      resolved_through_tic INTEGER NOT NULL DEFAULT 0,
      pending_dodge_json TEXT,
      pending_conflict_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(pair_index, round_number, fight_number)
    )
  `);
  await migratePairRoundResolutionsFightNumber();
  await migratePairRoundResolutionsDefenseConfirm();
  await migratePairRoundResolutionsGrapple();

  // Combat Automation overhaul: the replayable event log for one pair's
  // round — the single source of truth for both the live cutscene push and
  // any later chat "Watch Round X" replay, so the two are guaranteed
  // identical by construction (same rows, same client renderer). pair_index/
  // round_number are denormalized off pair_round_resolutions purely to
  // avoid a join on "give me this pair's log." seq is this resolution's own
  // monotonic order (independent of tic, since more than one event can
  // share a Tic).
  await run(`
    CREATE TABLE IF NOT EXISTS round_events (
      id INTEGER PRIMARY KEY,
      resolution_id INTEGER NOT NULL REFERENCES pair_round_resolutions(id) ON DELETE CASCADE,
      pair_index INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      tic INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Per-round queued moves — see server/combatTiming.js for the placement/
  // reveal math this feeds. Persisted (not ephemeral like chat) so they
  // survive a mid-round reload; the server withholds move_id/move_name from
  // a viewer until the reveal Tic UNLESS they're entitled to see it early —
  // the player logged in as the declaring character, or the GM for an NPC's
  // move (see isRevealedToViewer/mapDeclaredMovesForViewer in index.js) —
  // Tells are never secret, only the real move is.
  // reveal_posted tracks whether this row's move_reveal chat card has
  // already gone out, since reveal state itself is recomputed live (stepping
  // the Tic counter back and forth must not re-post — see combat:tic_forward).
  await run(`
    CREATE TABLE IF NOT EXISTS declared_moves (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      move_id INTEGER NOT NULL REFERENCES moves(id),
      round_number INTEGER NOT NULL,
      queue_order INTEGER NOT NULL,
      placement_tic INTEGER NOT NULL,
      reveal_tic INTEGER NOT NULL,
      reveal_posted INTEGER NOT NULL DEFAULT 0,
      -- 1 once this move's Stamina Cost has actually been subtracted from
      -- (or added to, for a negative cost) the character's current_stamina —
      -- happens in one batch when the declaring side presses "done
      -- declaring" (combat:side_done_declaring), not at move:declare time.
      -- Until then the cost is only a *visual* preview client-side.
      stamina_committed INTEGER NOT NULL DEFAULT 0,
      -- 'left' or 'right', recorded once at declare time via a client
      -- popup, for a move whose Roll includes an ambiguous Hand/Leg slot
      -- (see move_roll_slots) — NULL for a move with no ambiguous slot.
      -- Drives which single Tell is shown pre-reveal (both are shown only
      -- as a legacy-data fallback) and which appendage's die is included
      -- once the move auto-rolls at reveal.
      appendage_choice TEXT CHECK(appendage_choice IN ('left','right'))
    )
  `);
  await ensureColumn('declared_moves', 'reveal_posted', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('declared_moves', 'stamina_committed', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('declared_moves', 'appendage_choice', "TEXT CHECK(appendage_choice IN ('left','right'))");
  // **Uneven Combat: who this move is coming for (decided, new).** NULL on
  // every move in a 1v1 and on every row written before this existed, which is
  // exactly right — with one opponent there is nothing to choose, and the
  // engine's own deterministic rule (lowest character_id among the opposing
  // side) is still the fallback whenever this is NULL or names someone no
  // longer seated opposite. Recorded once at declare time; the fighter commits
  // to a target with the same information they commit to a Tic with.
  await ensureColumn('declared_moves', 'target_character_id', 'INTEGER');
  // Combat Automation (Phase 9, sub-phase 3 — see vttprojectplan.md): how
  // many extra Recovery Tics this declared move's window has been extended
  // by. Only ever set nonzero for a successfully-Blocked defender whose
  // Defense Frame ran out before the attacker's Active window did (4.3's
  // "too-short" coverage — see classifyDefenseCoverage in combatDamage.js and
  // combat:resolve_defense in index.js). Added into every place a declared
  // move's Recovery end is computed (reveal_tic + active_tics +
  // recovery_tics + recovery_extension_tics) so a fight that never touches
  // Combat Automation sees no behavior change at all — this column defaults
  // to, and stays, 0 for every other move.
  await ensureColumn('declared_moves', 'recovery_extension_tics', 'INTEGER NOT NULL DEFAULT 0');
  // Combat Automation (Phase 9, sub-phase 5 — see vttprojectplan.md): set
  // once this declared move's own attacker-side outcome (Hit or Blocked/
  // Dodged) has fired its move_interactions automations, so a Partial
  // Block's later damage Apply (same combat:apply_damage flow a plain Hit
  // uses) doesn't also re-fire the move's 'hit' trigger on top of the
  // 'block' trigger combat:resolve_defense already fired. Only ever read/
  // written for the attacking side's own declared move — the defending
  // side's defense_success/defense_failure firing is unrelated and unguarded
  // (see applyMoveInteractions/combat:resolve_defense in index.js).
  await ensureColumn('declared_moves', 'interactions_resolved', 'INTEGER NOT NULL DEFAULT 0');
  // Attack Target (Change 001): snapshot of this declared attack's concrete
  // effective targets (from moves.attack_targets, Hand/Leg expanded to the
  // declaring character's own appendage_choice) plus where that snapshot
  // came from. Taken once at move:declare and frozen — a later edit to the
  // Move template in the Compendium MUST NOT retroactively change an
  // already-declared attack. attack_target_source flips to 'block' only when
  // combat:resolve_defense records a Successful Block replacing it with the
  // blocking move's own base Stat Roll slots (never 'dodge' — Dodge target
  // replacement is a deferred, separate change).
  await ensureColumn('declared_moves', 'effective_attack_targets', `TEXT NOT NULL DEFAULT '["Skull"]'`);
  // Grappling (decided, new): which grapple chained this move into being.
  //
  // **There is deliberately no "temporary move" and no saved prior placement.**
  // The spec describes the chained move as temporarily declared during the
  // contest and rolled back on failure, but nobody ever observes that state —
  // the mini-game answers, the roll happens and the outcome lands in the same
  // step. So the engine simply does not create it until the grapple has
  // already won: during the pause the board shows a *ghost* drawn from the
  // grapple's own round_event, and a failed grapple has nothing to undo.
  //
  // That matters because a rollback here would be the only reversible write in
  // the engine. cascadeShift and the Postpone path are both forward-only, and
  // nothing else in the schema remembers where a move used to sit. Not
  // creating the row is strictly safer than creating one and restoring it.
  await ensureColumn('declared_moves', 'grapple_source_declared_move_id', 'INTEGER');
  // The **total-level** bonus a retroactively declared follow-up carries — the
  // ±5 from whether the defender read the grapple's direction right (decided,
  // revised: the ±5 now lands on the *follow-up's* roll rather than on the
  // grapple contest, because the contest is settled before anyone is asked
  // which way it went).
  //
  // Stored on the declaration rather than recomputed at roll time because by
  // the time this move resolves — possibly in a later round, since a chain
  // overflows like any other move — the pause that produced the number is long
  // gone. Applied to the summed total, never folded into the per-die modifier:
  // every other flat bonus in the game multiplies across dice, and a +5 in
  // `mod` on a three-die Roll would quietly be worth +15.
  await ensureColumn('declared_moves', 'chain_roll_bonus', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn(
    'declared_moves',
    'attack_target_source',
    `TEXT NOT NULL DEFAULT 'move' CHECK(attack_target_source IN ('move','block'))`
  );
  // Feint Tag (decided, new): 1 when this declaration was made IMMEDIATELY
  // after a move carrying the **Feint** Tag — same "right after" test the
  // Requirement gate uses, plus contiguity in time (it starts on the Tic the
  // Feint's own frames end). Such a move is dealt out of every non-owner's
  // combat payload entirely until it reveals: no Tell, no attack telegraph,
  // no row at all (see mapDeclaredMovesForViewer).
  //
  // Frozen at declare time rather than derived at read time on purpose. Two
  // things would otherwise change the answer after the fact: a Block
  // extending the Feint's Recovery (recovery_extension_tics) would break the
  // contiguity test mid-round, and a GM adding or removing the Tag on the
  // Move template would retroactively mask or unmask a declaration already
  // on the board.
  await ensureColumn('declared_moves', 'feint_masked', 'INTEGER NOT NULL DEFAULT 0');

  // **How this move's guard was judged (decided, new).** 'success' or 'failed'
  // once a defence has been adjudicated, NULL for every move that never was one
  // — which is most of them.
  //
  // Written by the three funnels that carry a verdict for a whole move:
  // applySuccessfulDodge, applyFailedDefense (a failed Dodge, or a Block the GM
  // said applied nowhere), and finishBlock's held path. A Block is adjudicated
  // one Stat at a time and its individual lines have no single answer, so the
  // column records the move-level one finishBlock already computes
  // (`heldAnywhere`) rather than the last line's.
  //
  // Added for Deadly Pendulum, which needs to know whether the Dodge you threw
  // right before this attack actually worked. Stored on the row rather than in
  // that Perk's private state because "did that guard hold?" is a plain fact
  // about the fight, not a thing one Perk gets to know — the round log already
  // says it out loud, this just makes it queryable.
  await ensureColumn(
    'declared_moves',
    'defense_outcome',
    "TEXT CHECK(defense_outcome IN ('success','failed'))"
  );

  await seedRuleset();
  await seedTells();
  await seedBlockTag();
  await seedNoDamageTag();
  await seedFeintTag();
  await seedMovementTags();
  await seedPerks();
}

// Every Perk that has code behind it gets its compendium row created here if
// the world does not already have one (decided, new).
//
// A Perk's mechanics bind to its **name** (see server/perks/index.js for why),
// which leaves one obvious way for the whole thing to quietly not work: the GM
// never creates the row, or creates it under a slightly different spelling, and
// the Perk is ungrantable or inert. Seeding removes that failure entirely — the
// same reasoning, and the same case-insensitive adopt-don't-duplicate guard, as
// seedBlockTag above. A world that already has its own "Genius Observer" keeps
// it, description and picture and all.
async function seedPerks() {
  for (const definition of Object.values(PERK_REGISTRY)) {
    const existing = await one('SELECT id FROM perks WHERE LOWER(TRIM(name)) = ?', [
      definition.name.trim().toLowerCase(),
    ]);
    if (existing) continue;
    await run('INSERT INTO perks (name, description) VALUES (?, ?)', [
      definition.name,
      definition.description ?? '',
    ]);
  }
}

// Block Stamina (decided, new): the **Block** Tag is the first Tag in the
// game that does something mechanical rather than describing something — it
// switches a move onto the absorb-based Stamina rule (see
// server/tagAutomations.js). It is matched by NAME, case-insensitively, and
// never by id, because the GM owns this list: a world that already has its
// own "Block" tag keeps it, tag ids differ between databases, and a GM
// renaming or re-creating the tag must not silently detach the mechanic.
// Only seeded when no case-insensitive match exists at all, so this never
// duplicates a tag the GM already made.
async function seedBlockTag() {
  const existing = await one("SELECT id FROM tags WHERE LOWER(name) = 'block'");
  if (existing) return;
  await run('INSERT INTO tags (name, description) VALUES (?, ?)', [
    'Block',
    "This move guards. It has no up-front Stamina Cost — instead it spends Stamina at resolution for exactly as much of the attack as it absorbed, scaled by its Stamina Modifier.",
  ]);
}

// The second Tag automation (Grappling, decided). A move tagged **No Damage**
// never applies damage — it is measured against its own Success Threshold
// instead. Grappling moves usually carry it, but nothing requires that.
//
// Seeded exactly like the Block tag, and for the same reason: the automation
// matches on the tag's NAME, so the row has to exist for the rule to be
// reachable. Guarded case-insensitively so a database that already has a
// hand-made "No Damage" adopts it rather than ending up with two.
async function seedNoDamageTag() {
  const existing = await one("SELECT id FROM tags WHERE LOWER(name) = 'no damage'");
  if (existing) return;
  await run('INSERT INTO tags (name, description) VALUES (?, ?)', [
    'No Damage',
    'This move deals no damage. It succeeds if its roll reaches the move\u2019s Success Threshold (5 by default) — used on grapples, grabs and setups that move a fight without hurting anyone.',
  ]);
}

// The third Tag automation (decided, new). A move tagged **Feint** hides the
// move declared immediately after it: that follow-up shows no Tell and no
// attack telegraph to anyone but its owner until it reveals in the cutscene.
// The Feint itself is entirely public — a Tell everybody reads and nobody
// should trust.
//
// Seeded exactly like Block and No Damage, and for the same reason: the
// automation matches on the tag's NAME, so the row has to exist for the rule
// to be reachable at all.
async function seedFeintTag() {
  const existing = await one("SELECT id FROM tags WHERE LOWER(name) = 'feint'");
  if (existing) return;
  await run('INSERT INTO tags (name, description) VALUES (?, ?)', [
    'Feint',
    'This move sells a lie. Its own Tell is shown as normal \u2014 but whatever you declare immediately after it goes on the timeline hidden: no Tell, no wind-up, nothing for your opponent to read until it lands.',
  ]);
}

// The Movement / Movement Punisher pair (decided, new). Seeded together
// because neither means anything without the other: Movement is a liability a
// move admits to, and Movement Punisher is the move built to collect on it.
//
// Same case-insensitive adopt-don't-duplicate guard as the Tags above, and for
// the same reason — the mechanic matches on the NAME, so the rows have to exist
// for it to be reachable at all.
async function seedMovementTags() {
  const tags = [
    [
      'Movement',
      'This move takes you somewhere. Useful, and a liability: a move tagged Movement Punisher that connects with you while you are using it puts you on the floor.',
    ],
    [
      'Movement Punisher',
      'Built to catch someone mid-stride. If this connects for real damage against a move tagged Movement, its user trips — 3 Recovery, imposed on the spot.',
    ],
  ];
  for (const [name, description] of tags) {
    const existing = await one('SELECT id FROM tags WHERE LOWER(TRIM(name)) = ?', [name.toLowerCase()]);
    if (existing) continue;
    await run('INSERT INTO tags (name, description) VALUES (?, ?)', [name, description]);
  }
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
  } else {
    // The seed above only ever runs against an empty table, so a database
    // created before COUNTER_BONUS changed still carries the old value —
    // including the deployed one. Re-point every *unmodified* row at the
    // current constant.
    //
    // Deliberately scoped to rows that still hold a previously-shipped
    // default (2, the only value this constant has ever had besides the
    // current one), not a blanket UPDATE: `bonus` is per-row precisely so a
    // table can hand-tune an individual matchup, and a migration must not
    // silently flatten that back to the default.
    await run('UPDATE attribute_counters SET bonus = ? WHERE bonus = 2', [COUNTER_BONUS]);
  }
}
