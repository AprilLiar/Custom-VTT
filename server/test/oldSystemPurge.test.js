// The pivot's one-time boot step: archive the old Compendium, then remove the
// old system (see archiveAndPurgeOldSystem in db.js).
//
// Built against a database shaped like a deployed world from before the pivot —
// old tables with rows in them, the old columns on `characters` and `counters`,
// foreign keys between the old tables, and foreign-key enforcement ON — because
// that is the database it actually runs against, once, in production. The pure
// rules (what is archived, the check before anything is dropped) are pinned in
// compendiumArchive.test.js; this pins that the boot wires them up correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';

const dbPath = path.join(os.tmpdir(), `purge-${process.pid}-${Date.now()}.db`);
process.on('exit', () => {
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {
      /* nothing to clean up */
    }
  }
});

// ---- A pre-pivot world, written directly so nothing new shapes it.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const seed = createClient({ url: `file:${dbPath}` });
for (const sql of [
  'PRAGMA foreign_keys = ON',
  `CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
     character_type TEXT NOT NULL DEFAULT 'pc', image_data TEXT, image_mime_type TEXT,
     vitruvian_image_data TEXT, vitruvian_image_mime_type TEXT, active_stance_id INTEGER,
     stamina_multiplier INTEGER NOT NULL DEFAULT 4, max_stamina INTEGER NOT NULL DEFAULT 0,
     current_stamina INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
     folder_id INTEGER, pending_roll_penalty INTEGER NOT NULL DEFAULT 0, pending_roll_penalty_tic INTEGER)`,
  `CREATE TABLE counters (id INTEGER PRIMARY KEY, character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
     name TEXT NOT NULL, target_pips INTEGER NOT NULL, current_pips INTEGER NOT NULL DEFAULT 0,
     show_in_combat INTEGER NOT NULL DEFAULT 0, reward_type TEXT)`,
  'CREATE TABLE attributes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, icon TEXT NOT NULL DEFAULT \'\')',
  'CREATE TABLE tells (id INTEGER PRIMARY KEY, name TEXT NOT NULL, image_data TEXT, image_mime_type TEXT)',
  'CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\')',
  // A plain REFERENCES with no ON DELETE: with enforcement on, dropping `moves`
  // before this table would be refused. Drop order is what keeps it working.
  `CREATE TABLE moves (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tell_id INTEGER NOT NULL REFERENCES tells(id),
     style_attribute_id INTEGER REFERENCES attributes(id), description TEXT, image_data TEXT, image_mime_type TEXT)`,
  `CREATE TABLE move_tags (id INTEGER PRIMARY KEY, move_id INTEGER NOT NULL REFERENCES moves(id),
     tag_id INTEGER NOT NULL REFERENCES tags(id))`,
  'CREATE TABLE perks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, image_data TEXT, image_mime_type TEXT)',
  `CREATE TABLE character_perks (id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL REFERENCES characters(id),
     perk_id INTEGER NOT NULL REFERENCES perks(id))`,
  `CREATE TABLE character_perk_state (id INTEGER PRIMARY KEY,
     character_perk_id INTEGER NOT NULL REFERENCES character_perks(id), key TEXT NOT NULL, value INTEGER)`,
  "CREATE TABLE quirks (id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL DEFAULT 'positive')",
  `CREATE TABLE dice (id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL REFERENCES characters(id),
     pool TEXT NOT NULL, slot_name TEXT NOT NULL, current_size INTEGER NOT NULL DEFAULT 4)`,
  `INSERT INTO characters (id, name, image_data, image_mime_type, vitruvian_image_data, current_stamina, max_stamina)
     VALUES (1, 'Mira', '${PNG}', 'image/png', '${PNG}', 9, 16)`,
  "INSERT INTO counters (id, character_id, name, target_pips, current_pips, show_in_combat) VALUES (1, 1, 'Grudge', 5, 2, 1)",
  "INSERT INTO attributes (id, name) VALUES (1, 'Speed'), (2, 'Power')",
  `INSERT INTO tells (id, name, image_data) VALUES (1, 'Shoulder drops', '${PNG}')`,
  "INSERT INTO tags (id, name) VALUES (1, 'Feint')",
  `INSERT INTO moves (id, name, tell_id, style_attribute_id, description, image_data)
     VALUES (1, 'Jab', 1, 1, 'Quick', '${PNG}'), (2, 'Hook', 1, 2, 'Wide', NULL)`,
  'INSERT INTO move_tags (move_id, tag_id) VALUES (1, 1)',
  `INSERT INTO perks (id, name, description, image_data) VALUES (1, 'Iron Skin', 'Tough', '${PNG}')`,
  'INSERT INTO character_perks (id, character_id, perk_id) VALUES (1, 1, 1)',
  "INSERT INTO character_perk_state (character_perk_id, key, value) VALUES (1, 'charges', 2)",
  "INSERT INTO quirks (name, description, kind) VALUES ('Shy', 'Quiet', 'negative')",
  "INSERT INTO dice (character_id, pool, slot_name) VALUES (1, 'head', 'Skull'), (1, 'head', 'Brain')",
]) {
  await seed.execute(sql);
}
seed.close();

// ---- The boot.
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
const db = await import('../db.js');
await db.initDb();
const purge = db.oldSystemPurge;
const tables = new Set((await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
const columnsOf = async (table) => new Set((await db.all(`PRAGMA table_info(${table})`)).map((r) => r.name));

test('the boot archived and purged, with nothing left over', () => {
  assert.equal(purge.status, 'purged');
  assert.deepEqual(purge.problems, [], 'every old column dropped cleanly');
});

test('exactly one archive was written, holding every archived row', async () => {
  const rows = await db.all('SELECT counts, payload FROM compendium_archive');
  assert.equal(rows.length, 1);
  const doc = JSON.parse(rows[0].payload);
  assert.deepEqual(JSON.parse(rows[0].counts), doc.counts, 'the listing counts are the document counts');
  assert.deepEqual(doc.counts, {
    attributes: 2, tells: 1, tags: 1, moves: 2, move_tags: 1, perks: 1, quirks: 1, character_perks: 1,
  });
  assert.deepEqual(doc.tables.moves.map((m) => m.name), ['Jab', 'Hook']);
  assert.equal(doc.tables.moves[0].description, 'Quick');
  assert.deepEqual(doc.characterNames, [{ id: 1, name: 'Mira' }]);
  // Purged without export: per-character state that is not the Compendium.
  assert.ok(!('dice' in doc.tables));
  assert.ok(!('character_perk_state' in doc.tables));
});

test('no picture reached the archive', async () => {
  const { payload } = await db.one('SELECT payload FROM compendium_archive');
  assert.ok(!payload.includes('image_data'));
  assert.ok(!payload.includes(PNG.slice(0, 24)));
});

test('every old table is gone — including ones a plain foreign key pointed into', async () => {
  for (const table of ['moves', 'move_tags', 'tells', 'tags', 'attributes', 'perks', 'character_perks',
    'character_perk_state', 'quirks', 'dice']) {
    assert.ok(!tables.has(table), `${table} survived`);
  }
});

test('the character survives with its profile picture, minus every old column', async () => {
  const character = await db.one('SELECT * FROM characters WHERE id = 1');
  assert.equal(character.name, 'Mira');
  assert.equal(character.image_data, PNG, 'the profile picture is byte-identical');
  const columns = await columnsOf('characters');
  for (const column of ['vitruvian_image_data', 'vitruvian_image_mime_type', 'active_stance_id', 'stamina_multiplier',
    'max_stamina', 'current_stamina', 'pending_roll_penalty', 'pending_roll_penalty_tic']) {
    assert.ok(!columns.has(column), `characters.${column} survived`);
  }
});

test('the Counter survives, minus its Show in Combat flag', async () => {
  const counter = await db.one('SELECT * FROM counters WHERE id = 1');
  assert.deepEqual(
    { name: counter.name, target: counter.target_pips, current: counter.current_pips },
    { name: 'Grudge', target: 5, current: 2 }
  );
  assert.ok(!(await columnsOf('counters')).has('show_in_combat'));
});

test('a second boot changes nothing and writes no second archive', async () => {
  await db.initDb();
  assert.equal(db.oldSystemPurge.status, 'clean');
  assert.equal(Number((await db.one('SELECT COUNT(*) AS c FROM compendium_archive')).c), 1);
});
