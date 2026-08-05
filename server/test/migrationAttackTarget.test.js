// Separate file from migration.test.js / migrationCombat.test.js: Node's test
// runner isolates each FILE (own process/module registry), not each test
// within a file, and the TURSO_DATABASE_URL-then-dynamic-import trick relies
// on that per-file isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

test('Attack Target (Change 001): legacy moves/declared_moves survive initDb migration with the documented defaults', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-attack-target-${process.pid}-${Date.now()}.db`);

  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE moves (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      tell_id INTEGER,
      startup_tics INTEGER NOT NULL DEFAULT 1,
      active_tics INTEGER NOT NULL DEFAULT 1,
      recovery_tics INTEGER NOT NULL DEFAULT 0,
      stamina_cost INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT ''
    )
  `);
  await legacy.execute("INSERT INTO moves (id, name) VALUES (1, 'Legacy Move')");
  await legacy.execute(`
    CREATE TABLE declared_moves (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      move_id INTEGER NOT NULL,
      round_number INTEGER NOT NULL,
      queue_order INTEGER NOT NULL,
      placement_tic INTEGER NOT NULL,
      reveal_tic INTEGER NOT NULL
    )
  `);
  await legacy.execute(
    'INSERT INTO declared_moves (id, character_id, move_id, round_number, queue_order, placement_tic, reveal_tic) VALUES (1, 1, 1, 1, 1, 1, 1)'
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, all, run, one } = await import('../db.js');
    await initDb();

    // Rule: "При миграции каждому уже существующему Move назначается только
    // Skull" — the DB default backfills every pre-existing row.
    const move = await one('SELECT attack_targets FROM moves WHERE id = 1');
    assert.equal(move.attack_targets, '["Skull"]');

    // A pre-existing declared_moves row gets the matching ['Skull'] snapshot
    // too, with source 'move' — it predates this Change entirely, so there's
    // no Block to have replaced it.
    const declared = await one(
      'SELECT effective_attack_targets, attack_target_source FROM declared_moves WHERE id = 1'
    );
    assert.equal(declared.effective_attack_targets, '["Skull"]');
    assert.equal(declared.attack_target_source, 'move');

    // A fresh Move created after migration is NOT re-filled — an explicit
    // empty array must survive untouched, never re-defaulted back to Skull
    // by a later server restart (see writeMove/db.js's own note on this).
    await run(
      `INSERT INTO moves (id, name, tell_id, attack_targets) VALUES (2, 'New Move', 1, '[]')`
    );
    await initDb();
    const freshMove = await one('SELECT attack_targets FROM moves WHERE id = 2');
    assert.equal(freshMove.attack_targets, '[]');
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
