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

// The No Damage tag seed, which must adopt a GM's existing row rather than
// creating a duplicate the name-matched automation would then see twice.
test('Grappling: the No Damage tag is seeded, and an existing one is adopted not duplicated', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-grapple-tag-${process.pid}-${Date.now()}.db`);
  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '')`);
  // A GM who already made the tag by hand, in their own casing. The seed must
  // leave it alone — the automation matches on name, case-insensitively, so a
  // second row would be a silent duplicate rather than a second rule.
  await legacy.execute(`INSERT INTO tags (id, name, description) VALUES (9, 'no damage', 'mine')`);
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  const { initDb, all } = await import('../db.js');
  await initDb();

  const noDamage = (await all('SELECT * FROM tags')).filter((t) => t.name.toLowerCase() === 'no damage');
  assert.equal(noDamage.length, 1, 'exactly one No Damage tag, not two');
  assert.equal(noDamage[0].id, 9, "the GM's own row is the one that survived");
  assert.equal(noDamage[0].description, 'mine', 'and their description is untouched');

  fs.rmSync(dbPath, { force: true });
});
