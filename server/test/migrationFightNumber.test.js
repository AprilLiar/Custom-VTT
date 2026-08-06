// A finished round's replay used to die with the fight — combat:end deleted
// every pair_round_resolutions row and round_events cascades off it, so the
// "Watch Round N" chat card outlived the data it pointed at. Keeping those
// rows means a new fight's round 1 would collide with the old
// UNIQUE(pair_index, round_number), so uniqueness is scoped to a
// fight_number now. SQLite can't ALTER a UNIQUE, so initDb rebuilds the
// table — and with foreign keys ON (this database enables them, unlike stock
// SQLite) a naive rebuild would cascade away exactly the round_events this
// change exists to preserve.
//
// Same per-file TURSO_DATABASE_URL + dynamic-import trick the other
// migration tests use, since Node's test runner isolates each FILE.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `migration-fight-number-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;

const { initDb, run, one, all } = await import('../db.js');

before(async () => {
  // The pre-migration shape, built by hand: no fight_number, uniqueness on
  // (pair_index, round_number) alone, with a round_events row referencing a
  // completed resolution.
  await run(`
    CREATE TABLE pair_round_resolutions (
      id INTEGER PRIMARY KEY,
      pair_index INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      round_start_tic INTEGER NOT NULL,
      round_length INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','paused_dodge','paused_conflict','complete')),
      resolved_through_tic INTEGER NOT NULL DEFAULT 0,
      pending_dodge_json TEXT,
      pending_conflict_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      UNIQUE(pair_index, round_number)
    )
  `);
  await run(`
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
  await run(
    `INSERT INTO pair_round_resolutions (id, pair_index, round_number, round_start_tic, round_length, status)
     VALUES (41, 0, 1, 0, 7, 'complete')`
  );
  await run(
    `INSERT INTO round_events (resolution_id, pair_index, round_number, seq, tic, type, payload)
     VALUES (41, 0, 1, 1, 0, 'reveal', '{"moveName":"Straight"}')`
  );
  await initDb();
});

after(() => {
  delete process.env.TURSO_DATABASE_URL;
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});

test('the rebuilt table keeps every existing resolution, at fight 1', async () => {
  const rows = await all('SELECT id, pair_index, round_number, fight_number, status FROM pair_round_resolutions');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 41,
    pair_index: 0,
    round_number: 1,
    fight_number: 1,
    status: 'complete',
  });
});

test("the rebuild does not cascade away the replay it exists to protect", async () => {
  const events = await all('SELECT resolution_id, type FROM round_events');
  assert.equal(events.length, 1, 'the stored round_events row must survive the table swap');
  // Preserving `id` exactly is what keeps the reference valid across the
  // swap, which is why the rebuild may turn foreign keys off at all.
  assert.equal(events[0].resolution_id, 41);
});

test('foreign keys are back ON after the rebuild', async () => {
  const pragma = await one('PRAGMA foreign_keys');
  assert.equal(pragma.foreign_keys, 1);
});

test('a second fight can reuse pair 0 round 1 alongside the kept row', async () => {
  await run(
    `INSERT INTO pair_round_resolutions (pair_index, round_number, fight_number, round_start_tic, round_length, status)
     VALUES (0, 1, 2, 0, 7, 'running')`
  );
  const rows = await all(
    'SELECT fight_number, status FROM pair_round_resolutions WHERE pair_index = 0 AND round_number = 1 ORDER BY fight_number'
  );
  assert.deepEqual(rows, [
    { fight_number: 1, status: 'complete' },
    { fight_number: 2, status: 'running' },
  ]);
});

test('combat_state carries the arena-wide fight counter, starting at 1', async () => {
  const state = await one('SELECT fight_number FROM combat_state WHERE id = 1');
  assert.equal(state.fight_number, 1);
});
