// Separate file from migration.test.js / migrationAttackTarget.test.js: Node's
// test runner isolates each FILE (own process/module registry), not each test
// within a file, and the TURSO_DATABASE_URL-then-dynamic-import trick relies
// on that per-file isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

test('Combat Automation overhaul: legacy Defensive moves migrate to defense_kind=block', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-defense-kind-${process.pid}-${Date.now()}.db`);

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
      description TEXT NOT NULL DEFAULT '',
      is_defensive INTEGER NOT NULL DEFAULT 0
    )
  `);
  await legacy.execute(
    "INSERT INTO moves (id, name, is_defensive) VALUES (1, 'Legacy Parry', 1)"
  );
  await legacy.execute(
    "INSERT INTO moves (id, name, is_defensive) VALUES (2, 'Legacy Jab', 0)"
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, run, one } = await import('../db.js');
    await initDb();

    // Rule (decision #10): every pre-existing Defensive move migrates to
    // 'block' — the fully-automatic default — since Block/Dodge didn't exist
    // as authored data before this column, only as an in-the-moment GM call.
    const defensive = await one('SELECT defense_kind FROM moves WHERE id = 1');
    assert.equal(defensive.defense_kind, 'block');

    // A non-Defensive move is left alone (NULL, not backfilled to anything).
    const nonDefensive = await one('SELECT defense_kind FROM moves WHERE id = 2');
    assert.equal(nonDefensive.defense_kind, null);

    // A GM who explicitly flips a migrated move to 'dodge' must not have it
    // silently reset back to 'block' by a later server restart — the
    // backfill UPDATE only ever targets rows still NULL.
    await run(`UPDATE moves SET defense_kind = 'dodge' WHERE id = 1`);
    await initDb();
    const flipped = await one('SELECT defense_kind FROM moves WHERE id = 1');
    assert.equal(flipped.defense_kind, 'dodge');
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
