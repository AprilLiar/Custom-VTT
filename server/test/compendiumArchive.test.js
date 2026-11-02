// The old system's archive and purge lists (see server/compendiumArchive.js).
//
// What is pinned here is the part that has to be right BEFORE anything is
// deleted: what goes into the archive, what is stripped as a picture, the order
// tables are dropped in, and the check that stands between a built archive and
// the DROP statements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVED_TABLES,
  OLD_CHARACTER_COLUMNS,
  PICTURE_COLUMNS,
  PURGED_TABLES,
  buildArchive,
  stripPictures,
  verifyArchive,
} from '../compendiumArchive.js';

test('everything archived is also purged — nothing is archived and then left behind', () => {
  for (const table of ARCHIVED_TABLES) assert.ok(PURGED_TABLES.includes(table), table);
});

test('no table is listed twice', () => {
  assert.equal(new Set(PURGED_TABLES).size, PURGED_TABLES.length);
  assert.equal(new Set(ARCHIVED_TABLES).size, ARCHIVED_TABLES.length);
});

test('the profile picture and the character identity are never on the drop list', () => {
  for (const column of ['id', 'name', 'character_type', 'image_data', 'image_mime_type', 'image_hash', 'folder_id']) {
    assert.ok(!OLD_CHARACTER_COLUMNS.includes(column), column);
  }
});

test('nothing the pivot keeps is on the drop list', () => {
  const kept = [
    'characters', 'character_folders', 'chat_log', 'roleplay_entries', 'counters', 'counter_gates',
    'relationship_people', 'relationship_nodes', 'relationship_edges', 'temp_npc_folders', 'temp_npcs',
    'scene_folders', 'scenes', 'scene_state', 'scene_pictures', 'scene_summons', 'scene_notes',
    'master_note', 'scene_drawings', 'scene_timestamps', 'audio_playlists', 'audio_tracks', 'audio_state',
    'compendium_archive',
  ];
  for (const table of kept) assert.ok(!PURGED_TABLES.includes(table), table);
});

// The foreign keys between purged tables, child -> parents. Dropping a parent
// while a child still references it is the one thing that could make a DROP
// fail (or cascade) when foreign keys are enforced, so every child must come
// first in PURGED_TABLES.
const FK = {
  round_events: ['pair_round_resolutions'],
  declared_moves: ['moves'],
  character_perk_state: ['character_perks'],
  character_move_overrides: ['character_perks', 'moves'],
  character_move_roll_bonuses: ['character_perks', 'moves'],
  character_move_tags: ['character_perks', 'moves', 'tags'],
  character_moves: ['moves'],
  character_perks: ['perks'],
  perk_tag_links: ['perk_tags', 'perks'],
  move_tags: ['moves', 'tags'],
  move_roll_slots: ['moves'],
  move_defensive_roll_slots: ['moves'],
  move_resist_roll_slots: ['moves'],
  move_interactions: ['moves'],
  move_grapple_directions: ['moves'],
  moves: ['attributes', 'tells'],
  stances: ['attributes'],
  attribute_counters: ['attributes'],
};

test('every child table is dropped before the parents it references', () => {
  for (const [child, parents] of Object.entries(FK)) {
    for (const parent of parents) {
      assert.ok(
        PURGED_TABLES.indexOf(child) < PURGED_TABLES.indexOf(parent),
        `${child} must be dropped before ${parent}`
      );
    }
  }
});

test('stripPictures removes the picture and everything describing it, and nothing else', () => {
  const row = {
    id: 3, name: 'Jab', description: 'quick', image_data: 'AAAA', image_mime_type: 'image/png',
    image_hash: 'h', crop_x: 0.1, crop_y: 0.2, crop_w: 0.5, crop_h: 0.5, tell_id: 4,
  };
  assert.deepEqual(stripPictures(row), { id: 3, name: 'Jab', description: 'quick', tell_id: 4 });
  for (const column of PICTURE_COLUMNS) assert.ok(!(column in stripPictures(row)));
});

test('buildArchive keeps only archived tables, strips pictures, and counts rows', () => {
  const archive = buildArchive({
    rowsByTable: {
      moves: [{ id: 1, name: 'Jab', image_data: 'AAAA' }],
      perks: [],
      dice: [{ id: 9 }], // purged without export — must not leak into the archive
    },
    characterNames: [{ id: 1, name: 'Mira', image_data: 'BBBB' }],
    archivedAt: '2026-11-02T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(archive.tables), ['moves', 'perks']);
  assert.deepEqual(archive.tables.moves, [{ id: 1, name: 'Jab' }]);
  assert.deepEqual(archive.counts, { moves: 1, perks: 0 });
  assert.deepEqual(archive.characterNames, [{ id: 1, name: 'Mira' }]);
  assert.ok(!JSON.stringify(archive).includes('AAAA'));
  assert.ok(!JSON.stringify(archive).includes('BBBB'));
});

test('a table that was not there is absent, not recorded as empty', () => {
  const archive = buildArchive({ rowsByTable: { moves: [] }, archivedAt: 'x' });
  assert.ok('moves' in archive.tables);
  assert.ok(!('quirks' in archive.tables));
});

const goodArchive = () =>
  buildArchive({
    rowsByTable: { moves: [{ id: 1, name: 'Jab' }, { id: 2, name: 'Hook' }], quirks: [{ id: 1, name: 'Shy' }] },
    archivedAt: 'x',
  });

test('verifyArchive passes a whole archive', () => {
  const archive = goodArchive();
  const result = verifyArchive({ archive, serialized: JSON.stringify(archive), expectedCounts: { moves: 2, quirks: 1 } });
  assert.deepEqual(result, { ok: true, problems: [] });
});

test('verifyArchive refuses an archive missing rows the database counted', () => {
  const archive = goodArchive();
  const result = verifyArchive({ archive, serialized: JSON.stringify(archive), expectedCounts: { moves: 3, quirks: 1 } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /moves: archived 2 of 3/);
});

test('verifyArchive refuses a table that was counted but never archived', () => {
  const archive = goodArchive();
  const result = verifyArchive({
    archive, serialized: JSON.stringify(archive), expectedCounts: { moves: 2, quirks: 1, perks: 4 },
  });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /perks: archived nothing of 4/);
});

test('verifyArchive refuses text that does not round-trip to what was built', () => {
  const archive = goodArchive();
  const tampered = JSON.stringify({ ...archive, tables: { ...archive.tables, moves: [{ id: 1, name: 'Jab' }] } });
  const result = verifyArchive({ archive, serialized: tampered, expectedCounts: { moves: 2, quirks: 1 } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /round-trip/);
});

test('verifyArchive refuses text that does not parse at all', () => {
  const archive = goodArchive();
  const result = verifyArchive({ archive, serialized: '{not json', expectedCounts: { moves: 2, quirks: 1 } });
  assert.equal(result.ok, false);
  assert.match(result.problems.join(), /does not parse/);
});
