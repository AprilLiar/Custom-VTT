// The turn's dice board helpers (client/src/lib/patd/diceBoard.js) and the
// homebrew custom Skill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent, bookContent } from '../patdContent.js';
import { deriveBuild, stanceOfBuild } from '../../client/src/lib/patd/build.js';
import { cleanMarks, gateFor, turnActions } from '../../client/src/lib/patd/diceBoard.js';
import { indexContent } from '../../client/src/lib/patd/content.js';
import { HOMEBREW_TOKEN_KEYS, OTHER_SKILL, cleanHomebrew, mergeHomebrew } from '../../client/src/lib/patd/homebrew.js';

const idx = patdContent();

test('a die reaches the highest Gate at or below its number', () => {
  const damage = idx.get('action.system-basic-actions.damage');
  assert.equal(gateFor(damage, 6), 5);
  assert.equal(gateFor(damage, 1), 1);
  assert.equal(gateFor(damage, 12), 9);
  const guard = idx.get('action.system-basic-actions.guard');
  assert.equal(gateFor(guard, 3), null, 'below its only threshold (4+)');
  assert.equal(gateFor(idx.get('action.system-basic-actions.movement'), 5), 0, 'an X cost: any number buys the base effect');
  assert.equal(gateFor(idx.get('action.system-basic-actions.grapple'), 7), 7, "…and reaches its effect Gates");
  assert.equal(gateFor(idx.get('action.system-basic-actions.grapple'), 5), 4);
});

test("a turn's Actions: Basic, then the rolled Stance's and the always-available ones, then Super Moves", () => {
  const d = deriveBuild(
    {
      type: 'hero-type.fused',
      archetypes: [{ id: 'archetype.angel', variant: 'fused' }, { id: 'archetype.demon', variant: 'fused' }],
      stances: [{ formId: 'form.blaster', styleId: 'style.halcyon' }, { formId: 'form.iron', styleId: 'style.heroic' }],
      superMoveIds: ['super-move.archetype-angel.heavens-piledriver'],
      level: 2,
    },
    idx
  );
  const t = turnActions(d, stanceOfBuild(d, 'form.blaster+style.halcyon', idx), idx);
  assert.equal(t.basic.length, 10);
  assert.deepEqual(t.personal[0].ids, ['action.form-blaster.amplify', 'action.form-blaster.shockwave', 'action.style-halcyon.purify']);
  assert.ok(t.personal[1].ids.includes('action.archetype-angel.siren-song'));
  assert.ok(!t.personal.flatMap((g) => g.ids).some((id) => id.startsWith('action.form-iron')), "the other Stance's Actions are left out");
  assert.deepEqual(t.supers, ['super-move.archetype-angel.heavens-piledriver']);
});

test('marks are cleaned: dice within the roll, ids that look like ids, every laid die is crossed', () => {
  const m = cleanMarks({ used: [0, 9, -1, 'x'], assign: { 2: { actionId: 'action.system-basic-actions.damage', threshold: 5 }, 7: { actionId: 'x' }, 1: { actionId: 'DROP TABLE' } } }, 4);
  assert.deepEqual(m, { used: [0, 2], assign: { 2: { actionId: 'action.system-basic-actions.damage', threshold: 5 } } });
});

test('homebrew: a Form with an "Other" Skill gets its own Skill entry', () => {
  const book = bookContent();
  const item = { ...cleanHomebrew({ kind: 'form', name: 'Ember Form', skillId: OTHER_SKILL, customSkill: { name: 'Fire Breathing', rulesText: 'You can breathe fire.' } }, book, HOMEBREW_TOKEN_KEYS), id: 'form.hb-ember-0000' };
  assert.deepEqual(item.customSkill, { name: 'Fire Breathing', rulesText: 'You can breathe fire.' });
  const merged = indexContent(mergeHomebrew(book.content, [item]));
  const skillId = merged.get(item.id).skillId;
  assert.equal(skillId, 'skill.hb-ember-0000.s1');
  assert.equal(merged.get(skillId).name, 'Fire Breathing');
  assert.ok(merged.content.skills.some((s) => s.id === skillId));
  const d = deriveBuild({ type: 'hero-type.focused', stances: [{ formId: item.id, styleId: 'style.halcyon' }] }, merged);
  assert.deepEqual(d.skillIds, [skillId]);
  // Saved again (skillId null, customSkill kept) it stays custom.
  assert.ok(cleanHomebrew({ ...item, skillId: null }, book, HOMEBREW_TOKEN_KEYS).customSkill);
});
