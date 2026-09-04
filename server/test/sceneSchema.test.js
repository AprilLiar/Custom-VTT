// The Scene tab's tables, on a fresh boot.
//
// What's load-bearing here, mirroring relationshipsSchema.test.js's own
// three concerns for its own tables:
//
//  1. **Both discriminators are real constraints.** A Scene Picture and a
//     stage summon each belong to exactly one of a Character or a Temp NPC —
//     never both, never neither.
//  2. **Every new FK here is CASCADE, on purpose — the opposite of
//     relationship_nodes.character_id.** A scene_pictures/scene_summons row
//     has no cross-owner reference to preserve (unlike a relationship node,
//     which can point at a character who isn't its board's owner), so there
//     is nothing to convert: deleting the owner should simply take these
//     rows with it, and the DB should not refuse the delete the way it
//     refuses one with relationship_nodes still pointing at it.
//  3. **scene_summons enforces "at most one seat per owner"** via two
//     separate UNIQUE columns rather than one — SQLite treats NULLs as
//     distinct under UNIQUE, so a character's own UNIQUE(character_id) does
//     not collide with a temp_npc's rows (all NULL on that column) at all.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `scene-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
delete process.env.TURSO_AUTH_TOKEN;

const { initDb, all, one, run } = await import('../db.js');

before(async () => {
  await initDb();
});
after(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* fine */ }
  }
});

let seq = 0;
const makeCharacter = async (name, type = 'npc') => {
  const result = await run(
    'INSERT INTO characters (name, character_type, max_stamina, current_stamina) VALUES (?, ?, ?, ?)',
    [`${name}-${++seq}`, type, 20, 20]
  );
  return Number(result.lastInsertRowid);
};
const makeTempNpc = async (name) => {
  const result = await run('INSERT INTO temp_npcs (name) VALUES (?)', [`${name}-${++seq}`]);
  return Number(result.lastInsertRowid);
};
const makePicture = async (ownerColumn, ownerId) => {
  const result = await run(
    `INSERT INTO scene_pictures (${ownerColumn}, image_data, image_mime_type) VALUES (?, 'x', 'image/png')`,
    [ownerId]
  );
  return Number(result.lastInsertRowid);
};

test('a fresh boot creates every Scene table with the columns each surface reads', async () => {
  const tables = await all(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN " +
      "('temp_npc_folders','temp_npcs','scene_folders','scenes','scene_state','scene_pictures','scene_summons')"
  );
  const byName = new Map(tables.map((t) => [t.name, t.sql]));
  for (const name of [
    'temp_npc_folders', 'temp_npcs', 'scene_folders', 'scenes',
    'scene_state', 'scene_pictures', 'scene_summons',
  ]) {
    assert.ok(byName.has(name), `${name} missing — have ${[...byName.keys()].join(', ')}`);
  }
  for (const column of ['name', 'image_data', 'image_mime_type', 'folder_id']) {
    assert.match(byName.get('temp_npcs'), new RegExp(`\\b${column}\\b`));
  }
  for (const column of ['name', 'image_data', 'image_mime_type', 'folder_id']) {
    assert.match(byName.get('scenes'), new RegExp(`\\b${column}\\b`));
  }
  for (const column of ['character_id', 'temp_npc_id', 'name', 'image_data', 'image_mime_type']) {
    assert.match(byName.get('scene_pictures'), new RegExp(`\\b${column}\\b`));
  }
  for (const column of ['character_id', 'temp_npc_id', 'scene_picture_id', 'side']) {
    assert.match(byName.get('scene_summons'), new RegExp(`\\b${column}\\b`));
  }
});

test('the library is indexed by folder, and pictures by their owner', async () => {
  const indexes = await all(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_temp_npcs%' " +
      "OR (type = 'index' AND name LIKE 'idx_scene%')"
  );
  const names = new Set(indexes.map((i) => i.name));
  for (const expected of [
    'idx_temp_npcs_folder_id',
    'idx_scenes_folder_id',
    'idx_scene_pictures_character_id',
    'idx_scene_pictures_temp_npc_id',
  ]) {
    assert.ok(names.has(expected), `${expected} missing — have ${[...names].join(', ')}`);
  }
});

test('a Scene Picture belongs to exactly one owner — never both, never neither', async () => {
  const character = await makeCharacter('picture-owner', 'pc');
  const tempNpc = await makeTempNpc('picture-npc');

  await assert.rejects(
    run(
      "INSERT INTO scene_pictures (character_id, temp_npc_id, image_data, image_mime_type) VALUES (?, ?, 'x', 'image/png')",
      [character, tempNpc]
    ),
    /CHECK|constraint/i
  );
  await assert.rejects(
    run("INSERT INTO scene_pictures (image_data, image_mime_type) VALUES ('x', 'image/png')"),
    /CHECK|constraint/i
  );

  await makePicture('character_id', character);
  await makePicture('temp_npc_id', tempNpc);
  const rows = await all(
    'SELECT * FROM scene_pictures WHERE character_id = ? OR temp_npc_id = ?',
    [character, tempNpc]
  );
  assert.equal(rows.length, 2);
});

test('a stage summon belongs to exactly one owner, same rule as a Scene Picture', async () => {
  const character = await makeCharacter('summon-owner', 'pc');
  const tempNpc = await makeTempNpc('summon-npc');
  const picture = await makePicture('character_id', character);

  await assert.rejects(
    run(
      "INSERT INTO scene_summons (character_id, temp_npc_id, scene_picture_id, side) VALUES (?, ?, ?, 'left')",
      [character, tempNpc, picture]
    ),
    /CHECK|constraint/i
  );
  await assert.rejects(
    run("INSERT INTO scene_summons (scene_picture_id, side) VALUES (?, 'left')", [picture]),
    /CHECK|constraint/i
  );
});

test('side is constrained to the two the stage actually renders', async () => {
  const character = await makeCharacter('side-owner', 'pc');
  const picture = await makePicture('character_id', character);
  await assert.rejects(
    run(
      "INSERT INTO scene_summons (character_id, scene_picture_id, side) VALUES (?, ?, 'center')",
      [character, picture]
    ),
    /CHECK|constraint/i
  );
  await run(
    "INSERT INTO scene_summons (character_id, scene_picture_id, side) VALUES (?, ?, 'left')",
    [character, picture]
  );
});

test('a character (or Temp NPC) holds at most one seat on stage at a time', async () => {
  const character = await makeCharacter('one-seat', 'pc');
  const pictureA = await makePicture('character_id', character);
  const pictureB = await makePicture('character_id', character);
  await run(
    "INSERT INTO scene_summons (character_id, scene_picture_id, side) VALUES (?, ?, 'left')",
    [character, pictureA]
  );
  // The same character trying to hold a SECOND seat (a different picture) is
  // the shape a bad handler could produce if it inserted instead of updating
  // an existing summon — UNIQUE(character_id) refuses it outright.
  await assert.rejects(
    run(
      "INSERT INTO scene_summons (character_id, scene_picture_id, side) VALUES (?, ?, 'left')",
      [character, pictureB]
    ),
    /UNIQUE|constraint/i
  );

  // A Temp NPC's own UNIQUE(temp_npc_id) is independent — two different Temp
  // NPCs, both NULL on character_id, do not collide with each other, because
  // SQLite treats NULLs as distinct under UNIQUE.
  const npcA = await makeTempNpc('roster-a');
  const npcB = await makeTempNpc('roster-b');
  const pictureNpcA = await makePicture('temp_npc_id', npcA);
  const pictureNpcB = await makePicture('temp_npc_id', npcB);
  await run(
    "INSERT INTO scene_summons (temp_npc_id, scene_picture_id, side) VALUES (?, ?, 'right')",
    [npcA, pictureNpcA]
  );
  await run(
    "INSERT INTO scene_summons (temp_npc_id, scene_picture_id, side) VALUES (?, ?, 'right')",
    [npcB, pictureNpcB]
  );
});

test('scene_state seeds a single row, id fixed at 1', async () => {
  const row = await one('SELECT * FROM scene_state WHERE id = 1');
  assert.ok(row, 'the singleton row was not seeded on boot');
  assert.equal(row.active_scene_id, null);
  await assert.rejects(
    run('INSERT INTO scene_state (id, active_scene_id) VALUES (2, NULL)'),
    /CHECK|constraint/i
  );
});

test('foreign keys are enforced on this connection', async () => {
  // Same measured fact relationshipsSchema.test.js pins for its own tables —
  // checked here too, since every CASCADE claim below depends on it and a
  // schema test that assumes it is not actually testing anything.
  const pragma = await one('PRAGMA foreign_keys');
  assert.equal(Number(pragma.foreign_keys), 1);
});

test('deleting a character CASCADEs their own Scene Pictures and stage seat away — unlike a relationship node, nothing here blocks the delete', async () => {
  const character = await makeCharacter('doomed-owner', 'pc');
  const picture = await makePicture('character_id', character);
  await run(
    "INSERT INTO scene_summons (character_id, scene_picture_id, side) VALUES (?, ?, 'left')",
    [character, picture]
  );

  // The point of the contrast: relationship_nodes.character_id has no
  // ON DELETE action and REFUSES this same shape of delete outright. These
  // new tables deliberately do not repeat that pattern — there is nothing
  // here worth preserving across the owner's own deletion.
  await run('DELETE FROM characters WHERE id = ?', [character]);

  assert.equal(
    (await all('SELECT * FROM scene_pictures WHERE character_id = ?', [character])).length,
    0
  );
  assert.equal(
    (await all('SELECT * FROM scene_summons WHERE character_id = ?', [character])).length,
    0
  );
});

test('deleting a Temp NPC CASCADEs their own Scene Pictures and stage seat away', async () => {
  const tempNpc = await makeTempNpc('doomed-npc');
  const picture = await makePicture('temp_npc_id', tempNpc);
  await run(
    "INSERT INTO scene_summons (temp_npc_id, scene_picture_id, side) VALUES (?, ?, 'right')",
    [tempNpc, picture]
  );
  await run('DELETE FROM temp_npcs WHERE id = ?', [tempNpc]);
  assert.equal(
    (await all('SELECT * FROM scene_pictures WHERE temp_npc_id = ?', [tempNpc])).length,
    0
  );
  assert.equal(
    (await all('SELECT * FROM scene_summons WHERE temp_npc_id = ?', [tempNpc])).length,
    0
  );
});

test('deleting the active Scene resets scene_state to null, not a dangling id', async () => {
  const scene = Number(
    (await run("INSERT INTO scenes (name) VALUES ('Doomed Scene')")).lastInsertRowid
  );
  await run('UPDATE scene_state SET active_scene_id = ? WHERE id = 1', [scene]);
  assert.equal((await one('SELECT active_scene_id FROM scene_state WHERE id = 1')).active_scene_id, scene);
  await run('DELETE FROM scenes WHERE id = ?', [scene]);
  assert.equal((await one('SELECT active_scene_id FROM scene_state WHERE id = 1')).active_scene_id, null);
});

test('a folder promotes its own children one level, same shape as character_folders', async () => {
  const root = Number((await run("INSERT INTO temp_npc_folders (name) VALUES ('Root')")).lastInsertRowid);
  const child = Number(
    (await run('INSERT INTO temp_npc_folders (name, parent_id) VALUES (?, ?)', ['Child', root])).lastInsertRowid
  );
  const npc = await makeTempNpc('foldered');
  await run('UPDATE temp_npcs SET folder_id = ? WHERE id = ?', [child, npc]);

  // ON DELETE SET NULL is metadata only here too — the app-level handler is
  // what actually promotes, exactly as character_folder:delete does. This
  // pins that the column ITSELF behaves as documented if a handler ever
  // relies on the raw SQL default instead.
  await run('DELETE FROM temp_npc_folders WHERE id = ?', [child]);
  assert.equal((await one('SELECT folder_id FROM temp_npcs WHERE id = ?', [npc])).folder_id, null);
});
