// **The old system's archive, and the list of what the pivot removed (decided,
// new).**
//
// The project pivoted away from its original combat system (Moves, Perks,
// Quirks, Stances, the 8 Stat dice, the Combat Arena). Before any of it left the
// database, the Compendium was written into `compendium_archive` as one JSON
// document, so it can be recovered if the pivot is ever undone. Pictures were
// deliberately left out of it — the GM asked for the data, not the art.
//
// Everything here is pure so the rules can be pinned by unit tests: which
// tables are archived, which are dropped and in what order, which columns are
// stripped as pictures, and how a built archive is checked before anything is
// allowed to be deleted. The database work that uses it lives in db.js
// (`archiveAndPurgeOldSystem`).

// The Compendium, plus the two tables its ids point into.
//
// `attributes` and `attribute_counters` are the seven Styles and their counter
// chart. They were never Compendium entries in their own right, but a Move's
// `style_attribute_id` and `combat_style_attribute_id` are numbers into them —
// without them the archive would hold ids that mean nothing.
//
// The per-character rows (`character_moves`, `character_perks`, …) are which
// character had which entry. They are cheap, and "so everything can be
// recovered" includes who had what.
export const ARCHIVED_TABLES = [
  'attributes',
  'attribute_counters',
  'tells',
  'tags',
  'move_folders',
  'moves',
  'move_roll_slots',
  'move_defensive_roll_slots',
  'move_resist_roll_slots',
  'move_grapple_directions',
  'move_interactions',
  'move_tags',
  'perks',
  'perk_tags',
  'perk_tag_links',
  'quirks',
  'character_moves',
  'character_move_tags',
  'character_move_overrides',
  'character_move_roll_bonuses',
  'character_perks',
  'character_quirks',
];

// Every table the pivot removes, **children before parents**, and the order is
// load-bearing: libSQL enforces foreign keys by default (measured on this app's
// own connection), so dropping a parent first does an implicit delete that a
// child's plain REFERENCES refuses with SQLITE_CONSTRAINT_FOREIGNKEY. Because
// the drops share one batch with the archive insert, such a refusal would roll
// the whole batch back — nothing lost, but nothing purged either. No table that
// survives references any of these; that was checked before the list was
// written, and both properties are pinned by tests.
export const PURGED_TABLES = [
  // The Combat Arena and its replays.
  'round_events',
  'pair_round_resolutions',
  'declared_moves',
  'combat_participants',
  'combat_pairs',
  'combat_state',
  'pending_roll_bonuses',
  'temporary_damage',
  // Per-character grants and Perk state.
  'character_perk_state',
  'character_move_overrides',
  'character_move_roll_bonuses',
  'character_move_tags',
  'character_moves',
  'character_perks',
  'character_quirks',
  // Perks.
  'perk_tag_links',
  'perk_tags',
  'perks',
  // Moves.
  'move_tags',
  'move_roll_slots',
  'move_defensive_roll_slots',
  'move_resist_roll_slots',
  'move_interactions',
  'move_grapple_directions',
  'moves',
  'move_folders',
  'tags',
  'tells',
  'quirks',
  // The rest of the character sheet that did not survive.
  'stances',
  'attribute_counters',
  'attributes',
  'dice',
  'injuries',
  'inventory_items',
  'weapons',
];

// Columns on `characters` that belonged to the removed sheet: the Core Stats
// backdrop picture, the active Stance, Stamina, and the next-roll debt. Their
// data is cleared and the columns dropped.
export const OLD_CHARACTER_COLUMNS = [
  'vitruvian_image_data',
  'vitruvian_image_mime_type',
  'vitruvian_image_hash',
  'active_stance_id',
  'stamina_multiplier',
  'max_stamina',
  'current_stamina',
  'pending_roll_penalty',
  'pending_roll_penalty_tic',
];

// The Counters' "Show in combat" flag only ever fed the Arena card.
export const OLD_COUNTER_COLUMNS = ['show_in_combat'];

// Left out of the archive: the picture itself and everything that only
// describes it.
export const PICTURE_COLUMNS = ['image_data', 'image_mime_type', 'image_hash', 'crop_x', 'crop_y', 'crop_w', 'crop_h'];

export const ARCHIVE_FORMAT = 'dogfight-old-system-archive';
export const ARCHIVE_VERSION = 1;

export function stripPictures(row) {
  const out = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    if (!PICTURE_COLUMNS.includes(key)) out[key] = value;
  }
  return out;
}

// `rowsByTable` is `{ tableName: rows[] }` for every archived table that
// exists; a table missing from it was not there to archive and is simply
// absent from the result rather than recorded as empty — the two mean
// different things to whoever reads this later.
export function buildArchive({ rowsByTable, characterNames = [], archivedAt }) {
  const tables = {};
  const counts = {};
  for (const name of ARCHIVED_TABLES) {
    if (!Object.hasOwn(rowsByTable, name)) continue;
    tables[name] = rowsByTable[name].map(stripPictures);
    counts[name] = tables[name].length;
  }
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    archivedAt,
    note:
      'The Compendium (Moves, Tells, Tags, Perks, Perk Tags, Quirks, Move folders), the Styles its ids ' +
      'point into, and which character had which entry — exactly as the database held them when the old ' +
      'system was removed. Pictures are not included.',
    counts,
    // Characters survive the pivot, but a link row names its character by id
    // only; the names make the file readable on its own and outlive a later
    // deletion of the character.
    characterNames: characterNames.map((c) => ({ id: c.id, name: c.name })),
    tables,
  };
}

// **Nothing is deleted until this says the archive is whole.**
//
// `expectedCounts` is `SELECT COUNT(*)` for each archived table, read in the
// same transaction as the rows. Two things have to hold:
//
//   - every table's row count in the archive equals what the database counted,
//     so nothing was missed by the read; and
//   - the serialised text parses back to exactly what was built, so nothing
//     was lost turning it into the string that gets stored.
//
// Returns every problem rather than the first, so a boot log can say all of
// what was wrong in one go.
export function verifyArchive({ archive, serialized, expectedCounts }) {
  const problems = [];
  let parsed = null;
  try {
    parsed = JSON.parse(serialized);
  } catch (err) {
    problems.push(`archive text does not parse: ${err.message}`);
  }
  if (parsed && JSON.stringify(parsed) !== JSON.stringify(archive)) {
    problems.push('archive text does not round-trip to the archive that was built');
  }
  for (const [table, expected] of Object.entries(expectedCounts)) {
    const got = archive.tables?.[table]?.length;
    if (got !== expected) problems.push(`${table}: archived ${got ?? 'nothing'} of ${expected} row(s)`);
  }
  for (const table of Object.keys(archive.tables ?? {})) {
    if (!Object.hasOwn(expectedCounts, table)) problems.push(`${table}: archived but never counted`);
  }
  return { ok: problems.length === 0, problems };
}
