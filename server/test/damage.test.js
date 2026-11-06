// Damage Resolution "WEPIA" (client/src/lib/patd/engine/damage.js, phase C).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armorStep,
  autoIron,
  baseDamage,
  ironAllowance,
  isImmune,
  powerAllowance,
  resolveDamage,
  shieldStep,
  spendPrefs,
  unblockableSet,
  weaknessStep,
} from '../../client/src/lib/patd/engine/damage.js';

const mod = (rule, value) => ({ rule, value });
const always = (n) => async () => n;
const yes = async () => true;
const action = { kind: 'action' };
const target = (tokens = {}, extra = {}) => ({ tokens, mods: [], ...extra });
const armor = (sources, extra = {}) => ({ sources, temp: false, triggered: 0, firstReduction: 3, perTurn: 1, ...extra });

test('unblockable lists: all, tokens covers Iron, shield spelled either way', () => {
  assert.deepEqual([...unblockableSet(['all'])].sort(), ['abilities', 'armor', 'control_tokens', 'iron_tokens', 'shields', 'tokens']);
  assert.ok(unblockableSet(['tokens']).has('iron_tokens'));
  assert.ok(unblockableSet(['armor'], ['shield']).has('shields'));
  assert.equal(unblockableSet(null, []).size, 0);
});

test('allowances: Power 1 (+ Power Form 2, + Drive Install 1); Iron 2 (+1), capped by an Armor Install attacker', () => {
  assert.equal(powerAllowance([]), 1);
  assert.equal(powerAllowance([mod('enhance_hit.additional_uses', 2), mod('power_tokens.additional_per_hit', 1)]), 4);
  assert.equal(ironAllowance([]), 2);
  assert.equal(ironAllowance([mod('iron_tokens.additional_per_hit', 1)]), 3);
  assert.equal(ironAllowance([mod('iron_tokens.additional_per_hit', 1)], [mod('opponents.iron_token_limit_per_hit', 1)]), 1);
});

test('base damage: Elder Style −1 on Actions only, minimum 0', () => {
  const elder = [mod('action_damage.adjustment', { amount: -1, minimum: 0 })];
  assert.equal(baseDamage(3, elder, action), 2);
  assert.equal(baseDamage(0, elder, action), 0);
  assert.equal(baseDamage(3, elder, { kind: 'ability' }), 3);
});

test('Weakness: −2 (or the reduction), discard 1, minimum 0', () => {
  assert.deepEqual(weaknessStep(3, 2), { amount: 1, spent: 1, reduced: 2 });
  assert.deepEqual(weaknessStep(1, 1), { amount: 0, spent: 1, reduced: 1 });
  assert.deepEqual(weaknessStep(3, 0), { amount: 3, spent: 0, reduced: 0 });
  assert.equal(weaknessStep(3, 1, 1).amount, 2);
});

test('Shield absorbs 1-for-1 and breaks when used up', () => {
  assert.deepEqual(shieldStep(3, 4), { amount: 0, absorbed: 3, shield: 1, broke: false });
  assert.deepEqual(shieldStep(5, 4), { amount: 1, absorbed: 4, shield: 0, broke: true });
});

test('Armor: 3, then 2, then 1; per source per turn; not at 0 damage; temporary after the rest; The Tank 10', () => {
  assert.equal(armorStep(5, armor(1)).blocked, 3);
  assert.equal(armorStep(5, armor(2, { triggered: 1 })).blocked, 2);
  assert.equal(armorStep(5, armor(3, { triggered: 2 })).blocked, 1);
  assert.equal(armorStep(5, armor(1, { triggered: 1 })).triggered, false, 'one source, already used this turn');
  assert.equal(armorStep(0, armor(1)).triggered, false, 'no damage: Armor is kept');
  const t = armorStep(5, armor(1, { triggered: 1, temp: true }));
  assert.ok(t.usedTemp);
  assert.equal(t.blocked, 2);
  assert.equal(armorStep(12, armor(1, { firstReduction: 10 })).blocked, 10);
  assert.equal(armorStep(5, armor(1, { triggered: 1, perTurn: 2 })).blocked, 2, 'Armor Install: twice per turn');
  assert.equal(armorStep(1, armor(1, { keepOnOne: true })).spent, false, 'Armor Install: a 1-damage hit blocked keeps it');
});

test('immunity by source: Winged (fall), Phoenix (burning), Volcanic (traps), Vortex (pits)', () => {
  assert.ok(isImmune([mod('damage.immunity', ['fall'])], { kind: 'fall' }));
  assert.ok(isImmune([mod('damage.immunity', ['burning_tokens'])], { kind: 'burning' }));
  assert.ok(isImmune([mod('damage.immunity', ['traps'])], { kind: 'trap' }));
  assert.ok(isImmune([mod('damage.immunity', ['pits'])], { kind: 'fall', tags: ['pits'] }));
  assert.ok(!isImmune([mod('damage.immunity', ['fall'])], action));
});

test('WEPIA in order: Weakness, Power, Iron, Shield, Armor', async () => {
  const r = await resolveDamage(
    {
      amount: 5,
      source: action,
      attacker: { tokens: { weakness: 1, power: 2 }, mods: [], enemy: true },
      target: target({ iron: 1, shield: 2 }),
      armor: armor(1),
    },
    { power: always(1), iron: always(1), shield: yes }
  );
  // 5 −2 (Weakness) = 3, +1 Power = 4, −1 Iron = 3, Shield absorbs 2 (breaks) = 1, Armor −1 = 0.
  assert.equal(r.amount, 0);
  assert.deepEqual(r.spend, { weakness: 1, power: 1, targetWeakness: 0, iron: 1, shield: 2 });
  assert.ok(r.broke);
  assert.equal(r.armor.blocked, 1);
  assert.equal(r.pushBonus, 1);
  assert.equal(r.pushResist, 1);
});

test('Unblockable: armor and shields ignored (Shockwave); Iron unless allowed', async () => {
  const hit = {
    amount: 4,
    source: action,
    attacker: { tokens: {}, mods: [], enemy: true },
    target: target({ iron: 2, shield: 3 }),
    armor: armor(1),
    unblockable: unblockableSet(['armor', 'shields']),
  };
  const r = await resolveDamage(hit, { iron: always(0), shield: yes });
  assert.equal(r.amount, 4);
  assert.equal(r.absorbed, 0);
  assert.equal(r.armor, null);
  const all = await resolveDamage({ ...hit, unblockable: unblockableSet(['all']) }, { iron: always(2), shield: yes });
  assert.equal(all.amount, 4, 'Unblockable: Iron does nothing either');
  const allowed = await resolveDamage({ ...hit, unblockable: unblockableSet(['all']), allowIron: true }, { iron: always(2), shield: yes });
  assert.equal(allowed.amount, 2, 'Immortal Army: Iron can reduce it');
});

test('Traps, Fall and Burning: no Iron; Shield only for Burning; Armor for all', async () => {
  const t = target({ iron: 2, shield: 2 });
  const trap = await resolveDamage({ amount: 1, source: { kind: 'trap' }, attacker: null, target: t, armor: armor(0) }, { iron: always(2), shield: yes });
  assert.equal(trap.amount, 1);
  const burning = await resolveDamage({ amount: 3, source: { kind: 'burning' }, attacker: null, target: t, armor: armor(0) }, { iron: always(2), shield: yes });
  assert.equal(burning.amount, 1, 'the Shield eats Burning first');
  assert.equal(burning.spend.iron, 0);
  const fall = await resolveDamage({ amount: 2, source: { kind: 'fall' }, attacker: null, target: t, armor: armor(1) }, { iron: always(2), shield: yes });
  assert.equal(fall.amount, 0, 'Armor blocks Fall');
  assert.equal(fall.absorbed, 0);
});

test('Dizzy takes no damage; Pit −1 beyond Range 3; Exploit Weakness spends the target’s Weakness first', async () => {
  const dz = await resolveDamage({ amount: 5, source: action, attacker: null, target: target({}, { dizzy: true }) }, {});
  assert.ok(dz.dizzy);
  assert.equal(dz.amount, 0);
  const pit = await resolveDamage({ amount: 3, source: action, attacker: null, target: target({}, { inPit: true }), distance: 4 }, {});
  assert.equal(pit.amount, 2);
  const near = await resolveDamage({ amount: 3, source: action, attacker: null, target: target({}, { inPit: true }), distance: 3 }, {});
  assert.equal(near.amount, 3);
  const ex = await resolveDamage(
    { amount: 2, source: action, attacker: { tokens: { power: 1 }, mods: [], enemy: true }, target: target({ weakness: 1 }), exploitWeakness: true },
    { power: ({ max }) => max }
  );
  assert.equal(ex.amount, 3, 'one Power allowed per hit');
  assert.deepEqual([ex.spend.targetWeakness, ex.spend.power], [1, 0]);
});

test('Auto Iron saves tokens Armor would make pointless; Heroic split; "1 less from any source"', async () => {
  assert.equal(autoIron({ max: 2, amount: 2, armorBlocks: 3 }), 0);
  assert.equal(autoIron({ max: 2, amount: 4, armorBlocks: 3 }), 1);
  const split = await resolveDamage({ amount: 5, source: action, attacker: null, target: target() }, { split: async (n) => ({ keep: Math.floor(n / 2), give: [{ to: 9, amount: Math.ceil(n / 2) }] }) });
  assert.equal(split.amount, 2);
  assert.equal(split.split.give[0].amount, 3);
  const less = await resolveDamage({ amount: 3, source: { kind: 'trap' }, attacker: null, target: target() }, { wouldTake: always(1) });
  assert.equal(less.amount, 2);
});

test('spend settings: players Ask, NPCs Auto, saved choices kept', () => {
  assert.deepEqual(spendPrefs({}, false), { power: 'ask', iron: 'ask', shield: 'ask' });
  assert.deepEqual(spendPrefs({ iron: 'never', shield: 'bogus' }, true), { power: 'auto', iron: 'never', shield: 'auto' });
});
