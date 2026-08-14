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

// The move_interactions rebuild, widening the trigger CHECK to six values.
test('Grappling: the move_interactions rebuild keeps rows and accepts the new trigger', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-grapple-mi-${process.pid}-${Date.now()}.db`);
  const legacy = createClient({ url: `file:${dbPath}` });
  // The rebuilt table carries a real FOREIGN KEY to moves; the fixture needs
  // the move its row points at.
  await legacy.execute(
    `CREATE TABLE moves (id INTEGER PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)`
  );
  await legacy.execute(`INSERT INTO moves (id, name) VALUES (5, 'Jab')`);
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
    `INSERT INTO move_interactions (id, move_id, trigger, text, automations)
     VALUES (42, 5, 'defense_success', 'the guard holds', '[{"type":"self_stamina","amount":2}]')`
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  const { initDb, one, run } = await import('../db.js');
  await initDb();

  const row = await one('SELECT * FROM move_interactions WHERE id = 42');
  assert.ok(row, 'the existing interaction survived');
  assert.equal(row.trigger, 'defense_success');
  assert.equal(row.text, 'the guard holds');
  assert.equal(row.automations, '[{"type":"self_stamina","amount":2}]', 'automations carried across verbatim');

  await run("INSERT INTO move_interactions (move_id, trigger, text) VALUES (5, 'grapple_success', 'the hold takes')");
  assert.equal(
    (await one("SELECT text FROM move_interactions WHERE trigger = 'grapple_success'")).text,
    'the hold takes'
  );

  fs.rmSync(dbPath, { force: true });
});

