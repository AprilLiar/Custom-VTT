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

// chat_log.kind originally had a 2-value CHECK ('roll','message'). Same
// rebuild pattern as move_interactions.trigger above — a fresh database's
// CREATE TABLE IF NOT EXISTS already gets the expanded CHECK directly, so
// this only fires against a database created before move_reveal existed.
async function migrateChatLogKind() {
  const row = await one(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_log'"
  );
  if (!row || row.sql.includes('move_reveal')) return;
  await run(`
    CREATE TABLE chat_log_v2 (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL,
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER,
      content TEXT,
      image_data TEXT,
      image_mime_type TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`
    INSERT INTO chat_log_v2 (id, kind, character_id, dice_rolled, modifier, move_id, content, image_data, image_mime_type, created_at)
    SELECT id, kind, character_id, dice_rolled, modifier, move_id, content, image_data, image_mime_type, created_at FROM chat_log
  `);
  await run('DROP TABLE chat_log');
  await run('ALTER TABLE chat_log_v2 RENAME TO chat_log');
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
  // kind='message' rows are free-text chat posts (optionally with an
  // attached image/GIF); kind='move_reveal' rows mark a declared move's
  // reveal (move_id set, posted automatically — see combat:tic_forward);
  // dice_rolled stays '[]' for both rather than NULL, since it predates
  // them and was already NOT NULL on existing databases. The text column is
  // named `content`, not `message` — a column literally named "message"
  // would collide with ensureColumn's word-boundary detection, which would
  // then false-positive-match the CHECK constraint's own `'message'` enum
  // literal above and skip adding the column entirely.
  await run(`
    CREATE TABLE IF NOT EXISTS chat_log (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL, -- JSON array of {slot_name, size, bonus, result}
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER, -- set for kind='move_reveal'; no FK, same survive-deletion reasoning as character_id
      content TEXT, -- free-text message content; kind='message' only
      image_data TEXT, -- base64; kind='message' only. GIFs stored raw/unresized to keep animation
      image_mime_type TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await ensureColumn(
    'chat_log',
    'kind',
    "TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal'))"
  );
  await ensureColumn('chat_log', 'content', 'TEXT');
  await ensureColumn('chat_log', 'image_data', 'TEXT');
  await ensureColumn('chat_log', 'image_mime_type', 'TEXT');
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
      is_defensive INTEGER NOT NULL DEFAULT 0
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
  // JSON array of 0-based indices into the move's full frame sequence
  // (Startup squares first, then Active, then Recovery) marking which
  // squares also grant a defensive window — see sanitizeDefensePositions in
  // moveLogic.js. Purely a display annotation, not a timing phase.
  await ensureColumn('moves', 'defense_frame_positions', "TEXT NOT NULL DEFAULT '[]'");
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
      UNIQUE(character_id)
    )
  `);
  await ensureColumn('combat_participants', 'declared_this_round', 'INTEGER NOT NULL DEFAULT 0');

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
      declaring_side TEXT CHECK(declaring_side IN ('left','right'))
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
