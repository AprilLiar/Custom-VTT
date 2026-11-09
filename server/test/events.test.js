// The Events board (server/events.js): who sees which lanes, who edits
// which notes, and where a moved note lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayEditNote, placeAt, shapeBoard } from '../events.js';

const lanes = [
  { id: 1, name: 'Rumours', visibility: 'all', position: 1 },
  { id: 2, name: 'Secrets', visibility: 'gm', position: 0 },
];
const notes = [
  { id: 10, lane_id: 1, text: 'b', color: 'pink', position: 1, author_role: 'player', author_character_id: 7, author_name: 'Ana' },
  { id: 11, lane_id: 1, text: 'a', color: 'yellow', position: 0, author_role: 'gm', author_character_id: null },
  { id: 12, lane_id: 2, text: 'shh', color: 'blue', position: 0, author_role: 'gm', author_character_id: null },
];

test('a Player never sees GM-only lanes or their notes; the GM sees every lane in order', () => {
  const p = shapeBoard(lanes, notes, { role: 'player', characterId: 7 });
  assert.deepEqual(p.lanes.map((l) => l.name), ['Rumours']);
  assert.ok(!JSON.stringify(p).includes('shh'));
  assert.deepEqual(p.lanes[0].notes.map((n) => [n.id, n.author, n.mine]), [[11, 'GM', false], [10, 'Ana', true]], 'notes in order; only her own is hers');
  const gm = shapeBoard(lanes, notes, { role: 'gm' });
  assert.deepEqual(gm.lanes.map((l) => l.name), ['Secrets', 'Rumours']);
  assert.ok(gm.lanes.every((l) => l.notes.every((n) => n.mine)), 'the GM edits every note');
});

test('only the author or the GM edits a note; a moved note lands where dropped', () => {
  assert.equal(mayEditNote(notes[0], { role: 'player', characterId: 7 }), true);
  assert.equal(mayEditNote(notes[0], { role: 'player', characterId: 8 }), false);
  assert.equal(mayEditNote(notes[1], { role: 'player', characterId: 7 }), false, "the GM's note");
  assert.equal(mayEditNote(notes[1], { role: 'gm' }), true);
  assert.deepEqual(placeAt([1, 2, 3], 3, 0), [3, 1, 2]);
  assert.deepEqual(placeAt([1, 2, 3], 1, 99), [2, 3, 1], 'clamped to the end');
  assert.deepEqual(placeAt([1, 2], 9, 1), [1, 9, 2], 'from another lane');
});
