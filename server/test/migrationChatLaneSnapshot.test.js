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

test('chat_log with the pre-lane_snapshot 3-value kind CHECK (the currently-deployed shape) survives initDb migration', async () => {
  const dbPath = path.join(os.tmpdir(), `legacy-chat-lane-snapshot-${process.pid}-${Date.now()}.db`);

  const legacy = createClient({ url: `file:${dbPath}` });
  await legacy.execute(`
    CREATE TABLE chat_log (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal')),
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
    sql: "INSERT INTO chat_log (kind, character_id, dice_rolled, move_id) VALUES ('move_reveal', ?, '[]', ?)",
    args: [1, 1],
  });
  // A pre-existing 3-value CHECK really does reject 'lane_snapshot' — confirms
  // the fixture actually represents the old constraint.
  await assert.rejects(() =>
    legacy.execute({
      sql: "INSERT INTO chat_log (kind, character_id, dice_rolled) VALUES ('lane_snapshot', ?, '[]')",
      args: [1],
    })
  );
  legacy.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  delete process.env.TURSO_AUTH_TOKEN;

  try {
    const { initDb, all, run } = await import('../db.js');
    await initDb();

    // Existing move_reveal row survived, untouched.
    const rows = await all('SELECT * FROM chat_log');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'move_reveal');
    assert.equal(rows[0].move_id, 1);

    // The CHECK constraint is now the expanded 4-value one, and the new
    // payload column exists and round-trips JSON.
    const payload = JSON.stringify({ pairIndex: 0, moves: [] });
    await run(
      "INSERT INTO chat_log (kind, character_id, dice_rolled, payload) VALUES ('lane_snapshot', ?, '[]', ?)",
      [1, payload]
    );
    const afterRows = await all('SELECT kind, payload FROM chat_log ORDER BY id');
    assert.deepEqual(afterRows.map((r) => r.kind), ['move_reveal', 'lane_snapshot']);
    assert.equal(afterRows[1].payload, payload);
  } finally {
    delete process.env.TURSO_DATABASE_URL;
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
});
