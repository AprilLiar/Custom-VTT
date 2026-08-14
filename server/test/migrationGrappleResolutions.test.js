// Separate file per migration test for the reason every other migration test
// here is: Node's test runner isolates each FILE (own process/module
// registry), not each test within a file, and the
// TURSO_DATABASE_URL-then-dynamic-import trick relies on that per-file
// isolation. Two of these in one file and the second silently runs against
// the first one's database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

// The dangerous rebuild: `round_events` has a foreign key onto
// pair_round_resolutions, so doing this with foreign keys ON would
// cascade-delete every stored round replay in the database. The migration
// turns them off for the swap and preserves `id` exactly — this is what
// proves it.
test('Grappling: the pair_round_resolutions rebuild keeps rows, ids and their round_events', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-grapple-${process.pid}-${Date.now()}.db`);

  // A v3-shaped table: what a database that has had the Defence-rework
  // groundwork but not Grappling actually looks like.
  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE pair_round_resolutions (
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
      completed_at TEXT
    )
  `);
  await legacy.execute(`
    CREATE TABLE round_events (
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
  // Id 7 deliberately non-sequential — the rebuild must preserve it exactly,
  // because the replay row below points at it.
  await legacy.execute(
    `INSERT INTO pair_round_resolutions (id, pair_index, round_number, round_start_tic, round_length, status, resolved_through_tic)
     VALUES (7, 0, 3, 14, 7, 'complete', 6)`
  );
  await legacy.execute(
    `INSERT INTO round_events (id, resolution_id, pair_index, round_number, seq, tic, type, payload)
     VALUES (1, 7, 0, 3, 0, 14, 'reveal', '{"moveName":"Jab"}')`
  );
  // The rebuilt move_interactions carries a real FOREIGN KEY to moves, so the
  // fixture needs the move its row points at — a legacy database always has
  // one, and without it the rebuild's INSERT..SELECT fails the constraint.
  await legacy.execute(
    `CREATE TABLE moves (id INTEGER PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)`
  );
  await legacy.execute(`INSERT INTO moves (id, name) VALUES (5, 'Jab')`);
  // A legacy move_interactions with the five-value CHECK.
  await legacy.execute(`
    CREATE TABLE move_interactions (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss','defense_success','defense_failure')),
      text TEXT NOT NULL DEFAULT '',
      automations TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await legacy.execute(
    `INSERT INTO move_interactions (id, move_id, trigger, text) VALUES (42, 5, 'hit', 'it connects')`
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  const { initDb, one, all, run } = await import('../db.js');
  await initDb();

  const sql = (await one("SELECT sql FROM sqlite_master WHERE name = 'pair_round_resolutions'")).sql;
  assert.ok(sql.includes('paused_grapple'), 'the new pause status is in the CHECK');
  assert.ok(sql.includes('pending_grapple_json'), 'the new pending column exists');
  assert.ok(sql.includes('paused_defense'), 'the dormant Defence-rework status is carried through');

  const resolution = await one('SELECT * FROM pair_round_resolutions WHERE id = 7');
  assert.ok(resolution, 'the existing resolution survived the rebuild');
  assert.equal(resolution.round_number, 3);
  assert.equal(resolution.status, 'complete');
  assert.equal(resolution.resolved_through_tic, 6);

  // The whole reason for the PRAGMA foreign_keys dance.
  const events = await all('SELECT * FROM round_events WHERE resolution_id = 7');
  assert.equal(events.length, 1, 'the stored replay was NOT cascade-deleted by the rebuild');
  assert.equal(events[0].type, 'reveal');

  // And the new status is actually writable — the CHECK really did widen.
  await run("UPDATE pair_round_resolutions SET status = 'paused_grapple' WHERE id = 7");
  assert.equal((await one('SELECT status FROM pair_round_resolutions WHERE id = 7')).status, 'paused_grapple');

  fs.rmSync(dbPath, { force: true });
});

