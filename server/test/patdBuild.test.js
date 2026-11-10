// The character builder's derivation (client/src/lib/patd/build.js), pinned
// against the real content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { buildTypes, constructChoices, deriveBuild, franticOptions, franticPickAllowed, normalizeBuild, stanceDice, stanceOfBuild } from '../../client/src/lib/patd/build.js';

const idx = patdContent();
const dieStr = (dice) => dice.map((d) => (d.kind === 'fixed' ? `#${d.value}` : `${d.bonus ? 'b' : d.color?.[0] ?? '?'}${d.sides}`)).join(' ');

test('hero and NPC types are one open list', () => {
  const ids = buildTypes(idx).map((t) => t.id);
  assert.deepEqual(ids, ['hero-type.focused', 'hero-type.fused', 'hero-type.frantic', 'character-type.warrior', 'character-type.boss', 'character-type.stooges']);
  const boss = buildTypes(idx).find((t) => t.id === 'character-type.boss');
  assert.equal(boss.stanceCount, 3);
  assert.equal(boss.variant, 'fused');
});

test('a Stance: named from Style and Form alias, dice from the Form, range from the Style (+ Blaster)', () => {
  const d = deriveBuild(
    {
      type: 'hero-type.focused',
      archetypes: [{ id: 'archetype.angel', variant: 'focused' }],
      stances: [{ formId: 'form.blaster', styleId: 'style.halcyon', alias: 'Star' }],
      level: 1,
    },
    idx
  );
  const s = d.stances[0];
  assert.equal(s.name, 'Halcyon Star Stance');
  assert.equal(dieStr(s.dice), 'p8 g8 g8');
  assert.deepEqual(s.range, { minimum: 1, maximum: 3 }, 'Halcyon is 1-2; Blaster adds 1');
  assert.ok(d.constantAbilityIds.includes('ability.archetype-angel.focused-angel'));
  assert.ok(d.constantActionIds.includes('action.archetype-angel.siren-song') && d.constantActionIds.includes('action.system-basic-actions.damage'));
});

test('a Freestyle keeps the Form purple dice and adds its own; levels add a bonus die', () => {
  const thorns = idx.get('form.thorns');
  const chaotic = idx.get('freestyle.chaotic');
  assert.equal(dieStr(stanceDice(thorns, chaotic)), '#5 p6 p6 p4');
  assert.equal(dieStr(stanceDice(thorns, idx.get('style.halcyon'), { sides: 8 })), '#5 p6 g6 g6 b8');
  const d = deriveBuild({ type: 'hero-type.focused', stances: [{ formId: 'form.iron', styleId: 'style.halcyon' }], level: 6 }, idx);
  assert.equal(d.stances[0].dice.at(-1).sides, 8);
  assert.equal(d.level.bonusHpPerBar, 6);
});

test("Control Form's construct choice: +3 maximum range, or minimum 0", () => {
  const choices = constructChoices(idx.get('form.control'), idx);
  assert.equal(choices.length, 2);
  const base = { type: 'hero-type.focused', archetypes: [{ id: 'archetype.angel' }] };
  const a = deriveBuild({ ...base, stances: [{ formId: 'form.control', styleId: 'style.halcyon', constructChoice: 'option-1' }] }, idx);
  const b = deriveBuild({ ...base, stances: [{ formId: 'form.control', styleId: 'style.halcyon', constructChoice: 'option-2' }] }, idx);
  assert.deepEqual(a.stances[0].range, { minimum: 1, maximum: 5 });
  assert.deepEqual(b.stances[0].range, { minimum: 0, maximum: 2 });
});

test('option tokens come with the options that own them; skills come from the Forms', () => {
  const d = deriveBuild(
    {
      type: 'hero-type.fused',
      archetypes: [{ id: 'archetype.demon' }, { id: 'archetype.angel' }],
      stances: [{ formId: 'form.control', styleId: 'style.halcyon' }],
      skills: { custom: 'Grumpy Monk' },
    },
    idx
  );
  assert.deepEqual(d.tokens.sort(), ['chaos', 'control']);
  assert.equal(d.skillIds[0], idx.get('form.control').skillId);
  assert.equal(d.customSkill, 'Grumpy Monk');
});

test('legality only warns, and a clean Focused build has no warnings', () => {
  const clean = deriveBuild(
    {
      type: 'hero-type.focused',
      archetypes: [{ id: 'archetype.angel', variant: 'focused' }],
      stances: [
        { formId: 'form.blaster', styleId: 'style.halcyon' },
        { formId: 'form.iron', styleId: 'style.judgment' },
        { formId: 'form.power', styleId: 'style.shining' },
      ],
      buildId: 'build.tough',
      skills: { custom: 'Stern Guardian' },
    },
    idx
  );
  assert.deepEqual(clean.warnings, []);
  const messy = deriveBuild(
    { type: 'hero-type.focused', archetypes: [], stances: [{ formId: 'form.blaster', styleId: 'style.halcyon' }, { formId: 'form.blaster', styleId: 'freestyle.chaotic' }] },
    idx
  );
  assert.ok(messy.warnings.some((w) => /Archetype/.test(w)));
  assert.ok(messy.warnings.some((w) => /different Form/.test(w)));
  assert.ok(messy.warnings.some((w) => /No Build/.test(w)));
  assert.ok(messy.stances.length === 2, 'never blocked');
});

test('levels, XP and grants', () => {
  const d = deriveBuild({ type: 'hero-type.focused', level: 2, xp: 12 }, idx);
  assert.equal(d.level.xpLevel, 3);
  assert.equal(d.level.canLevelUp, true);
  assert.equal(d.level.extra.superMoves, 1);
  const w = deriveBuild({ type: 'character-type.warrior', level: 3 }, idx);
  assert.equal(w.level.bonusHpPerBar, 3);
  assert.ok(w.warnings.some((x) => /Warrior's Path/.test(x)));
});

test('a saved build is cleaned: unknown ids dropped, numbers clamped', () => {
  const n = normalizeBuild(
    { type: 'nope', archetypes: ['archetype.angel', 'archetype.angel', 'archetype.bogus'], stances: [{ formId: 'form.iron', styleId: 'x' }], level: 99, xp: -5, buildId: 'build.nope' },
    idx
  );
  assert.equal(n.type, 'hero-type.focused');
  assert.deepEqual(n.archetypes, [{ id: 'archetype.angel', variant: 'focused' }]);
  assert.deepEqual(n.stances, [{ formId: 'form.iron', form2Id: null, styleId: null, alias: 'Armor', constructChoice: null }]);
  assert.equal(n.level, 10);
  assert.equal(n.xp, 0);
  assert.equal(n.buildId, null);
});

test('Armor from the build: unconditional Armor passives, always or per Stance', async () => {
  const { armorSourcesOf, hpTableOf } = await import('../../client/src/lib/patd/build.js');
  const d = deriveBuild(
    {
      type: 'character-type.warrior',
      archetypes: [{ id: 'archetype.the-tank' }],
      stances: [{ formId: 'form.iron', styleId: 'style.hidden' }],
    },
    idx
  );
  const key = d.stances[0].key;
  assert.deepEqual(armorSourcesOf(d, idx).sort(), ['always', key].sort(), 'The Tank always; Iron Form in its Stance; Hidden (in Fog only) not counted');
  assert.equal(hpTableOf(d), 'warrior');
});

test("Frantic: the Frantic abilities are picked per turn, not always on; last turn's picks are excluded", () => {
  const d = deriveBuild(
    {
      type: 'hero-type.frantic',
      archetypes: [
        { id: 'archetype.angel', variant: 'frantic' },
        { id: 'archetype.demon', variant: 'frantic' },
        { id: 'archetype.phantom', variant: 'frantic' },
      ],
      forms: ['form.wild', 'form.iron', 'form.song'],
      styles: ['style.halcyon', 'style.heroic', 'style.aura'],
      level: 1,
    },
    idx
  );
  assert.deepEqual(d.franticAbilityIds, ['ability.archetype-angel.frantic-angel', 'ability.archetype-demon.frantic-demon', 'ability.archetype-phantom.frantic-phantom']);
  for (const id of d.franticAbilityIds) assert.ok(!d.constantAbilityIds.includes(id));
  // Any known Form with any known Style is a Stance; an unknown one is not.
  assert.equal(stanceOfBuild(d, 'form.iron+style.aura', idx)?.formId, 'form.iron');
  assert.equal(stanceOfBuild(d, 'form.blaster+style.aura', idx), null);
  const last = { formId: 'form.wild', styleId: 'style.halcyon', abilityId: 'ability.archetype-angel.frantic-angel' };
  const opts = franticOptions(d, last, idx);
  assert.deepEqual(opts.forms.filter((o) => o.used).map((o) => o.id), ['form.wild']);
  assert.ok(!franticPickAllowed(opts, { formId: 'form.wild', styleId: 'style.aura', abilityId: 'ability.archetype-demon.frantic-demon' }));
  assert.ok(!franticPickAllowed(opts, { formId: 'form.iron', styleId: 'style.aura', abilityId: 'ability.archetype-angel.frantic-angel' }));
  assert.ok(franticPickAllowed(opts, { formId: 'form.iron', styleId: 'style.aura', abilityId: 'ability.archetype-demon.frantic-demon' }));
  // With only one Form known, last turn's Form is offered again rather than stalling the turn.
  const one = franticOptions({ ...d, formIds: ['form.wild'] }, last, idx);
  assert.equal(one.forms[0].used, false);
});
