// Separate file from the other migration*.test.js files: Node's test runner
// isolates each FILE (own process/module registry), not each test within a
// file, and the TURSO_DATABASE_URL-then-dynamic-import trick relies on that
// per-file isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

test('legacy combat_participants (no reasons_to_fight column) survives initDb migration', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-combat-participants-${process.pid}-${Date.now()}.db`);

  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT NOT NULL)
  `);
  await legacy.execute("INSERT INTO characters (id, name) VALUES (1, 'Legacy Fighter')");
  await legacy.execute(`
    CREATE TABLE combat_participants (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      side TEXT NOT NULL CHECK(side IN ('left','right')),
      pair_index INTEGER NOT NULL,
      declared_this_round INTEGER NOT NULL DEFAULT 0,
      UNIQUE(character_id)
    )
  `);
  await legacy.execute(
    "INSERT INTO combat_participants (character_id, side, pair_index) VALUES (1, 'left', 0)"
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, all, run, one } = await import('../db.js');
    await initDb();

    const rows = await all('SELECT * FROM combat_participants');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reasons_to_fight, 0);
    assert.equal(rows[0].idle_regen_progress, 0);

    await run('UPDATE combat_participants SET reasons_to_fight = 3 WHERE character_id = 1');
    const updated = await one('SELECT reasons_to_fight FROM combat_participants WHERE character_id = 1');
    assert.equal(updated.reasons_to_fight, 3);
    await assert.rejects(() =>
      run('UPDATE combat_participants SET reasons_to_fight = 4 WHERE character_id = 1')
    );

    await run('UPDATE combat_participants SET idle_regen_progress = 5 WHERE character_id = 1');
    const progress = await one('SELECT idle_regen_progress FROM combat_participants WHERE character_id = 1');
    assert.equal(progress.idle_regen_progress, 5);
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
