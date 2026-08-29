// The Relationships board's tables, on a fresh boot.
//
// Two things are pinned here, and both are load-bearing:
//
//  1. **The discriminator is a real constraint**, not a convention. A node
//     points at either a world character or a board-local person, never both
//     and never neither. `CHECK` holds under either answer to the pragma
//     question below, which is why the design leans on it.
//
//  2. **Foreign keys ARE enforced**, which was measured after an assumption to
//     the contrary turned out to be wrong: `@libsql/client` enables the pragma
//     when it opens the connection, so it reads 1 before `initDb` runs at all.
//     That is pinned here because a real behaviour depends on it —
//     `relationship_nodes.character_id` carries no `ON DELETE` action, so
//     deleting a character with nodes still pointing at it is REFUSED, which is
//     what makes the conversion in DELETE /api/characters/:id mandatory rather
//     than merely kind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `relationships-${process.pid}-${Date.now()}.db`);
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

test('a fresh boot creates both tables with the columns the board reads', async () => {
  const tables = await all(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE 'relationship_%'"
  );
  const byName = new Map(tables.map((t) => [t.name, t.sql]));
  assert.ok(byName.has('relationship_people'), [...byName.keys()].join(', '));
  assert.ok(byName.has('relationship_nodes'), [...byName.keys()].join(', '));
  for (const column of ['owner_character_id', 'name', 'image_data', 'image_mime_type']) {
    assert.match(byName.get('relationship_people'), new RegExp(`\\b${column}\\b`));
  }
  for (const column of ['owner_character_id', 'character_id', 'person_id', 'x', 'y', 'nickname', 'notes']) {
    assert.match(byName.get('relationship_nodes'), new RegExp(`\\b${column}\\b`));
  }
});

test('the board is indexed by owner, and by the character a node points at', async () => {
  const indexes = await all(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_relationship%'"
  );
  const names = new Set(indexes.map((i) => i.name));
  // The first two are "read one whole board"; the third is the lookup that
  // finds every node to convert when the GM deletes a world NPC, and without it
  // that conversion is a full scan of every board in the world.
  for (const expected of [
    'idx_relationship_people_owner_character_id',
    'idx_relationship_nodes_owner_character_id',
    'idx_relationship_nodes_character_id',
  ]) {
    assert.ok(names.has(expected), `${expected} missing — have ${[...names].join(', ')}`);
  }
});

test('a node points at exactly one subject — never both, never neither', async () => {
  const owner = await makeCharacter('owner', 'pc');
  const npc = await makeCharacter('npc');
  const person = Number(
    (await run('INSERT INTO relationship_people (owner_character_id, name) VALUES (?, ?)', [owner, 'Barkeep']))
      .lastInsertRowid
  );

  // Both is a lie about which one the board should render.
  await assert.rejects(
    run(
      'INSERT INTO relationship_nodes (owner_character_id, character_id, person_id) VALUES (?, ?, ?)',
      [owner, npc, person]
    ),
    /CHECK|constraint/i
  );
  // Neither is a node with nobody in it.
  await assert.rejects(
    run('INSERT INTO relationship_nodes (owner_character_id) VALUES (?)', [owner]),
    /CHECK|constraint/i
  );

  // Each on its own is fine.
  await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [owner, npc]);
  await run('INSERT INTO relationship_nodes (owner_character_id, person_id) VALUES (?, ?)', [owner, person]);
  const nodes = await all('SELECT * FROM relationship_nodes WHERE owner_character_id = ?', [owner]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes.filter((n) => n.character_id != null).length, 1);
  assert.equal(nodes.filter((n) => n.person_id != null).length, 1);
});

test('a node lands at the origin with empty text unless told otherwise', async () => {
  const owner = await makeCharacter('defaults-owner', 'pc');
  const npc = await makeCharacter('defaults-npc');
  await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [owner, npc]);
  const node = await one('SELECT * FROM relationship_nodes WHERE owner_character_id = ?', [owner]);
  assert.equal(node.x, 0);
  assert.equal(node.y, 0);
  // Empty string rather than NULL, so every reader can treat these as text
  // without a null check — the client renders `nickname` directly.
  assert.equal(node.nickname, '');
  assert.equal(node.notes, '');
});

test('foreign keys are enforced on this connection', async () => {
  // Measured, because an earlier version of this file asserted the opposite and
  // was wrong. @libsql/client enables the pragma when it opens the connection,
  // so this reads 1 before initDb has run a statement. Everything below depends
  // on it, so it is checked rather than believed.
  const pragma = await one('PRAGMA foreign_keys');
  assert.equal(Number(pragma.foreign_keys), 1);
});

test('deleting the board owner cascades their own board away', async () => {
  const owner = await makeCharacter('doomed', 'pc');
  const npc = await makeCharacter('bystander');
  await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [owner, npc]);
  await run('DELETE FROM relationship_nodes WHERE owner_character_id = ?', [owner]);
  await run('DELETE FROM characters WHERE id = ?', [owner]);
  assert.equal((await all('SELECT * FROM relationship_nodes WHERE owner_character_id = ?', [owner])).length, 0);
});

test('a character with nodes still pointing at them cannot be deleted', async () => {
  // This is the fact that makes the conversion in DELETE /api/characters/:id
  // mandatory rather than merely considerate: `character_id` carries no
  // ON DELETE action, so the database refuses outright. A future contributor
  // who removes the conversion will not get a quietly broken board — they will
  // get a failing delete, which is the better failure.
  const boardOwner = await makeCharacter('watcher', 'pc');
  const npc = await makeCharacter('remembered');
  await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [boardOwner, npc]);
  await assert.rejects(run('DELETE FROM characters WHERE id = ?', [npc]), /constraint|FOREIGN KEY/i);

  // Repoint that node at a board-local person — exactly what the conversion
  // does — and the delete goes through with the node and its notes intact.
  const person = Number(
    (await run(
      'INSERT INTO relationship_people (owner_character_id, name) VALUES (?, ?)',
      [boardOwner, 'Remembered']
    )).lastInsertRowid
  );
  await run(
    'UPDATE relationship_nodes SET person_id = ?, character_id = NULL WHERE character_id = ?',
    [person, npc]
  );
  await run('DELETE FROM characters WHERE id = ?', [npc]);
  const survivor = await one('SELECT * FROM relationship_nodes WHERE person_id = ?', [person]);
  assert.ok(survivor, 'the placement outlived the character it used to point at');
  assert.equal(survivor.character_id, null);
});

// ---------------------------------------------------------------------------
// Relationship edges — the fields the editor writes
// ---------------------------------------------------------------------------

test('an edge starts red, straight, live and unlabelled', async () => {
  const owner = await makeCharacter('edge-owner', 'pc');
  const a = await makeCharacter('a');
  const b = await makeCharacter('b');
  const nodeA = Number((await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [owner, a])).lastInsertRowid);
  const nodeB = Number((await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [owner, b])).lastInsertRowid);
  await run(
    'INSERT INTO relationship_edges (owner_character_id, from_node_id, to_node_id) VALUES (?, ?, ?)',
    [owner, nodeA, nodeB]
  );
  const edge = await one('SELECT * FROM relationship_edges WHERE owner_character_id = ?', [owner]);
  assert.equal(edge.label, '');
  assert.equal(edge.arrow, 'none');
  assert.equal(edge.retired, 0);
  assert.match(edge.color, /^#[0-9a-f]{6}$/i);
  // A brand-new line is attached at both ends, with no stored loose point.
  assert.equal(edge.from_x, null);
  assert.equal(edge.to_x, null);
  // **NULL, not 0.** A line nobody has bent by hand takes whatever the
  // automatic fan gives it, and that is what keeps two lines between the same
  // pair from overlapping. Zero would mean "somebody straightened this
  // deliberately" and would override the fan — every second line between a pair
  // would land on the first.
  assert.equal(edge.bend, null);
  // The other half of the bend, and NULL for the same reason. A row stored
  // before this column existed reads as 0.5 — the middle — which is exactly
  // where the single-number version always put the arc.
  assert.equal(edge.bend_u, null);
});

test('a hand-drawn arc is stored as a signed offset, zero included', async () => {
  const owner = await makeCharacter('bendy', 'pc');
  const d = await makeCharacter('d');
  const node = Number((await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [owner, d])).lastInsertRowid);
  const edgeId = Number(
    (await run('INSERT INTO relationship_edges (owner_character_id, from_node_id) VALUES (?, ?)', [owner, node])).lastInsertRowid
  );
  const readBack = async () => (await one('SELECT bend FROM relationship_edges WHERE id = ?', [edgeId])).bend;

  // REAL, not INTEGER: a drag lands wherever it lands, and rounding the arc to
  // whole units would make the line step as you pull it.
  await run('UPDATE relationship_edges SET bend = ? WHERE id = ?', [-42.75, edgeId]);
  assert.equal(await readBack(), -42.75);
  // Both halves are REAL and independent — `bend_u` is a fraction of the chord,
  // so it needs the decimals just as much.
  await run('UPDATE relationship_edges SET bend_u = ? WHERE id = ?', [0.183333, edgeId]);
  assert.equal((await one('SELECT bend_u FROM relationship_edges WHERE id = ?', [edgeId])).bend_u, 0.183333);
  // Zero is a real, distinct value — "I straightened this myself".
  await run('UPDATE relationship_edges SET bend = ? WHERE id = ?', [0, edgeId]);
  assert.equal(await readBack(), 0);
  // And it goes back to null, which is how "reset curve" hands the line back to
  // the fan rather than pinning it flat.
  await run('UPDATE relationship_edges SET bend = NULL WHERE id = ?', [edgeId]);
  assert.equal(await readBack(), null);
});

test('arrow and side are constrained to the values the renderer understands', async () => {
  const owner = await makeCharacter('constrained', 'pc');
  const c = await makeCharacter('c');
  const node = Number((await run('INSERT INTO relationship_nodes (owner_character_id, character_id) VALUES (?, ?)', [owner, c])).lastInsertRowid);
  // `arrow` picks a <marker> and `side` picks an anchor; a value outside these
  // sets has no drawing at all, so the column refuses it rather than letting
  // the board render nothing and say nothing.
  await assert.rejects(
    run('INSERT INTO relationship_edges (owner_character_id, from_node_id, arrow) VALUES (?, ?, ?)', [owner, node, 'both']),
    /CHECK|constraint/i
  );
  await assert.rejects(
    run('INSERT INTO relationship_edges (owner_character_id, from_node_id, from_side) VALUES (?, ?, ?)', [owner, node, 'middle']),
    /CHECK|constraint/i
  );
  for (const arrow of ['none', 'from', 'to']) {
    await run('INSERT INTO relationship_edges (owner_character_id, from_node_id, arrow) VALUES (?, ?, ?)', [owner, node, arrow]);
  }
  const rows = await all('SELECT arrow FROM relationship_edges WHERE owner_character_id = ?', [owner]);
  assert.equal(rows.length, 3);
});
