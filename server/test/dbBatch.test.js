// The batched read/write seam (Phase 2 of the round-trip work).
//
// The whole point of readMany is that a caller can swap a Promise.all of
// `all()` calls for one batched round trip *without changing what it gets
// back*. That equivalence is what these pin — plus the two edge cases every
// call site will hit as the conversion spreads (an empty group, a group of
// one), because those are exactly where a hand-rolled batch would break.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbPath = path.join(os.tmpdir(), `batch-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
const { all, run, readMany, writeMany } = await import('../db.js');

await run('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
await run("INSERT INTO t (name, n) VALUES ('a', 1), ('b', 2), ('c', 3)");

test('readMany returns exactly what the same reads return one at a time', async () => {
  const statements = [
    ['SELECT * FROM t ORDER BY id'],
    ['SELECT * FROM t WHERE n > ?', [1]],
    ['SELECT COUNT(*) AS c FROM t'],
  ];
  const batched = await readMany(statements);
  const separate = await Promise.all(statements.map(([sql, args = []]) => all(sql, args)));
  assert.deepEqual(batched, separate);
});

test('readMany keeps the order it was given, so destructuring stays honest', async () => {
  const [second, first] = await readMany([
    ['SELECT name FROM t WHERE n = ?', [2]],
    ['SELECT name FROM t WHERE n = ?', [1]],
  ]);
  assert.deepEqual(second, [{ name: 'b' }]);
  assert.deepEqual(first, [{ name: 'a' }]);
});

test('readMany: an empty group is an empty array, not an error', async () => {
  assert.deepEqual(await readMany([]), []);
  // Callers build these lists conditionally, so falsy entries are dropped
  // rather than being sent as a malformed statement.
  assert.deepEqual(await readMany([null, false, undefined]), []);
});

test('readMany: a single statement still comes back wrapped', async () => {
  const result = await readMany([['SELECT n FROM t WHERE name = ?', ['c']]]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], [{ n: 3 }]);
});

test('writeMany applies every statement, in order', async () => {
  await writeMany([
    ["INSERT INTO t (name, n) VALUES ('d', 4)"],
    ['UPDATE t SET n = ? WHERE name = ?', [40, 'd']],
    ["DELETE FROM t WHERE name = 'a'"],
  ]);
  const rows = await all('SELECT name, n FROM t ORDER BY id');
  assert.deepEqual(rows, [
    { name: 'b', n: 2 },
    { name: 'c', n: 3 },
    { name: 'd', n: 40 },
  ]);
});

test('writeMany: empty and single groups behave like readMany', async () => {
  assert.deepEqual(await writeMany([]), []);
  const result = await writeMany([["INSERT INTO t (name, n) VALUES ('e', 5)"]]);
  assert.equal(result.length, 1);
  assert.deepEqual(await all("SELECT n FROM t WHERE name = 'e'"), [{ n: 5 }]);
});

test.after(() => fs.rmSync(dbPath, { force: true }));
