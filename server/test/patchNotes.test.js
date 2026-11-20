import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PATCH } from '../../client/src/lib/patchNotes.js';

const version = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8')).version;

test('the role screen patch note: a version both package.json files share, and one sentence', () => {
  assert.match(PATCH.version, /^\d+\.\d+\.\d+$/);
  assert.equal(version('../../package.json'), PATCH.version);
  assert.equal(version('../../client/package.json'), PATCH.version);
  const note = PATCH.note.trim();
  assert.ok(note.length > 10 && note.length <= 240, 'a short note');
  assert.equal(note.split(/[.!?](\s|$)/).filter((x) => x && x.trim()).length, 1, 'exactly one sentence');
});
