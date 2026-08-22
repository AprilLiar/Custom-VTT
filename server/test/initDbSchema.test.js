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
const { all, one, initDb } = await import('../db.js');

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
    ['moves', ['stamina_modifier', 'attack_targets', 'is_secondary', 'sort_order', 'success_threshold']],
    ['combat_state', ['fresh_start', 'fight_number']],
    ['combat_participants', ['grapple_penalty_until_tic']],
    ['declared_moves', ['feint_masked', 'defense_outcome', 'weapon_spent', 'chain_roll_bonus']],
    ['move_roll_slots', ['count']],
    ['characters', ['folder_id', 'vitruvian_image_data', 'pending_roll_penalty']],
    ['chat_log', ['payload', 'image_data']],
  ];
  for (const [table, columns] of expected) {
    const have = await columnsOf(table);
    for (const column of columns) {
      assert.ok(have.has(column), `${table}.${column} missing after the first boot`);
    }
  }
});

test('one boot runs the table-rebuilding migrations too', async () => {
  const sqlFor = async (table) =>
    (await one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])).sql;

  // The base CREATE for move_interactions still declares the 5-value CHECK;
  // grapple_success only arrives via the rebuild.
  assert.match(await sqlFor('move_interactions'), /grapple_success/);
  assert.match(await sqlFor('chat_log'), /round_summary/);
  for (const marker of ['fight_number', 'paused_defense', 'paused_grapple']) {
    assert.match(await sqlFor('pair_round_resolutions'), new RegExp(marker));
  }
});

test('one boot seeds the world exactly once', async () => {
  const counts = Object.fromEntries(
    await Promise.all(
      ['attributes', 'attribute_counters', 'tells', 'tags', 'perks'].map(async (table) => [
        table,
        Number((await one(`SELECT COUNT(*) AS c FROM ${table}`)).c),
      ])
    )
  );
  assert.equal(counts.attributes, 7);
  assert.equal(counts.tells, 2);
  assert.ok(counts.attribute_counters > 0);
  assert.ok(counts.tags >= 5);
  assert.ok(counts.perks > 0);

  // A second boot must be a no-op, not a duplicator — the seeds' guards are
  // now a set membership test against one batched read rather than a SELECT
  // per row, and that is precisely where a duplicate would appear.
  await initDb();
  for (const [table, before] of Object.entries(counts)) {
    const after = Number((await one(`SELECT COUNT(*) AS c FROM ${table}`)).c);
    assert.equal(after, before, `${table} was re-seeded on the second boot`);
  }
});

test('the foreign keys the app looks rows up by are indexed', async () => {
  const indexed = new Set(
    (await all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((row) => row.name)
  );
  for (const name of [
    'idx_round_events_resolution_id',
    'idx_declared_moves_character_id',
    'idx_dice_character_id',
    'idx_move_roll_slots_move_id',
    'idx_chat_log_move_id',
  ]) {
    assert.ok(indexed.has(name), `${name} was not created`);
  }
});
