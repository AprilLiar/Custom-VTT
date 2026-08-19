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

// moves.is_secondary — a plain additive column, so the thing worth pinning is
// that every move authored before it existed reads back as NOT Secondary. The
// default has to be 0 rather than NULL: the declare gate asks `is_secondary` a
// yes/no question, and a whole library that answered "unknown" would be a
// library nobody could declare from.
test('Secondary: an existing move migrates to not-Secondary and stays declarable', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-secondary-${process.pid}-${Date.now()}.db`);
  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(
    `CREATE TABLE moves (id INTEGER PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0)`
  );
  await legacy.execute(`INSERT INTO moves (id, name, is_default) VALUES (5, 'Jab', 1)`);
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  const { initDb, one, run } = await import('../db.js');
  await initDb();

  const row = await one('SELECT * FROM moves WHERE id = 5');
  assert.ok(row, 'the existing move survived');
  assert.equal(row.name, 'Jab');
  assert.equal(row.is_secondary, 0, 'a move that predates the column is not Secondary');

  // And the column actually accepts being set, so a GM can flag one afterward.
  await run('UPDATE moves SET is_secondary = 1 WHERE id = 5');
  assert.equal((await one('SELECT is_secondary FROM moves WHERE id = 5')).is_secondary, 1);

  fs.rmSync(dbPath, { force: true });
});
