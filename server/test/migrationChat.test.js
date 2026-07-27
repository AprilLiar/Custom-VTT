// Separate file from migration.test.js: Node's test runner isolates each
// FILE (own process/module registry), not each test within a file, and the
// TURSO_DATABASE_URL-then-dynamic-import trick relies on that per-file
// isolation — a second such test in the same file would just reuse the
// first test's already-cached db.js module (and its already-migrated file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

test('legacy chat_log (rolls only, no kind/content/image columns) survives initDb migration', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-chat-log-${process.pid}-${Date.now()}.db`);

  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE chat_log (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL,
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await legacy.execute({
    sql: 'INSERT INTO chat_log (character_id, dice_rolled, modifier) VALUES (?, ?, ?)',
    args: [1, '[{"slot_name":"Body","size":8,"bonus":0,"result":5}]', 0],
  });
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, all, run } = await import('../db.js');
    await initDb();

    // Existing roll row survived, backfilled with kind='roll'.
    const rows = await all('SELECT * FROM chat_log');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'roll');
    assert.equal(rows[0].content, null);
    assert.equal(rows[0].image_data, null);

    // A free-text message row can now be inserted. The text column is named
    // `content`, not `message` — see the collision note in server/db.js
    // (a column literally named "message" would false-positive-match the
    // kind CHECK constraint's own 'message' enum literal).
    await run(
      "INSERT INTO chat_log (kind, character_id, dice_rolled, content) VALUES ('message', ?, '[]', ?)",
      [1, 'hello table']
    );
    const afterRows = await all('SELECT kind, content FROM chat_log ORDER BY id');
    assert.deepEqual(afterRows, [
      { kind: 'roll', content: null },
      { kind: 'message', content: 'hello table' },
    ]);

    // The kind CHECK constraint is live.
    await assert.rejects(() =>
      run("INSERT INTO chat_log (kind, character_id, dice_rolled) VALUES ('bogus', ?, '[]')", [1])
    );
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
