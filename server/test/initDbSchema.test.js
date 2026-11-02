// initDb's batched boot (Phase 4 of the round-trip work).
//
// Booting used to cost 148 awaited statements against a database that needed
// nothing done; it now costs about ten, by reading `sqlite_master` once and
// sending the schema as one batch instead of one statement at a time. The
// whole bet is that this changes *when* the DDL is sent and nothing else — so
// what is worth pinning is not the trip count but the two ways that bet can
// quietly fail, both of which it did fail before these tests existed:
//
//  1. `ensureColumn` reads a snapshot taken before this boot's CREATEs are
//     sent, so on a brand-new database the table it is about to alter is not
//     in the snapshot at all. Reading only the snapshot silently skipped every
//     ALTER, and a fresh world came up missing three dozen columns that only
//     repaired themselves on its *second* boot.
//  2. The table-rebuilding migrations exist because the base CREATE above them
//     still declares the old shape — so a fresh database is born needing the
//     rebuild. A guard reading the pre-CREATE snapshot saw no table, skipped,
//     and left the new world with the old CHECK constraint.
//
// Both are invisible on the second boot, which is exactly why they are tested
// against the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `initdb-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
const { all, one, run, initDb } = await import('../db.js');

// One boot. Everything below asks what a world looks like the first time it
// is ever started.
await initDb();

process.on('exit', () => {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

const columnsOf = async (table) =>
  new Set((await all(`PRAGMA table_info(${table})`)).map((row) => row.name));

test('one boot adds every ensureColumn column, not just the base CREATE', async () => {
  // A spread across the tables whose base CREATE is furthest behind: each of
  // these exists only because ensureColumn adds it.
  const expected = [
    ['characters', ['folder_id', 'crop_x', 'crop_y', 'crop_w', 'crop_h', 'image_hash']],
    ['chat_log', ['payload', 'image_data']],
    ['temp_npcs', ['crop_x', 'crop_y', 'crop_w', 'crop_h']],
    ['scenes', ['crop_x', 'crop_y', 'crop_w', 'crop_h', 'background_fit', 'image_source_id', 'timestamp_id']],
    ['scene_summons', ['pos_x', 'pos_y', 'scale', 'is_hidden']],
    ['scene_timestamps', ['date', 'is_current']],
    ['relationship_edges', ['bend', 'bend_u']],
  ];
  for (const [table, columns] of expected) {
    const have = await columnsOf(table);
    for (const column of columns) {
      assert.ok(have.has(column), `${table}.${column} missing after the first boot`);
    }
  }
});

test('a fresh world is born without the old system', async () => {
  // The pivot removed the old system's tables and columns from the schema
  // itself, not just from existing databases — a brand-new world must never
  // grow them back.
  const { PURGED_TABLES, OLD_CHARACTER_COLUMNS, OLD_COUNTER_COLUMNS } = await import('../compendiumArchive.js');
  const tables = new Set((await all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  for (const table of PURGED_TABLES) assert.ok(!tables.has(table), `${table} exists on a fresh world`);
  const characterColumns = await columnsOf('characters');
  for (const column of OLD_CHARACTER_COLUMNS) {
    assert.ok(!characterColumns.has(column), `characters.${column} exists on a fresh world`);
  }
  const counterColumns = await columnsOf('counters');
  for (const column of OLD_COUNTER_COLUMNS) {
    assert.ok(!counterColumns.has(column), `counters.${column} exists on a fresh world`);
  }
  // The archive table is there from the start, empty — so the download
  // endpoint never has to ask whether it exists.
  assert.ok(tables.has('compendium_archive'));
  assert.equal(Number((await one('SELECT COUNT(*) AS c FROM compendium_archive')).c), 0);
});

test('one boot runs the table-rebuilding migrations too', async () => {
  const sqlFor = async (table) =>
    (await one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])).sql;
  // chat_log's base CREATE predates some of its kinds; scene_summons' predates
  // its scene_id. Both only arrive through a rebuild.
  assert.match(await sqlFor('chat_log'), /round_summary/);
  assert.match(await sqlFor('scene_summons'), /scene_id/);
});

test('a second boot is a no-op: nothing archived, nothing purged', async () => {
  const { oldSystemPurge } = await import('../db.js');
  assert.equal(oldSystemPurge.status, 'clean');
  await initDb();
  const again = (await import('../db.js')).oldSystemPurge;
  assert.equal(again.status, 'clean');
  assert.equal(Number((await one('SELECT COUNT(*) AS c FROM compendium_archive')).c), 0);
});

test('the foreign keys the app looks rows up by are indexed', async () => {
  const indexed = new Set(
    (await all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((row) => row.name)
  );
  for (const name of [
    'idx_counters_character_id',
    'idx_roleplay_entries_character_id',
    'idx_counter_gates_counter_id',
    'idx_relationship_nodes_owner_character_id',
    'idx_scene_pictures_character_id',
    'idx_scene_drawings_scene_id',
  ]) {
    assert.ok(indexed.has(name), `${name} was not created`);
  }
});
