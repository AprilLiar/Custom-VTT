// Separate file from migration.test.js / migrationChat.test.js: Node's test
// runner isolates each FILE (own process/module registry), not each test
// within a file, and the TURSO_DATABASE_URL-then-dynamic-import trick relies
// on that per-file isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

test('legacy combat_state (Uneven Combat toggle only, no Phase 7 columns) survives initDb migration', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-combat-state-${process.pid}-${Date.now()}.db`);

  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE combat_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      uneven_combat_enabled INTEGER NOT NULL DEFAULT 0
    )
  `);
  await legacy.execute('INSERT INTO combat_state (id, uneven_combat_enabled) VALUES (1, 1)');
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, all, run, one } = await import('../db.js');
    await initDb();

    // Existing row survived, with the old toggle untouched and the new
    // columns backfilled to their sane defaults.
    const rows = await all('SELECT * FROM combat_state');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uneven_combat_enabled, 1);
    assert.equal(rows[0].phase, null);
    assert.equal(rows[0].round_number, 0);
    assert.equal(rows[0].current_tic, 0);
    assert.equal(rows[0].round_start_tic, 0);
    assert.equal(rows[0].round_length, 5);
    assert.equal(rows[0].declaring_side, null);
    assert.equal(rows[0].pending_declare_side, null);

    // The new columns' CHECK constraints are live.
    await run("UPDATE combat_state SET phase = 'declaration', declaring_side = 'left' WHERE id = 1");
    const updated = await one('SELECT phase, declaring_side FROM combat_state WHERE id = 1');
    assert.equal(updated.phase, 'declaration');
    assert.equal(updated.declaring_side, 'left');
    await assert.rejects(() => run("UPDATE combat_state SET phase = 'bogus' WHERE id = 1"));
    await assert.rejects(() => run("UPDATE combat_state SET declaring_side = 'up' WHERE id = 1"));

    // declared_moves (a brand new table, not a migrated column) exists too.
    const declaredMovesInfo = await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'declared_moves'");
    assert.equal(declaredMovesInfo.length, 1);
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
