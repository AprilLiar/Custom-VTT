// Node's test runner isolates each test FILE (own process/worker, own
// module registry), so setting TURSO_DATABASE_URL here before dynamically
// importing db.js is safe — it can't leak into or collide with any other
// test file's own db.js instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

test('legacy move_interactions (3-value trigger CHECK, no is_defensive/parent_id) survives initDb migration', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-move-interactions-${process.pid}-${Date.now()}.db`);

  // Build a minimal legacy schema by hand: the original 3-value CHECK, and
  // moves/character_folders/move_folders without the columns added since.
  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE moves (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      tell_id INTEGER NOT NULL,
      startup_tics INTEGER NOT NULL DEFAULT 1,
      active_tics INTEGER NOT NULL DEFAULT 1,
      recovery_tics INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      style_attribute_id INTEGER,
      folder_id INTEGER,
      image_data TEXT,
      image_mime_type TEXT,
      roll_modifier INTEGER NOT NULL DEFAULT 0,
      right_tell_id INTEGER,
      left_tell_id INTEGER
    )
  `);
  await legacy.execute(`
    CREATE TABLE move_interactions (
      id INTEGER PRIMARY KEY,
      move_id INTEGER NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('hit','block','miss')),
      text TEXT NOT NULL DEFAULT '',
      automations TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await legacy.execute(`
    CREATE TABLE character_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  await legacy.execute(`
    CREATE TABLE move_folders (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `);
  await legacy.execute({
    sql: 'INSERT INTO moves (id, name, tell_id) VALUES (1, ?, 1)',
    args: ['Legacy Jab'],
  });
  await legacy.execute({
    sql: 'INSERT INTO move_interactions (move_id, trigger, text, automations) VALUES (1, ?, ?, ?)',
    args: ['hit', 'Legacy hit text', '[{"type":"self_stamina","amount":2}]'],
  });
  // A pre-existing 3-value CHECK really does reject a defense trigger —
  // confirms the fixture actually represents the old constraint.
  await assert.rejects(() =>
    legacy.execute({
      sql: 'INSERT INTO move_interactions (move_id, trigger, text, automations) VALUES (1, ?, ?, ?)',
      args: ['defense_success', 'nope', '[]'],
    })
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, all, run } = await import('../db.js');
    await initDb();

    // Existing row survived, untouched.
    const rows = await all('SELECT * FROM move_interactions');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].move_id, 1);
    assert.equal(rows[0].trigger, 'hit');
    assert.equal(rows[0].text, 'Legacy hit text');
    assert.deepEqual(JSON.parse(rows[0].automations), [{ type: 'self_stamina', amount: 2 }]);

    // The CHECK constraint is now the expanded 5-value one.
    await run(
      'INSERT INTO move_interactions (move_id, trigger, text, automations) VALUES (?, ?, ?, ?)',
      [1, 'defense_success', 'Countered!', '[]']
    );
    await run(
      'INSERT INTO move_interactions (move_id, trigger, text, automations) VALUES (?, ?, ?, ?)',
      [1, 'defense_failure', 'Overwhelmed', '[]']
    );
    const afterRows = await all('SELECT trigger FROM move_interactions ORDER BY id');
    assert.deepEqual(afterRows.map((r) => r.trigger), ['hit', 'defense_success', 'defense_failure']);

    // moves.is_defensive, moves.stamina_cost, and both folder tables'
    // parent_id were backfilled.
    const move = await all('SELECT is_defensive, stamina_cost FROM moves WHERE id = 1');
    assert.equal(move[0].is_defensive, 0);
    assert.equal(move[0].stamina_cost, 0);
    await run("INSERT INTO character_folders (name) VALUES ('Root Folder')");
    await run(
      "INSERT INTO character_folders (name, parent_id) VALUES ('Child Folder', (SELECT id FROM character_folders WHERE name = 'Root Folder'))"
    );
    const childFolder = await all("SELECT parent_id FROM character_folders WHERE name = 'Child Folder'");
    assert.ok(childFolder[0].parent_id != null);
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
