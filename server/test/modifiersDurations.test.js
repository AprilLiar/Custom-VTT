// Full automation, phase G — modifiers and durations: rule limits counted in
// HP healed and tokens gained, "this turn" state, refs relative to the rule's
// owner, delayed effects with what they captured, Free Movement's cost per
// space, extra Action Dice, and a fighter's range under its modifiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { ruleSupport, runRule } from '../../client/src/lib/patd/interpreter.js';
import { abilitiesOff, effectiveRange, modifiersOn } from '../../client/src/lib/patd/engine/modifiers.js';
import { freeMoveReach, makeBoard, pathCost } from '../../client/src/lib/patd/engine/board.js';
import { deriveStance, extraDice } from '../../client/src/lib/patd/build.js';

const idx = patdContent();
const rulesOf = (abilityId, event) => idx.get(abilityId).rules.filter((r) => r.events.includes(event));
const fighter = (id, side, extra = {}) => ({ id, name: `F${id}`, side, tokens: {}, hp: 10, ...extra });

function makeWorld(fighters, extra = {}) {
  const moves = [];
  const scheduled = [];
  const w = {
    context: { healValue: 2, bleedValue: 4, round: 1, ...(extra.context ?? {}) },
    fighters: () => fighters,
    enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
    alliesOf: (f) => fighters.filter((x) => x.side === f.side),
    inRange: () => true,
    heldTokens: (f) => ({ ...f.tokens }),
    gainTokens: async (f, k, n) => (f.tokens[k] = (f.tokens[k] ?? 0) + n),
    discardTokens: async () => 0,
    gainShield: async (f, v) => (f.tokens.shield = Math.max(v, (f.tokens.shield ?? 0) + 1)),
    // Heals up to 10 HP: the real amount comes back, as the server's does.
    heal: async (f, n) => {
      const before = f.hp;
      f.hp = Math.min(10, f.hp + n);
      return f.hp - before;
    },
    damage: async (f, n) => ((f.hp -= n), { taken: n, steps: [] }),
    move: async (f) => (moves.push(f.id), { col: 0, row: 0 }),
    schedule: (item) => scheduled.push(item),
  };
  return { w, moves, scheduled };
}

// Runs one ability's rules for an event with a shared `usage` (limits carry over).
async function fire(abilityId, event, self, world, { usage = {}, eventPayload = {}, state = {}, answers = [] } = {}) {
  const lines = [];
  for (const r of rulesOf(abilityId, event)) {
    assert.ok(ruleSupport(r).ok, `${r.id}: ${ruleSupport(r).reason}`);
    await runRule(r, {
      world,
      self,
      state,
      usage,
      ability: idx.get(abilityId),
      event: eventPayload,
      log: (l) => lines.push(l),
      ask: async () => answers.shift(),
    });
  }
  return lines;
}

test('a limit in HP healed: Armored Style heals at most 3 HP a turn, counting what it really healed', async () => {
  const me = fighter(1, 'a', { hp: 4 });
  const { w } = makeWorld([me]);
  const usage = {};
  for (let i = 0; i < 5; i++) await fire('ability.style-armored.armored-style', 'self.armor_triggered', me, w, { usage });
  assert.equal(me.hp, 7, '3 HP, then nothing more this turn');
  // At full HP a heal heals nothing — and counts nothing against the limit.
  const full = fighter(2, 'a', { hp: 10 });
  const u2 = {};
  await fire('ability.style-armored.armored-style', 'self.armor_triggered', full, w, { usage: u2 });
  full.hp = 5;
  for (let i = 0; i < 4; i++) await fire('ability.style-armored.armored-style', 'self.armor_triggered', full, w, { usage: u2 });
  assert.equal(full.hp, 8);
});

test('a limit in tokens gained: Vampire Style gains at most 4 Power a turn for Weakness given', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const { w } = makeWorld([me, foe]);
  const usage = {};
  for (let i = 0; i < 6; i++) await fire('ability.style-vampire.vampire-style', 'self.weakness_given_to_enemy', me, w, { usage, eventPayload: { target: foe, amount: 1 } });
  assert.equal(me.tokens.power, 4);
});

test('"this turn" state: Brawling Style gains Shield 2 only at the end of a turn it took damage', async () => {
  const me = fighter(1, 'a', { tookDamageThisTurn: false });
  const { w } = makeWorld([me]);
  await fire('ability.style-brawling.brawling-style', 'any_turn.end_abilities', me, w);
  assert.equal(me.tokens.shield, undefined);
  me.tookDamageThisTurn = true;
  await fire('ability.style-brawling.brawling-style', 'any_turn.end_abilities', me, w);
  assert.equal(me.tokens.shield, 2);
});

test('"this turn" state: Collateral Style gains 1 Power per obstacle destroyed this turn', async () => {
  const me = fighter(1, 'a', { obstaclesDestroyedThisTurn: 3 });
  const { w } = makeWorld([me]);
  await fire('ability.style-collateral.collateral-style', 'own_turn.end_abilities', me, w);
  assert.equal(me.tokens.power, 3);
});

test('holds your Challenge: Knockdown deals 2 to a damager holding it, 1 to one who does not', async () => {
  const me = fighter(1, 'a');
  const holder = fighter(2, 'b', { challengeId: 1 });
  const other = fighter(3, 'b', { challengeId: 9 });
  const { w } = makeWorld([me, holder, other]);
  await fire('ability.style-knockdown.knockdown-style', 'self.took_damage_from_action', me, w, { eventPayload: { enemyDamageDealers: [holder, other] } });
  assert.equal(holder.hp, 8);
  assert.equal(other.hp, 9);
});

test('holds your Challenge: Taunting Style may Move 1 only after damage from the enemy holding it', async () => {
  const me = fighter(1, 'a');
  const holder = fighter(2, 'b', { challengeId: 1 });
  const other = fighter(3, 'b');
  const { w, moves } = makeWorld([me, holder, other]);
  const r2 = rulesOf('ability.style-taunting.taunting-style', 'self.damage_taken')[1];
  const ctx = (attacker) => ({ world: w, self: me, state: {}, usage: {}, ability: idx.get('ability.style-taunting.taunting-style'), event: { attacker }, log: () => {}, ask: async () => true });
  await runRule(r2, ctx(other));
  assert.deepEqual(moves, []);
  await runRule(r2, ctx(holder));
  assert.deepEqual(moves, [1]);
});

test('your own turn: Mastermind moves after an ally’s Action only on its own turn', async () => {
  const me = fighter(1, 'a');
  const pal = fighter(2, 'a');
  const onMine = makeWorld([me, pal], { context: { activeCharacter: me } });
  await fire('ability.style-mastermind.mastermind-style', 'ally.action.resolved', me, onMine.w, { answers: [true] });
  assert.deepEqual(onMine.moves, [1]);
  const onTheirs = makeWorld([me, pal], { context: { activeCharacter: pal } });
  await fire('ability.style-mastermind.mastermind-style', 'ally.action.resolved', me, onTheirs.w, { answers: [true] });
  assert.deepEqual(onTheirs.moves, []);
});

test('is_enemy and the hit’s damage: Crosshair only on 3+ damage to an enemy', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const pal = fighter(3, 'a');
  const { w } = makeWorld([me, foe, pal]);
  await fire('ability.style-crosshair.crosshair-style', 'self.damage_dealt', me, w, { eventPayload: { target: foe, amount: 2, damage: 2 } });
  await fire('ability.style-crosshair.crosshair-style', 'self.damage_dealt', me, w, { eventPayload: { target: pal, amount: 3, damage: 3 } });
  assert.equal(me.tokens.power, undefined);
  await fire('ability.style-crosshair.crosshair-style', 'self.damage_dealt', me, w, { eventPayload: { target: foe, amount: 3, damage: 3 } });
  assert.equal(me.tokens.power, 1);
  assert.equal(foe.tokens.weakness, 1);
});

test('not_in: Misfortunes Style answers damage from a Trap, not from an Action', async () => {
  const me = fighter(1, 'a', { hp: 5 });
  const { w } = makeWorld([me]);
  await fire('ability.style-misfortunes.misfortunes-style', 'self.damage_taken', me, w, { eventPayload: { sourceType: 'action', amount: 1 }, answers: ['option-2'] });
  assert.equal(me.hp, 5);
  await fire('ability.style-misfortunes.misfortunes-style', 'self.damage_taken', me, w, { eventPayload: { sourceType: 'trap', amount: 1 }, answers: ['option-2'] });
  assert.equal(me.hp, 7, 'heals 2');
});

test('what an Action did: Fullmetal’s Incendiary Ammo burns each enemy it damaged', async () => {
  const me = fighter(1, 'a');
  const a = fighter(2, 'b');
  const b = fighter(3, 'b');
  const { w } = makeWorld([me, a, b]);
  await fire('ability.style-fullmetal.fullmetal-style', 'self.damage_dealing_action.resolved', me, w, { state: { ammo: 'incendiary' }, eventPayload: { enemiesDamaged: [a, b] } });
  assert.equal(a.tokens.burning, 1);
  assert.equal(b.tokens.burning, 1);
  assert.equal(a.tokens.weakness, undefined, 'not the Toxin');
});

test('schedule: a delayed effect keeps its targets by id and runs with them later', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const { w, scheduled } = makeWorld([me, foe]);
  const rule = {
    id: 'test.later',
    events: ['own_turn.start'],
    effect: {
      op: 'sequence',
      steps: [
        { op: 'select', binding: 't', selector: { kind: 'enemy', range: { mode: 'stance', origin: 'self' }, count: 1 } },
        { op: 'schedule', at: 'current_turn.end', effect: { op: 'damage', amount: 2, target: { ref: 'targets.t' } } },
      ],
    },
  };
  assert.ok(ruleSupport(rule).ok);
  await runRule(rule, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => q.options?.[0]?.id });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].at, 'current_turn.end');
  assert.deepEqual(scheduled[0].captured.targets.t, { ref: 2 }, 'a fighter is kept by id');
  assert.equal(foe.hp, 10, 'nothing yet');
  // Later (server/triggers.js runScheduled): the captured ids back as fighters.
  const captured = { ...scheduled[0].captured, targets: { t: foe } };
  await runRule({ id: 'test.later:scheduled', effect: scheduled[0].effect }, { world: w, self: me, state: {}, usage: {}, captured, log: () => {}, ask: async () => null });
  assert.equal(foe.hp, 8);
  // "At the start of your next turn" is supported too; anything else stays by hand.
  assert.ok(!ruleSupport({ id: 'x', events: ['own_turn.start'], effect: { op: 'schedule', at: 'no.such.moment', effect: { op: 'sequence', steps: [] } } }).ok);
});

test('Free Movement cost per space (Weightless Style): diagonals and Pits cost 1 too', () => {
  const b = makeBoard({ bounds: { colMin: 0, colMax: 9, rowMin: 0, rowMax: 9 }, tiles: [{ col: 5, row: 5, kind: 'pit' }] });
  const normal = freeMoveReach(b, { col: 5, row: 5 }, 3);
  const light = freeMoveReach(b, { col: 5, row: 5 }, 3, null, { costPerSpace: 1 });
  assert.equal(normal.get('6,6').cost, 3, 'diagonal out of a Pit: 2 + 1');
  assert.equal(light.get('6,6').cost, 1);
  assert.equal(light.get('8,8').cost, 3);
  assert.equal(pathCost(b, { col: 5, row: 5 }, [{ col: 6, row: 6 }, { col: 7, row: 7 }], { costPerSpace: 1 }), 2);
});

test('extra Action Dice: Quickdraw adds a d6 before the level’s bonus die; others add none', () => {
  const quick = deriveStance({ formId: 'form.power', styleId: 'style.quickdraw' }, idx, { sides: 4 });
  const plain = deriveStance({ formId: 'form.power', styleId: 'style.volcanic' }, idx, { sides: 4 });
  assert.equal(quick.dice.length, plain.dice.length + 1);
  assert.deepEqual(quick.dice.at(-2), { kind: 'die', sides: 6, extra: true });
  assert.ok(quick.dice.at(-1).bonus);
  assert.deepEqual(extraDice(idx.get('style.lucky').abilityIds, idx), [{ kind: 'die', sides: 4, extra: true }]);
});

test('a fighter’s range under its modifiers: set, minimum, maximum (infinite) and bonuses', () => {
  const base = { minimum: 1, maximum: 3 };
  assert.deepEqual(effectiveRange(base, []), { minimum: 1, maximum: 3 });
  assert.deepEqual(effectiveRange(base, [{ rule: 'range.maximum_bonus', value: 1 }, { rule: 'next_action.maximum_range_bonus', value: 2 }]), { minimum: 1, maximum: 6 });
  assert.deepEqual(effectiveRange(base, [{ rule: 'range.set', value: { minimum: 2, maximum: 4 } }]), { minimum: 2, maximum: 4 });
  assert.deepEqual(effectiveRange(base, [{ rule: 'range.minimum_set', value: 0 }]), { minimum: 0, maximum: 3 });
  assert.equal(effectiveRange(base, [{ rule: 'range.maximum_set', value: 'infinite' }]).maximum, Infinity);
  assert.deepEqual(effectiveRange(base, [], 2), { minimum: 1, maximum: 5 });
});

test('"their Abilities are disabled" (Synchro Breaker): a temporary abilities.disabled turns off their lasting rules too', () => {
  const caged = { id: 1, side: 'a', abilityIds: ['ability.style-caged.caged-style'] };
  const foe = { id: 2, side: 'b', abilityIds: [] };
  const world = { fighters: () => [caged, foe], inRange: () => true };
  const on = modifiersOn(foe, world, idx, []);
  assert.ok(on.some((m) => m.rule === 'speed_tokens.cannot_gain_or_spend'), 'Caged works on the adjacent enemy');
  const temps = [{ rule: 'abilities.disabled', value: true, targetId: 1 }];
  assert.ok(abilitiesOff(1, temps));
  assert.ok(!abilitiesOff(2, temps));
  assert.ok(!modifiersOn(foe, world, idx, temps).some((m) => m.rule === 'speed_tokens.cannot_gain_or_spend'), 'not while disabled');
});
