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

test('legacy chat_log (kind CHECK only allows roll/message, no move_reveal) survives initDb migration', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-chat-reveal-${process.pid}-${Date.now()}.db`);

  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE chat_log (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL,
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER,
      content TEXT,
      image_data TEXT,
      image_mime_type TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await legacy.execute({
    sql: "INSERT INTO chat_log (kind, character_id, dice_rolled, content) VALUES ('message', ?, '[]', ?)",
    args: [1, 'hello table'],
  });
  // A pre-existing 2-value CHECK really does reject 'move_reveal' — confirms
  // the fixture actually represents the old constraint.
  await assert.rejects(() =>
    legacy.execute({
      sql: "INSERT INTO chat_log (kind, character_id, dice_rolled, move_id) VALUES ('move_reveal', ?, '[]', ?)",
      args: [1, 1],
    })
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, all, run } = await import('../db.js');
    await initDb();

    // Existing message row survived, untouched.
    const rows = await all('SELECT * FROM chat_log');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'message');
    assert.equal(rows[0].content, 'hello table');

    // The CHECK constraint is now the expanded 3-value one.
    await run(
      "INSERT INTO chat_log (kind, character_id, dice_rolled, move_id) VALUES ('move_reveal', ?, '[]', ?)",
      [1, 1]
    );
    const afterRows = await all('SELECT kind FROM chat_log ORDER BY id');
    assert.deepEqual(afterRows.map((r) => r.kind), ['message', 'move_reveal']);
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
