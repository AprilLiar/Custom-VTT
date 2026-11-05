// Homebrew content (client/src/lib/patd/homebrew.js): cleaning, the rule
// editor's compilation, merging into the book, and Copy from book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookContent } from '../patdContent.js';
import { indexContent } from '../../client/src/lib/patd/content.js';
import { deriveBuild } from '../../client/src/lib/patd/build.js';
import { ruleSupport, runRule } from '../../client/src/lib/patd/interpreter.js';
import {
  HOMEBREW_TOKEN_KEYS,
  cleanHomebrew,
  compileRule,
  copyFromBook,
  isHomebrewId,
  itemToContent,
  mergeHomebrew,
  newHomebrewId,
  specFromRule,
} from '../../client/src/lib/patd/homebrew.js';

const book = bookContent();
const clean = (raw) => cleanHomebrew(raw, book, HOMEBREW_TOKEN_KEYS);

const form = {
  ...clean({
    kind: 'form',
    name: 'Ember Form',
    aliases: ['Ember', ''],
    actionDice: [{ kind: 'die', sides: 8, color: 'purple' }, { kind: 'die', sides: 7, color: 'pink' }, { kind: 'fixed', value: 40 }],
    skillId: 'skill.basically-magic',
    abilities: [
      {
        name: 'Ember Form',
        rules: [
          { moment: 'own_turn.start', steps: [{ kind: 'gain_tokens', token: 'power', amount: 2, who: 'self' }, { kind: 'gain_shield', amount: 2 }] },
          { moment: 'own_turn.end_abilities', optional: true, steps: [{ kind: 'damage', amount: 1, who: 'enemy' }] },
          { moment: 'nonsense', steps: [{ kind: 'eval', amount: 1 }] },
        ],
      },
    ],
    actions: [{ name: 'Flare', cost: '1+ or 4+', rulesText: 'Deal 2.' }, { name: '' }],
  }),
  id: 'form.hb-ember-ab12',
};
const style = { ...clean({ kind: 'style', name: 'Kindling Style', range: { minimum: 3, maximum: 1 }, archetypeId: 'archetype.hb-pyre-cd34' }), id: 'style.hb-kindling-ef56', published: true };
const arch = {
  ...clean({
    kind: 'archetype',
    name: 'Pyre',
    archetypeKind: 'villain',
    abilities: [
      { name: 'Focused Pyre', variant: 'focused', rules: [{ moment: 'own_turn.start', steps: [{ kind: 'heal', amount: 'heal_value' }] }] },
      { name: 'Pyre Aura', variant: 'nope', rules: [] },
    ],
  }),
  id: 'archetype.hb-pyre-cd34',
  published: true,
};

test('cleaning: bad dice, colours, empty names and unknown steps are fixed or dropped', () => {
  assert.deepEqual(form.actionDice, [
    { kind: 'die', sides: 8, color: 'purple' },
    { kind: 'die', sides: 6, color: 'purple' },
    { kind: 'fixed', value: 12, color: 'purple' },
  ]);
  assert.deepEqual(form.aliases, ['Ember']);
  assert.equal(form.actions.length, 1);
  assert.equal(form.abilities[0].rules[2].moment, 'own_turn.start');
  assert.deepEqual(form.abilities[0].rules[2].steps, []);
  assert.equal(form.abilities[0].rules[1].steps[0].who, 'enemy');
  assert.equal(style.range.maximum, 3, 'maximum never below minimum');
  assert.equal(arch.abilities[1].variant, null);
  assert.equal(clean({ kind: 'spell', name: 'x' }), null);
  assert.equal(clean({ kind: 'form', name: '  ' }), null);
});

test('ids: a fresh id is a homebrew id of its kind', () => {
  const id = newHomebrewId('style', 'Iron Lotus!', () => 0.5);
  assert.match(id, /^style\.hb-iron-lotus-[a-z0-9]{4}$/);
  assert.ok(isHomebrewId(id));
  assert.ok(!isHomebrewId('style.halcyon'));
});

test('the rule editor compiles to rules the interpreter runs', async () => {
  const { abilities } = itemToContent(form);
  const [start, end] = abilities[0].rules;
  assert.ok(ruleSupport(start).ok && ruleSupport(end).ok);
  assert.deepEqual(start.events, ['own_turn.start']);
  assert.equal(end.effect.op, 'optional');
  const me = { id: 1, name: 'Me', side: 'a', tokens: {} };
  const foe = { id: 2, name: 'Foe', side: 'b', tokens: {}, hp: 9 };
  const world = {
    context: { healValue: 2 },
    fighters: () => [me, foe],
    enemiesOf: () => [foe],
    alliesOf: () => [me],
    inRange: () => true,
    gainTokens: async (f, k, n) => (f.tokens[k] = (f.tokens[k] ?? 0) + n),
    gainShield: async (f, v) => (f.tokens.shield = v),
    damage: async (f, n) => ((f.hp -= n), { dealt: n }),
  };
  const ctx = { world, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (q.kind === 'confirm' ? true : [String(foe.id)]) };
  await runRule(start, ctx);
  await runRule(end, ctx);
  assert.deepEqual(me.tokens, { power: 2, shield: 2 });
  assert.equal(foe.hp, 8);
  assert.equal(compileRule({ moment: 'text', steps: [] }, 'x'), null);
});

test('merging: homebrew joins the lists, drafts are unlisted for players but still resolve, builds derive from it', () => {
  const items = [form, style, arch];
  const gm = indexContent(mergeHomebrew(book.content, items));
  const player = indexContent(mergeHomebrew(book.content, items, { listDrafts: false }));
  assert.ok(gm.content.forms.some((f) => f.id === form.id));
  assert.ok(!player.content.forms.some((f) => f.id === form.id), 'a draft is not listed for players');
  assert.ok(player.get(form.id), 'but it still resolves');
  assert.deepEqual(gm.get(arch.id).styleIds, [style.id], 'a homebrew Style joins its Archetype');
  assert.deepEqual(gm.get(arch.id).abilityVariants.focused, ['ability.hb-pyre-cd34.a1']);
  const d = deriveBuild(
    { type: 'hero-type.focused', archetypes: [{ id: arch.id, variant: 'focused' }], stances: [{ formId: form.id, styleId: style.id, alias: 'Ember' }], level: 1 },
    gm
  );
  assert.equal(d.stances[0].name, 'Kindling Ember Stance');
  assert.deepEqual(d.stances[0].range, { minimum: 3, maximum: 3 });
  assert.ok(d.constantAbilityIds.includes('ability.hb-pyre-cd34.a1'));
  assert.ok(d.constantActionIds.includes('ability.hb-pyre-cd34.a1') === false);
  assert.ok(d.stances[0].actionIds.includes('action.hb-ember-ab12.x1'));
});

test('Copy from book: simple rules become editable steps, the rest is kept as is', () => {
  const wild = copyFromBook(book.get('form.wild'), book);
  assert.equal(wild.name, 'Wild Form (copy)');
  assert.equal(wild.actionDice.length, book.get('form.wild').actionDice.length);
  const rules = wild.abilities[0].rules;
  assert.ok(rules.some((r) => r.steps?.[0]?.kind === 'gain_tokens' && r.steps[0].amount === 2), JSON.stringify(rules));
  assert.ok(rules.some((r) => r.raw), 'the conditional "after each Action" rule stays raw');
  const angel = copyFromBook(book.get('archetype.angel'), book);
  assert.deepEqual(angel.abilities.map((a) => a.variant), ['focused', 'fused', 'frantic']);
  // A copy survives cleaning and compiles back to the same raw rule.
  const cleaned = { ...clean(wild), id: 'form.hb-wild-copy-0000' };
  const raw = itemToContent(cleaned).abilities[0].rules.find((r) => r.events.includes('self.action.resolved'));
  assert.deepEqual(raw.effect, book.get('ability.form-wild.wild-form').rules[0].effect);
  assert.deepEqual(specFromRule(book.get('ability.form-wild.wild-form').rules[1]), { moment: 'own_turn.start', optional: false, steps: [{ kind: 'gain_tokens', who: 'self', amount: 2, token: 'power' }] });
});
