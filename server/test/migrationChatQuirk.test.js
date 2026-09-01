// The sixth value of `chat_log.kind` — 'quirk', the card a shared Quirk posts.
//
// Its own file for the reason migrationChat.test.js gives: Node's runner
// isolates each FILE, not each test, and the TURSO_DATABASE_URL-then-dynamic-
// import trick depends on that.
//
// **What is actually at risk here is the guard, not the rebuild.** SQLite cannot
// ALTER a CHECK, so every value this column has ever gained arrived by rebuilding
// the table, each time behind a `sql.includes(…)` guard. That guard has to test
// for the NEWEST value: it used to look for 'round_summary', and a production
// database — which is rebuilt for exactly that — would have matched, skipped, and
// kept the five-value CHECK, so every shared Quirk would be refused at the insert
// on a database that had been running for months and on no fresh one. That is the
// failure this file exists to catch, so the fixture below is deliberately a
// database at the PREVIOUS shape rather than a prehistoric one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

test("a chat_log stuck at the five-value CHECK grows to accept 'quirk'", async () => {
  const dbPath = path.join(os.tmpdir(), `chat-quirk-${process.pid}-${Date.now()}.db`);

  const previous = createClient({ url: `file:${dbPath}` });
  await previous.execute(`
    CREATE TABLE chat_log (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'roll' CHECK(kind IN ('roll','message','move_reveal','lane_snapshot','round_summary')),
      character_id INTEGER NOT NULL,
      dice_rolled TEXT NOT NULL,
      modifier INTEGER NOT NULL DEFAULT 0,
      move_id INTEGER,
      content TEXT,
      image_data TEXT,
      image_mime_type TEXT,
      payload TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // A row of history, to prove the rebuild carries the table's contents over
  // rather than starting a fresh one.
  await previous.execute({
    sql: `INSERT INTO chat_log (id, kind, character_id, dice_rolled, content) VALUES (7, 'message', 1, '[]', ?)`,
    args: ['said something'],
  });
  // ...and the old CHECK really did refuse 'quirk' before the migration, or the
  // rest of this test would pass against a database that never needed it.
  await assert.rejects(
    () => previous.execute(`INSERT INTO chat_log (kind, character_id, dice_rolled) VALUES ('quirk', 1, '[]')`),
    'the fixture has to actually be at the old shape'
  );
  await previous.close();

  process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
  const { initDb, all, one, run } = await import('../db.js');
  await initDb();

  const sql = (await one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_log'")).sql;
  assert.match(sql, /'quirk'/, 'the CHECK never grew — the guard matched on an older value');

  // The history is still there, unchanged.
  const kept = await one('SELECT kind, content FROM chat_log WHERE id = 7');
  assert.equal(kept.kind, 'message');
  assert.equal(kept.content, 'said something');

  // ...and a Quirk card can now be written.
  await run(
    `INSERT INTO chat_log (kind, character_id, dice_rolled, payload) VALUES ('quirk', 1, '[]', ?)`,
    [JSON.stringify({ quirkName: 'Bad knee', quirkKind: 'negative' })]
  );
  const rows = await all("SELECT payload FROM chat_log WHERE kind = 'quirk'");
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload).quirkKind, 'negative');

  // A value nobody has ever added is still refused, so the CHECK is a CHECK.
  await assert.rejects(
    () => run(`INSERT INTO chat_log (kind, character_id, dice_rolled) VALUES ('nonsense', 1, '[]')`)
  );

  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});
