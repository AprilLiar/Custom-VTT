// The boot cleanup's queries, run against a real database.
//
// **One of these deletes artwork, unattended, on every restart.** That is the
// whole reason this file exists: an ownership query that is subtly wrong does
// not throw, does not log, and is not visible in a running session — it just
// quietly takes a GM's uploaded pictures away overnight. So the fixture below
// builds every shape the real tables can be in (a live owner, a deleted owner,
// and a deliberately NULL owner id) and pins which of them survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ORPHAN_SWEEPS,
  countOrphans,
  deleteOrphans,
  trimChatLog,
  pruneOldFightReplays,
} from '../cleanup.js';

const dbPath = path.join(os.tmpdir(), `cleanup-${process.pid}-${Date.now()}.db`);
const db = createClient({ url: `file:${dbPath}` });
process.on('exit', () => {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

const n = async (sql) => Number((await db.execute(sql)).rows[0][0]);

test('setup: a world with live owners, dead owners and ownerless rows', async () => {
  await db.execute('CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT)');
  await db.execute('CREATE TABLE temp_npcs (id INTEGER PRIMARY KEY, name TEXT)');
  await db.execute(
    'CREATE TABLE scene_pictures (id INTEGER PRIMARY KEY, character_id INTEGER, temp_npc_id INTEGER, name TEXT)'
  );
  await db.execute(
    'CREATE TABLE relationship_people (id INTEGER PRIMARY KEY, owner_character_id INTEGER, name TEXT)'
  );
  await db.execute("INSERT INTO characters (id, name) VALUES (1, 'Alive')");
  await db.execute("INSERT INTO temp_npcs (id, name) VALUES (1, 'Grunt')");
  // 1: a live character's picture. 2: a picture whose character was deleted
  // while foreign keys were off. 3: a live Temp NPC's picture — its
  // character_id is NULL BY DESIGN and must never read as an orphan.
  // 4: a Temp NPC picture whose NPC is gone.
  await db.execute("INSERT INTO scene_pictures (id, character_id, name) VALUES (1, 1, 'keep')");
  await db.execute("INSERT INTO scene_pictures (id, character_id, name) VALUES (2, 99, 'orphan')");
  await db.execute("INSERT INTO scene_pictures (id, temp_npc_id, name) VALUES (3, 1, 'keep')");
  await db.execute("INSERT INTO scene_pictures (id, temp_npc_id, name) VALUES (4, 99, 'orphan')");
  await db.execute("INSERT INTO relationship_people (id, owner_character_id, name) VALUES (1, 1, 'keep')");
  await db.execute("INSERT INTO relationship_people (id, owner_character_id, name) VALUES (2, 99, 'orphan')");
  assert.equal(await n('SELECT COUNT(*) FROM scene_pictures'), 4);
});

test('a row whose owner is GONE is an orphan', async () => {
  const [chars, npcs, people] = ORPHAN_SWEEPS;
  assert.equal(await n(countOrphans(chars)), 1, "the deleted character's picture");
  assert.equal(await n(countOrphans(npcs)), 1, "the deleted Temp NPC's picture");
  assert.equal(await n(countOrphans(people)), 1);
});

test('a NULL owner id is NEVER an orphan — it means "not owned this way"', async () => {
  // The load-bearing assertion. scene_pictures has exactly one of
  // character_id/temp_npc_id set by its own CHECK, so reading a NULL as a
  // missing owner would delete every Temp NPC picture in the world on the next
  // restart — and every character picture too, by the other sweep.
  const [chars, npcs] = ORPHAN_SWEEPS;
  const nulls = await n(
    'SELECT COUNT(*) FROM scene_pictures WHERE character_id IS NULL OR temp_npc_id IS NULL'
  );
  assert.equal(nulls, 4, 'every row has one NULL owner column by design');
  assert.equal(await n(countOrphans(chars)) + await n(countOrphans(npcs)), 2, 'only the two real orphans');
});

test('the sweep deletes exactly what it counted, and nothing else', async () => {
  for (const sweep of ORPHAN_SWEEPS) await db.execute(deleteOrphans(sweep));
  const names = (await db.execute('SELECT name FROM scene_pictures ORDER BY id')).rows.map((r) => r[0]);
  assert.deepEqual(names, ['keep', 'keep'], 'both live pictures survived, both orphans went');
  assert.equal(await n('SELECT COUNT(*) FROM relationship_people'), 1);
  // Idempotent: a second boot finds nothing left to do.
  for (const sweep of ORPHAN_SWEEPS) assert.equal(await n(countOrphans(sweep)), 0);
});

test('chat is trimmed to exactly the rows that are readable', async () => {
  await db.execute('CREATE TABLE chat_log (id INTEGER PRIMARY KEY, content TEXT)');
  for (let i = 1; i <= 25; i += 1) await db.execute(`INSERT INTO chat_log (id, content) VALUES (${i}, 'm${i}')`);
  await db.execute(trimChatLog(10));
  const rows = (await db.execute('SELECT id FROM chat_log ORDER BY id')).rows.map((r) => Number(r[0]));
  assert.deepEqual(rows, [16, 17, 18, 19, 20, 21, 22, 23, 24, 25], 'the NEWEST ten, not the oldest');
});

test('trimming a log shorter than the limit keeps everything', async () => {
  await db.execute(trimChatLog(1000));
  assert.equal(await n('SELECT COUNT(*) FROM chat_log'), 10);
});

test('replays from earlier fights are pruned, the current fight is kept', async () => {
  await db.execute(
    'CREATE TABLE pair_round_resolutions (id INTEGER PRIMARY KEY, fight_number INTEGER NOT NULL, status TEXT)'
  );
  await db.execute("INSERT INTO pair_round_resolutions (id, fight_number, status) VALUES (1, 1, 'complete')");
  await db.execute("INSERT INTO pair_round_resolutions (id, fight_number, status) VALUES (2, 2, 'complete')");
  await db.execute("INSERT INTO pair_round_resolutions (id, fight_number, status) VALUES (3, 3, 'complete')");
  await db.execute("INSERT INTO pair_round_resolutions (id, fight_number, status) VALUES (4, 3, 'running')");
  await db.execute(pruneOldFightReplays(3));
  const left = (await db.execute('SELECT id FROM pair_round_resolutions ORDER BY id')).rows.map((r) => Number(r[0]));
  assert.deepEqual(left, [3, 4], 'fights 1 and 2 went; fight 3 — including a round still running — stayed');
});

test('fight 1 prunes nothing, so a brand-new world is untouched', async () => {
  // `fight_number` starts at 1, so `< 1` must match no row at all. Getting this
  // off by one would wipe the only fight a new world has.
  await db.execute(pruneOldFightReplays(1));
  assert.equal(await n('SELECT COUNT(*) FROM pair_round_resolutions'), 2);
});
