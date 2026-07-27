import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFolderTree, flattenFolderTree, folderPath } from '../../client/src/lib/folders.js';

const FOLDERS = [
  { id: 1, name: 'Fighters', parent_id: null },
  { id: 2, name: 'Bosses', parent_id: 1 },
  { id: 3, name: 'Final', parent_id: 2 },
  { id: 4, name: 'Allies', parent_id: null },
  { id: 5, name: 'Minions', parent_id: 1 },
];

test('buildFolderTree: nests children under parents, alphabetically sorted at every level', () => {
  const tree = buildFolderTree(FOLDERS);
  assert.deepEqual(
    tree.map((f) => f.name),
    ['Allies', 'Fighters']
  );
  const fighters = tree.find((f) => f.name === 'Fighters');
  assert.deepEqual(
    fighters.children.map((f) => f.name),
    ['Bosses', 'Minions']
  );
  const bosses = fighters.children.find((f) => f.name === 'Bosses');
  assert.deepEqual(bosses.children.map((f) => f.name), ['Final']);
  const allies = tree.find((f) => f.name === 'Allies');
  assert.deepEqual(allies.children, []);
});

test('buildFolderTree: empty input -> empty tree', () => {
  assert.deepEqual(buildFolderTree([]), []);
});

test('flattenFolderTree: depth-first order with correct depth and full path', () => {
  const rows = flattenFolderTree(FOLDERS);
  assert.deepEqual(
    rows.map((r) => [r.folder.name, r.depth, r.path]),
    [
      ['Allies', 0, 'Allies'],
      ['Fighters', 0, 'Fighters'],
      ['Bosses', 1, 'Fighters / Bosses'],
      ['Final', 2, 'Fighters / Bosses / Final'],
      ['Minions', 1, 'Fighters / Minions'],
    ]
  );
});

test('folderPath: walks parent_id chain to build "A / B / C"', () => {
  assert.equal(folderPath(3, FOLDERS), 'Fighters / Bosses / Final');
  assert.equal(folderPath(1, FOLDERS), 'Fighters');
  assert.equal(folderPath(4, FOLDERS), 'Allies');
});

test('folderPath: root (null) and unknown ids return null', () => {
  assert.equal(folderPath(null, FOLDERS), null);
  assert.equal(folderPath(999, FOLDERS), null);
});
