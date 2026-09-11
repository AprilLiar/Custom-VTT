// What the database throws away at boot, and why it is safe to.
//
// **This exists because the database is downloaded, whole, several times a
// day.** Render's free tier has no persistent disk, so the embedded replica is
// rebuilt on every cold start — which makes every row that is kept but never
// read a recurring transfer cost rather than a one-off storage cost. Three
// things were accumulating with nothing to prune them.
//
// The queries live here, separately from the handlers that run them, because
// **one of them deletes artwork unattended**. That one is held to the same bar
// as the combat maths (CLAUDE.md's standing rule): built pure, pinned by tests
// against live owners, deleted owners and NULL owner ids, before it is ever
// wired to a boot path.

// Tables whose rows belong to an owner that may have gone away.
//
// `scene_pictures` cascades from both `characters` and `temp_npcs`, and
// `relationship_people` from its owning character — so in a healthy database
// these find nothing. They are not redundant: the six table-rebuild migrations
// in db.js run `PRAGMA foreign_keys = OFF`, and any delete that happened inside
// one of those windows skipped its cascade silently.
//
// **The `IS NOT NULL` is the whole safety property.** A NULL owner id means
// "this row does not claim an owner" — a scene picture owned by a Temp NPC has
// a NULL `character_id` by design (the table's own CHECK enforces exactly one)
// — and must never be read as "its owner is missing". Only a row that names an
// owner who no longer exists is an orphan.
export const ORPHAN_SWEEPS = Object.freeze([
  {
    label: 'scene pictures whose character is gone',
    table: 'scene_pictures',
    column: 'character_id',
    owner: 'characters',
  },
  {
    label: 'scene pictures whose Temp NPC is gone',
    table: 'scene_pictures',
    column: 'temp_npc_id',
    owner: 'temp_npcs',
  },
  {
    label: 'relationship people whose character is gone',
    table: 'relationship_people',
    column: 'owner_character_id',
    owner: 'characters',
  },
]);

// Built rather than written out, so the count and the delete can never disagree
// about what they are looking at — the count is what gets logged, and a log that
// reports a different set than the delete touched is worse than no log.
export const orphanWhere = ({ table, column, owner }) =>
  `FROM ${table} WHERE ${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${owner} o WHERE o.id = ${table}.${column})`;

export const countOrphans = (sweep) => `SELECT COUNT(*) AS n ${orphanWhere(sweep)}`;
export const deleteOrphans = (sweep) => `DELETE ${orphanWhere(sweep)}`;

// **Chat is capped at what is actually readable.** `CHAT_HISTORY_LIMIT` is a
// READ limit — `GET /api/chat` returns the newest N rows — but nothing ever
// deleted the rest, so a long session left everything older sitting in the
// database, unreachable by anybody, being re-downloaded on every cold start.
// Whole rows go, text and picture alike: a row nobody can scroll back to is not
// history, it is residue.
export const trimChatLog = (limit) =>
  `DELETE FROM chat_log WHERE id NOT IN (SELECT id FROM chat_log ORDER BY id DESC LIMIT ${Number(limit)})`;

// **Completed rounds are kept only for the current fight.**
//
// `combat:end` deliberately keeps finished rounds so their "Watch Round N" chat
// card still works. But the chat log is wiped on every boot, so the cards that
// are the only route to an older fight's replays do not survive the restart that
// this runs on — retention already exceeded reachability, and the excess grew
// with every fight ever played.
//
// `round_events` cascades off these rows, which is where the bulk actually is:
// one row per engine event, tens to hundreds per round.
export const pruneOldFightReplays = (currentFightNumber) =>
  `DELETE FROM pair_round_resolutions WHERE fight_number < ${Number(currentFightNumber)}`;
