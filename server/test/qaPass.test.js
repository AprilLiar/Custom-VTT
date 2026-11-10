// The QA pass (everything automated): the new rules' pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { actionMoveDestinations, cellsOf, freeMoveReach, isEmpty, makeBoard, nearestCells } from '../../client/src/lib/patd/engine/board.js';
import { costOf, luckPlan, planPayment } from '../../client/src/lib/patd/tokenCost.js';
import { costBonus } from '../../client/src/lib/patd/diceBoard.js';
import { deriveBuild, deriveStance } from '../../client/src/lib/patd/build.js';
import { runRule } from '../../client/src/lib/patd/interpreter.js';
import { census } from '../../client/src/lib/patd/coverage.js';

const idx = patdContent();
const sq = (col, row) => ({ col, row });
const bounds = { colMin: 0, colMax: 9, rowMin: 0, rowMax: 9 };

test('the census: every Ability rule, Action and Super Move is automated', () => {
  const r = census(idx.content);
  for (const t of [r.abilities.triggered, r.abilities.continuous, r.actions, r.supers]) assert.equal(t.byHand.length, 0, JSON.stringify(t.byHand));
});

// ---- movement rules on the mover's board

test('Walls: Parkour walks through them; Spirit Style treats them as Rubble (it stops there); others cannot enter', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 2, row: 0, kind: 'wall' }] });
  assert.equal(isEmpty(b, sq(2, 0)), false);
  const parkour = { ...b, walls: 'empty' };
  assert.ok(actionMoveDestinations(parkour, sq(1, 0), 2).some((d) => d.square.col === 3 && d.square.row === 0), 'through the Wall');
  const spirit = { ...b, walls: 'rubble' };
  const ends = actionMoveDestinations(spirit, sq(1, 0), 3);
  assert.ok(ends.some((d) => d.square.col === 2 && d.path.length === 1), 'it stops on the Wall, as on Rubble');
  assert.ok(!ends.some((d) => d.square.col === 3 && d.square.row === 0 && d.path.some((p) => p.col === 2 && p.row === 0)));
});

test('Shining Style: enemies cannot enter a space next to it; Weightless: every space is empty', () => {
  const b = makeBoard({ bounds, units: [{ id: 9, square: sq(5, 5) }] });
  const blocked = { ...b, blocked: new Set(['5,4', '4,5', '6,5', '5,6']) };
  assert.ok(!freeMoveReach(blocked, sq(5, 2), 4, 1).has('5,4'));
  const open = { ...b, open: true };
  assert.equal(isEmpty(open, sq(5, 5)), true);
});

test('Vortex Style: from a Pit, every other Pit is one step away', () => {
  const b = makeBoard({ bounds, tiles: [{ col: 0, row: 0, kind: 'pit' }, { col: 8, row: 8, kind: 'pit' }] });
  assert.ok(!freeMoveReach(b, sq(0, 0), 2, 1).has('8,8'));
  assert.ok(freeMoveReach({ ...b, pitsLinked: true }, sq(0, 0), 2, 1).has('8,8'));
});

test('the Giant fills 2×2 squares, needs room for all four, and measures from its nearest one', () => {
  assert.equal(cellsOf(sq(1, 1), 2).length, 4);
  const b = makeBoard({ bounds, units: [{ id: 1, square: sq(1, 1), size: 2 }, { id: 2, square: sq(4, 1) }] });
  assert.equal(b.unitAt.get('2,2'), 1);
  const big = { ...b, size: 2 };
  assert.equal(isEmpty(big, sq(3, 1), [1]), false, 'the other unit is in the block');
  assert.equal(isEmpty(big, sq(9, 9), [1]), false, 'off the board');
  assert.equal(isEmpty(big, sq(5, 5), [1]), true);
  const [a, c] = nearestCells(sq(1, 1), 2, sq(4, 1), 1);
  assert.deepEqual(a, sq(2, 1));
  assert.deepEqual(c, sq(4, 1));
});

// ---- costs

test('Elder Style: token costs down by 1 (never below 2); a number counts one higher against Gates', () => {
  const state = { tokens: { power: 5 }, costReduction: { amount: 1, minimumDice: 1, minimumOther: 2 } };
  assert.deepEqual(costOf({ components: [{ kind: 'token', token: 'power', amount: 3 }] }, state).map((c) => c.amount), [2]);
  assert.deepEqual(costOf({ components: [{ kind: 'token', token: 'power', amount: 2 }] }, state).map((c) => c.amount), [2]);
  const damage = idx.get('action.system-basic-actions.damage');
  assert.equal(costBonus(damage, state), 1);
  assert.equal(costBonus(damage, {}), 0);
});

test('Luck: one token in place of up to 3 Basic tokens, HP or Shield — what is missing, or more on request', () => {
  const comps = [{ kind: 'token', token: 'basic', amount: 5 }];
  assert.equal(luckPlan(comps, { tokens: { power: 1 }, luck: 1 }), null, '1 Basic + 1 Luck (3) is still short of 5');
  assert.deepEqual(luckPlan(comps, { tokens: { power: 2 }, luck: 1 }).use, [1], '2 Basic + 1 Luck pays 5');
  assert.deepEqual(luckPlan(comps, { tokens: { power: 9 }, luck: 2 }, 2).use, [2], 'more Luck when asked for');
  const action = { cost: { options: [{ category: 'token', components: [{ kind: 'token', token: 'iron', amount: 3 }], rating: 3 }] } };
  const paid = planPayment(action, 0, { luck: 1 }, { tokens: { iron: 3 }, luck: 1, hp: 5 });
  assert.equal(paid.tokens.luck, 1);
  assert.equal(paid.tokens.iron ?? 0, 0);
});

// ---- the builder

const archWith = (rule) => idx.content.archetypes.find((a) => (a.abilityIds ?? []).some((id) => JSON.stringify(idx.get(id)?.rules ?? []).includes(rule)));

test('The Machine: a Stance of one Style and two Forms, both Forms’ dice and Abilities, never a green die', () => {
  const machine = archWith('stance.composition');
  const d = deriveBuild({ type: 'character-type.boss', archetypes: [{ id: machine.id }], stances: [{ formId: 'form.power', form2Id: 'form.iron', styleId: 'style.caged' }] }, idx);
  assert.equal(d.machine, true);
  const s = d.stances[0];
  assert.ok(s.dice.every((x) => x.color !== 'green'), JSON.stringify(s.dice));
  assert.ok(s.abilityIds.includes(idx.get('form.iron').abilityIds[0]) && s.abilityIds.includes(idx.get('form.power').abilityIds[0]));
  const plain = deriveStance({ formId: 'form.power', form2Id: 'form.iron', styleId: 'style.caged' }, idx);
  assert.ok(!plain.abilityIds.includes(idx.get('form.iron').abilityIds[0]), 'only the Machine takes a second Form');
});

test('Greater Focus adds the original Archetype’s Fused Ability; Greater Fusion makes a chosen one Focused', () => {
  const arch = idx.content.archetypes.find((a) => a.abilityVariants?.focused && a.abilityVariants?.fused);
  const focus = deriveBuild({ type: 'hero-type.focused', level: 7, archetypes: [{ id: arch.id, variant: 'focused' }] }, idx);
  assert.ok(focus.constantAbilityIds.includes(arch.abilityVariants.fused[0]) && focus.constantAbilityIds.includes(arch.abilityVariants.focused[0]));
  const fusion = deriveBuild({ type: 'hero-type.fused', level: 7, archetypes: [{ id: arch.id, variant: 'fused' }], greaterFusionId: arch.id }, idx);
  assert.ok(fusion.constantAbilityIds.includes(arch.abilityVariants.focused[0]));
  assert.ok(!fusion.constantAbilityIds.includes(arch.abilityVariants.fused[0]));
});

test('Improved Frenzy: a Frantic Ability from an Archetype not yet had', () => {
  const [a, b] = idx.content.archetypes.filter((x) => x.abilityVariants?.frantic);
  const d = deriveBuild({ type: 'hero-type.frantic', level: 3, archetypes: [{ id: a.id, variant: 'frantic' }], bonusFrantic: [b.id] }, idx);
  assert.ok(d.franticAbilityIds.includes(b.abilityVariants.frantic[0]));
  const low = deriveBuild({ type: 'hero-type.frantic', level: 2, archetypes: [{ id: a.id, variant: 'frantic' }], bonusFrantic: [b.id] }, idx);
  assert.ok(!low.franticAbilityIds.includes(b.abilityVariants.frantic[0]), 'not before level 3');
});

test('token mechanics come with their owner: the Underdog’s Luck, Training Style’s tokens, the Blur’s Rapid Strike', () => {
  const underdog = deriveBuild({ type: 'hero-type.focused', archetypes: [{ id: 'archetype.underdog', variant: 'focused' }] }, idx);
  assert.ok(underdog.constantAbilityIds.includes('ability.resource-mechanic-luck.luck-mechanics'));
  const blur = deriveBuild({ type: 'character-type.boss', archetypes: [{ id: 'archetype.the-blur' }] }, idx);
  assert.ok(blur.constantActionIds.includes('action.resource-mechanic-rapid-strike.rapid-strike'));
  const training = deriveStance({ formId: 'form.power', styleId: 'style.training' }, idx);
  assert.ok(training.abilityIds.includes('ability.resource-mechanic-training.training-mechanics'));
});

// ---- the interpreter

function world(fighters) {
  return {
    mode: 'combat',
    context: { healValue: 2, round: 2 },
    fighters: () => fighters,
    enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
    alliesOf: (f) => fighters.filter((x) => x.side === f.side),
    inRange: (from, to, range) => (range?.mode === 'adjacent' ? Math.abs(from.square.col - to.square.col) + Math.abs(from.square.row - to.square.row) === 1 : Math.abs(from.square.col - to.square.col) <= 3),
    heldTokens: (f) => ({ ...f.tokens }),
    gainTokens: async (f, k, n) => (f.tokens[k] = (f.tokens[k] ?? 0) + n),
    discardTokens: async () => 0,
    damage: async (f, n) => ((f.hp -= n), { taken: n, steps: [] }),
    heal: async (f, n) => ((f.hp += n), n),
    spaces: () => [sq(9, 9)],
    canPlace: () => true,
    returnToPlay: async (f, s) => (f.square = s),
    mods: () => [],
  };
}
const fighter = (id, side, col, extra = {}) => ({ id, name: `F${id}`, side, tokens: {}, hp: 8, square: sq(col, 0), ...extra });

test('one extra target within range (Blaster Form): a pick of one may take two, once per Action', async () => {
  const me = fighter(1, 'a', 0);
  const [x, y] = [fighter(2, 'b', 1), fighter(3, 'b', 2)];
  const w = world([me, x, y]);
  const damage = idx.get('action.system-basic-actions.damage');
  const asked = [];
  await runRule({ id: damage.id, effect: damage.effect }, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (asked.push(q), ['2', '3']), resolution: { gateRating: 1 }, extraTargets: 1, onUnsupported: () => {} });
  assert.equal(asked[0].maximum, 2);
  assert.equal(x.hp, 7);
  assert.equal(y.hp, 7);
});

test('Whip Style: a Throw may target within range, not only adjacent', async () => {
  const me = fighter(1, 'a', 0);
  const far = fighter(2, 'b', 3);
  const w = world([me, far]);
  w.mods = () => [{ rule: 'throw.target_range', value: 'stance' }];
  w.forced = async () => far.square;
  const thr = idx.get('action.system-basic-actions.throw');
  const picked = [];
  await runRule({ id: thr.id, effect: thr.effect }, { world: w, self: me, ability: thr, state: {}, usage: {}, log: () => {}, ask: async (q) => (picked.push(q), [q.options[0].id]), resolution: { gateRating: 5 }, onUnsupported: () => {} });
  assert.equal(far.hp, 7, 'the 5+ Gate deals 1 to the enemy 3 away');
});

test('Rescue: an ally out of play is healed and returns to an empty space', async () => {
  const me = fighter(1, 'a', 0);
  const out = fighter(2, 'a', 0, { square: null, hp: 0 });
  const w = world([me, out]);
  const rescue = idx.get('action.system-basic-actions.rescue');
  await runRule({ id: rescue.id, effect: rescue.effect }, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (q.kind === 'choose' ? ['option-2'] : [q.options[0].id]), resolution: { gateRating: 5 }, onUnsupported: (n) => assert.fail(`by hand: ${n.op}`) });
  assert.deepEqual(out.square, sq(9, 9));
  assert.equal(out.hp, 2);
});

test('Sing Along at 4+: the target chooses a second option themselves (joint_choice)', async () => {
  const me = fighter(1, 'a', 0);
  const pal = fighter(2, 'a', 1);
  const w = world([me, pal]);
  const sing = idx.get('action.form-song.sing-along');
  const askedAs = [];
  await runRule(
    { id: sing.id, effect: sing.effect },
    {
      world: w,
      self: me,
      state: { song: 'power' },
      usage: {},
      log: () => {},
      ask: async (q) => [q.options[1]?.id ?? q.options[0].id],
      askAs: (f) => async (q) => (askedAs.push(f.id), [q.options[q.options.length - 1].id]),
      resolution: { gateRating: 4 },
      onUnsupported: (n) => assert.fail(`by hand: ${n.op}`),
    }
  );
  assert.deepEqual(askedAs, [1, 2], 'each chooser answered their own pick: the singer, then the ally');
  assert.equal(pal.hp, 10, 'healed 2 (the singer’s pick)');
  assert.equal(pal.tokens.power, 2, 'and 2 tokens of the song (theirs)');
});
