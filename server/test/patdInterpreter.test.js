// The turn-trigger interpreter (client/src/lib/patd/interpreter.js), run on
// real rules from the content against a small fake world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { describe, lineOfSight, ruleSupport, runRule, targetable } from '../../client/src/lib/patd/interpreter.js';

const idx = patdContent();
const rulesOf = (abilityId, event) => idx.get(abilityId).rules.filter((r) => r.events.includes(event));

function makeWorld(fighters) {
  const log = [];
  const w = {
    context: { healValue: 2, bleedValue: 4, round: 2 },
    fighters: () => fighters,
    enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
    alliesOf: (f) => fighters.filter((x) => x.side === f.side),
    inRange: () => true,
    heldTokens: (f) => ({ ...f.tokens }),
    gainTokens: async (f, k, n) => (f.tokens[k] = (f.tokens[k] ?? 0) + n),
    discardTokens: async (f, keys, n) => {
      let left = n;
      for (const k of keys) {
        const take = Math.min(left, f.tokens[k] ?? 0);
        f.tokens[k] -= take;
        left -= take;
      }
      return n - left;
    },
    gainShield: async (f, v) => (f.tokens.shield = Math.max(v, (f.tokens.shield ?? 0) + 1)),
    heal: async (f, n) => ((f.hp += n), n),
    payHp: async (f, n) => (f.hp -= n),
    tempArmor: async (f) => (f.tokens.armor = (f.tokens.armor ?? 0) + 1),
    damage: async (f, n) => {
      const before = f.hp;
      f.hp -= n;
      return { dealt: n, bled: before > 4 && f.hp <= 4 };
    },
    challenge: async (t, c) => (t.challengeId = c.id),
    addPoolNumber: async (f, v) => log.push(`pool ${v}`),
  };
  return { w, log };
}
const fighter = (id, side, extra = {}) => ({ id, name: `F${id}`, side, tokens: {}, hp: 10, bleeding: false, ...extra });

async function fire(abilityId, event, self, world, answers = [], extra = {}) {
  const lines = [];
  const asked = [];
  const ctx = {
    world,
    self,
    state: extra.state ?? {},
    usage: {},
    ability: idx.get(abilityId),
    log: (l) => lines.push(l),
    ask: async (req) => {
      asked.push(req);
      return answers.shift();
    },
    emit: extra.emit,
    event: extra.event,
  };
  for (const r of rulesOf(abilityId, event)) {
    assert.ok(ruleSupport(r).ok, `${r.id}: ${ruleSupport(r).reason}`);
    await runRule(r, ctx);
  }
  return { lines, asked };
}

test('Wild Form: gain 2 Power at the start of the turn, no questions', async () => {
  const me = fighter(1, 'a');
  const { w } = makeWorld([me]);
  const { asked } = await fire('ability.form-wild.wild-form', 'own_turn.start', me, w);
  assert.equal(me.tokens.power, 2);
  assert.equal(asked.length, 0);
});

test('Song Form: choose a song, gain 3 of it, each other ally gains 1', async () => {
  const me = fighter(1, 'a');
  const pal = fighter(2, 'a');
  const foe = fighter(3, 'b');
  const { w } = makeWorld([me, pal, foe]);
  const state = {};
  const { asked } = await fire('ability.form-song.song-form', 'own_turn.start', me, w, ['speed'], { state });
  assert.equal(asked[0].kind, 'choose');
  assert.equal(state.song, 'speed');
  assert.equal(me.tokens.speed, 3);
  assert.equal(pal.tokens.speed, 1);
  assert.equal(foe.tokens.speed, undefined);
});

test('Focused Angel: may heal, then Challenge an enemy and deal 1 — and the follow-on "after you Challenge" deals 1 and heals 1', async () => {
  const me = fighter(1, 'a', { hp: 5 });
  const foe = fighter(3, 'b');
  const { w } = makeWorld([me, foe]);
  const follow = [];
  const emit = async (event, f, payload) => {
    follow.push(event);
    if (event === 'self.challenge_given_to_enemy') {
      for (const r of rulesOf('ability.archetype-angel.focused-angel', event)) {
        await runRule(r, { world: w, self: f, state: {}, usage: {}, ability: idx.get('ability.archetype-angel.focused-angel'), log: () => {}, ask: async () => null, event: payload });
      }
    }
  };
  await fire('ability.archetype-angel.focused-angel', 'own_turn.start', me, w, [true, ['3']], { emit });
  assert.equal(foe.challengeId, 1);
  assert.equal(foe.hp, 8, '1 from the start rule + 1 from the follow-on');
  assert.equal(me.hp, 5 + 2 + 1, 'Heal Value 2, then 1');
  assert.ok(follow.includes('self.challenge_given_to_enemy'));
});

test('declining a "you may" does nothing', async () => {
  const me = fighter(1, 'a', { hp: 5 });
  const foe = fighter(3, 'b');
  const { w } = makeWorld([me, foe]);
  await fire('ability.archetype-angel.focused-angel', 'own_turn.start', me, w, [false]);
  assert.equal(me.hp, 5);
  assert.equal(foe.challengeId, undefined);
});

test('Vigilance Form: discard up to 2 Status tokens, then heal only if Bleeding', async () => {
  const me = fighter(1, 'a', { tokens: { burning: 1, weakness: 3, iron: 2 }, bleeding: true, hp: 3 });
  const { w } = makeWorld([me]);
  await fire('ability.form-vigilance.vigilance-form', 'own_turn.start', me, w, ['burning']);
  assert.equal(me.tokens.burning, 0);
  assert.equal(me.tokens.weakness, 2);
  assert.equal(me.tokens.iron, 2, 'Iron is not a Status token');
  assert.equal(me.hp, 5);
});

test('movement (phase D) and placing obstacles (phase E) are automated; unknown obstacles are not', () => {
  const jumping = idx.get('ability.style-jumping.jumping-style').rules.find((r) => r.events.includes('own_turn.start'));
  assert.equal(ruleSupport(jumping).ok, true, 'Teleport 3');
  const volcanic = idx.get('ability.style-volcanic.volcanic-style').rules.find((r) => r.events.includes('own_turn.start'));
  assert.equal(ruleSupport(volcanic).ok, true, 'place a Trap');
  assert.equal(ruleSupport({ events: ['own_turn.start'], effect: { op: 'place_obstacle', obstacle: 'deadly_trap', count: 1, target: { ref: 'self.space' } } }).ok, false);
});

test('obstacles: a Trap on a picked space, a Wall destroyed into Rubble by a 2-damage hit, a Copy placed and hit', async () => {
  const me = fighter(1, 'a', { square: { col: 2, row: 2 }, stance: { range: { minimum: 1, maximum: 2 } } });
  const foe = fighter(2, 'b', { square: { col: 4, row: 2 } });
  const { w } = makeWorld([me, foe]);
  const placed = [];
  const destroyed = [];
  const wall = { id: '3,2:wall', isObstacle: true, kind: 'wall', name: 'Wall', square: { col: 3, row: 2 } };
  const copies = [];
  Object.assign(w, {
    mode: 'combat',
    spaces: () => [{ col: 3, row: 3 }, { col: 1, row: 1 }],
    canPlace: (kind, sq) => !(sq.col === 1 && sq.row === 1 && kind === 'wall'),
    placeObstacle: async (kind, sq, owner) => {
      placed.push([kind, sq.col, sq.row, owner?.id]);
      if (kind === 'copy') copies.push({ id: 'copy:9', isCopy: true, ownerId: owner.id, name: "F1's Copy", side: owner.side, square: sq, tokens: {} });
      return { kind, square: sq };
    },
    obstacles: () => [wall],
    copies: () => copies,
    destroyObstacle: async (o) => destroyed.push(o.id),
  });
  const ctx = { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (q.kind === 'square' ? q.options.at(-1).id : q.kind === 'targets' ? [q.options[0].id] : q.options?.[0]?.id) };
  await runRule({ id: 't1', effect: { op: 'place_obstacle', obstacle: 'trap', count: 1, target: { kind: 'space', range: { mode: 'stance', origin: 'self' }, count: 1 } } }, ctx);
  assert.deepEqual(placed[0], ['trap', 1, 1, 1], 'the picked space');
  await runRule({ id: 't2', effect: { op: 'place_obstacle', obstacle: 'wall', count: 1, target: { kind: 'space', range: { mode: 'stance', origin: 'self' }, count: 1 } } }, ctx);
  assert.deepEqual(placed[1], ['wall', 3, 3, 1], 'only legal spaces are offered');
  await runRule({ id: 't3', effect: { op: 'damage', amount: 2, target: { kind: 'enemy_or_obstacle', range: { mode: 'stance', origin: 'self' }, count: 1 } } }, { ...ctx, ask: async (q) => [q.options.find((o) => o.id === wall.id).id] });
  assert.deepEqual(destroyed, ['3,2:wall'], '2+ damage in one hit destroys a Wall');
  await runRule({ id: 't4', effect: { op: 'place_obstacle', obstacle: 'copy', count: 1, target: { ref: 'self.space' } } }, { ...ctx, self: { ...me, space: { col: 2, row: 3 } } });
  assert.deepEqual(placed[2], ['copy', 2, 3, 1]);
  const pool = [];
  await runRule({ id: 't5', effect: { op: 'select', binding: 'target', selector: { kind: 'own_copy', range: { mode: 'none', origin: 'self' }, count: 1 } } }, { ...ctx, ask: async (q) => (pool.push(...q.options.map((o) => o.id)), [q.options[0].id]) });
  assert.ok(pool.length === 0 || pool.includes('copy:9'), 'your own Copy can be picked');
});

test('range and sight: the diamond (a diagonal counts 2), Walls block a centre line, Fog limits enemies to Range 1', () => {
  const walls = new Set(['2,0']);
  assert.equal(lineOfSight({ col: 0, row: 0 }, { col: 4, row: 0 }, walls), false);
  assert.equal(lineOfSight({ col: 0, row: 1 }, { col: 4, row: 1 }, walls), true);
  assert.equal(lineOfSight({ col: 1, row: 1 }, { col: 2, row: 0 }, new Set(['1,0', '2,1'])), true, 'a diagonal through the corner point only grazes the Walls beside it');
  const fogged = (sq) => sq.col === 5;
  const base = { from: { col: 0, row: 0 }, walls: new Set(), fogged, enemy: true, stanceRange: { minimum: 1, maximum: 6 } };
  assert.equal(targetable({ ...base, to: { col: 3, row: 3 }, range: { mode: 'stance' } }), true, 'diagonal 3 is Range 6');
  assert.equal(targetable({ ...base, to: { col: 4, row: 3 }, range: { mode: 'stance' } }), false, '4 + 3 is Range 7');
  assert.equal(targetable({ ...base, to: { col: 5, row: 0 }, range: { mode: 'stance' } }), false, 'in Fog, 5 away');
  assert.equal(targetable({ ...base, to: { col: 5, row: 0 }, range: { mode: 'stance' }, enemy: false }), true, 'an ally in Fog is fine');
  assert.equal(targetable({ ...base, to: { col: 1, row: 0 }, range: { mode: 'adjacent' } }), true);
  assert.equal(targetable({ ...base, to: { col: 1, row: 1 }, range: { mode: 'adjacent' } }), false, 'a diagonal is not adjacent');
});

test("Greater Warrior: the turn start triggers the Warrior's Path (Path of the Tiger: 2 Power)", async () => {
  const me = fighter(1, 'a');
  const { w } = makeWorld([me]);
  const emit = async (ev, f) => {
    for (const r of rulesOf('ability.warrior-path-tiger.path-of-the-tiger', ev)) await runRule(r, { world: w, self: f, state: {}, usage: {}, log: () => {}, ask: async () => null });
  };
  await fire('ability.feature-greater-warrior.greater-warrior', 'own_turn.start', me, w, [], { emit });
  assert.equal(me.tokens.power, 2);
});

test('Halcyon Style (ruling): never a basic token; skipped without Status tokens; otherwise a choice, which may be declined', async () => {
  const halcyon = 'ability.style-halcyon.halcyon-style';
  const me = fighter(1, 'a', { tokens: { power: 3, iron: 2 } });
  const { w } = makeWorld([me]);
  let r = await fire(halcyon, 'own_turn.start', me, w);
  assert.equal(r.asked.length, 0, 'no Status token: nothing asked');
  assert.deepEqual(me.tokens, { power: 3, iron: 2 });
  me.tokens.weakness = 2;
  me.tokens.burning = 1;
  r = await fire(halcyon, 'own_turn.start', me, w, ['__skip']);
  assert.equal(r.asked.length, 1);
  assert.deepEqual(r.asked[0].options.map((o) => o.id), ['weakness', 'burning', '__skip'], 'only Status tokens, plus "Don\'t discard"');
  assert.equal(me.tokens.weakness, 2, 'declined');
  const emitted = [];
  r = await fire(halcyon, 'own_turn.start', me, w, ['burning'], { emit: async (ev, f, p) => emitted.push([ev, p.amount]) });
  assert.equal(me.tokens.burning, 0);
  assert.deepEqual(emitted, [['self.tokens_discarded_by_action_or_ability', 1]], 'the discard is a follow-on (Halcyon: gain that much Iron)');
  const rule2 = rulesOf(halcyon, 'self.tokens_discarded_by_action_or_ability')[0];
  assert.ok(ruleSupport(rule2).ok);
  await runRule(rule2, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async () => null, event: { amount: 1, isCostPayment: false } });
  assert.equal(me.tokens.iron, 3);
});

test('a rule-level "you may" asks first (Decoy Style), and No does nothing', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const { w } = makeWorld([me, foe]);
  w.context.activeCharacter = foe;
  const rule = rulesOf('ability.style-decoy.decoy-style', 'enemy_turn.start')[0];
  const asked = [];
  const ctx = { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (asked.push(q), false) };
  await runRule(rule, ctx);
  assert.equal(asked[0].kind, 'confirm');
  assert.equal(me.hp, 10);
  assert.equal(foe.challengeId, undefined);
});

test('Trickster: pick a non-Unique token in range, then steal it and/or convert it to Iron', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b', { tokens: { power: 2, chaos: 1, shield: 3 } });
  const { w } = makeWorld([me, foe]);
  const rule = rulesOf('ability.archetype-trickster.focused-trickster', 'any_turn.start')[0];
  assert.ok(ruleSupport(rule).ok, ruleSupport(rule).reason);
  const asked = [];
  const answers = ['2:power', ['option-1', 'option-2']];
  await runRule(rule, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (asked.push(q), answers.shift()) });
  assert.deepEqual(asked[0].options.map((o) => o.id), ['2:power', '__skip'], 'Unique tokens and Shields are not offered');
  assert.equal(asked[1].maximum, 2);
  assert.equal(foe.tokens.power, 1);
  assert.equal(me.tokens.iron, 1, 'stolen, then converted');
  assert.ok(!me.tokens.power);
  // Nobody with a token in range: no question at all.
  const lonely = fighter(3, 'a');
  const { w: w2 } = makeWorld([lonely]);
  const asked2 = [];
  await runRule(rule, { world: w2, self: lonely, state: {}, usage: {}, log: () => {}, ask: async (q) => (asked2.push(q), null) });
  assert.equal(asked2.length, 0);
});

test('Thorns Form: after the Shield absorbs from an enemy Action, 1 damage back — 2 if it broke', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const { w } = makeWorld([me, foe]);
  const rule = rulesOf('ability.form-thorns.thorns-form', 'self.shield_absorbed_from_enemy_action')[0];
  assert.ok(ruleSupport(rule).ok, ruleSupport(rule).reason);
  const ctx = (shieldBroke) => ({ world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async () => null, event: { attacker: foe, amount: 2, shieldBroke } });
  await runRule(rule, ctx(false));
  assert.equal(foe.hp, 9);
  await runRule(rule, ctx(true));
  assert.equal(foe.hp, 7);
});

test('Challenge enforced (decided): a damaging Action must include the Challenger', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const challenger = fighter(3, 'b');
  const { w } = makeWorld([me, foe, challenger]);
  const damage = idx.get('action.system-basic-actions.damage');
  const asked = [];
  // One target: the Challenger is the only choice offered (batch 4: still asked, so it can be skipped).
  await runRule({ id: damage.id, effect: damage.effect }, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (asked.push(q), ['2']), resolution: { gateRating: 1 }, mustTarget: 3 });
  assert.deepEqual(asked.map((q) => q.options.map((o) => o.id)), [['3']]);
  assert.ok(asked[0].skippable);
  assert.equal(challenger.hp, 9);
  assert.equal(foe.hp, 10);
  // Skip (batch 4): the attack is declined — nobody is hit.
  await runRule({ id: damage.id, effect: damage.effect }, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async () => ['__skip'], resolution: { gateRating: 1 }, mustTarget: 3 });
  assert.equal(challenger.hp, 9, 'skipped: no damage');
  // Gate rating drives the damage: 5+ deals 3.
  await runRule({ id: damage.id, effect: damage.effect }, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async () => ['2'], resolution: { gateRating: 6 }, onUnsupported: () => {} });
  assert.equal(foe.hp, 7, 'Damage at a 6: 3 damage (the 5+ Gate); its Push is left to people for now');
});

// ---- full automation phase C: rules changed for a resolution, temporaries, damage steps

test('Iron Form: "you may spend 1 Iron to take 1 less" — offered only with Iron, and it reduces the hit', async () => {
  const me = fighter(1, 'a');
  const { w } = makeWorld([me]);
  const event = { damage: 3, reduction: 0 };
  let r = await fire('ability.form-iron.iron-form', 'self.would_take_damage', me, w, [], { event });
  assert.equal(r.asked.length, 0, 'no Iron: not asked');
  me.tokens.iron = 1;
  r = await fire('ability.form-iron.iron-form', 'self.would_take_damage', me, w, [true], { event });
  assert.equal(r.asked.length, 1);
  assert.equal(me.tokens.iron, 0);
  assert.equal(event.reduction, 1);
});

test('Heroic Style: an ally in range splits the damage (half rounded down kept)', async () => {
  const me = fighter(1, 'a');
  const ally = fighter(2, 'a');
  const { w } = makeWorld([me, ally]);
  const event = { damage: 5, target: ally, split: null };
  await fire('ability.style-heroic.heroic-style', 'ally_in_range.would_take_damage', me, w, [], { event });
  assert.deepEqual([event.split.keep, event.split.give[0].amount, event.split.give[0].to.id], [2, 3, 1]);
});

test('an Action’s modify_rule applies to its own resolution: Shockwave is Unblockable by Armor and Shields', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const seen = [];
  const { w } = makeWorld([me, foe]);
  w.damage = async (f, n, attacker, opts) => (seen.push(opts), { taken: n, steps: [] });
  const action = idx.get('action.form-blaster.shockwave');
  await runRule({ id: action.id, effect: action.effect }, { world: w, self: me, state: {}, usage: {}, ability: action, log: () => {}, ask: async (q) => q.options?.map((o) => o.id) ?? true, resolution: { gateRating: 3 }, onUnsupported: () => {} });
  assert.ok(seen.length >= 1);
  assert.ok(seen[0].mods.some((m) => m.rule === 'unblockable' && m.value.includes('armor') && m.value.includes('shields') && m.targetId === 1), JSON.stringify(seen[0].mods));
  assert.equal(seen[0].source, 'ability', 'outside the runner the source defaults to an Ability');
});

test('temporary: Take Aim installs "next damaging Action is Unblockable" in the runtime; unknown rule keys stay by hand', async () => {
  const me = fighter(1, 'a');
  const temps = [];
  const { w } = makeWorld([me]);
  w.addTemp = async (t) => temps.push(t);
  const action = idx.get('action.style-crosshair.take-aim');
  await runRule({ id: action.id, effect: action.effect }, { world: w, self: me, state: {}, usage: {}, ability: action, log: () => {}, ask: async () => null });
  assert.deepEqual(temps.map((t) => [t.rule, t.duration, t.targetId]), [['next_damage_action.unblockable', 'until_next_damage_dealing_action', 1]]);
  assert.equal(ruleSupport({ events: ['own_turn.start'], effect: { op: 'modify_rule', rule: 'walls.treat_as', value: 'x' } }).ok, false);
  assert.equal(ruleSupport({ events: ['own_turn.start'], effect: { op: 'temporary', duration: 'end_of_current_turn', effect: { op: 'modify_rule', rule: 'unblockable', value: ['armor'] } } }).ok, true);
});

test('"you may Teleport 3": one square pick with a skip, no separate yes/no', async () => {
  const me = fighter(1, 'a', { square: { col: 0, row: 0 } });
  const { w } = makeWorld([me]);
  const calls = [];
  w.teleport = async (f, opts) => (calls.push(opts), null);
  const { asked } = await fire('ability.style-jumping.jumping-style', 'own_turn.start', me, w);
  assert.equal(asked.length, 0, 'no confirm first');
  assert.deepEqual(calls, [{ distance: 3, upTo: false, allowNone: true }]);
});

// **A held Challenge is a Unique token (decided):** Unique / any discards may
// take it, Status and non-Unique ones never; protected Challenges stay.
test('discarding a held Challenge: Unique and any discards take it, Status and non-Unique never; protection holds', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b', { tokens: { weakness: 1 }, challengeId: 1 });
  const { w } = makeWorld([me, foe]);
  const removed = [];
  let protectedNow = false;
  w.challengeRemovable = (holder) => holder.challengeId != null && !protectedNow;
  w.removeChallenge = async (holder, by) => {
    removed.push([holder.id, by.id]);
    holder.challengeId = null;
    return true;
  };
  const discard = (filter, amount = 1) => ({ id: 'd', events: ['own_turn.start'], effect: { op: 'discard_tokens', amount, tokenFilter: filter, target: { ref: 'targets.t' } } });
  const run1 = async (filter, answers = [], amount = 1) => {
    const asked = [];
    const ctx = { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (asked.push(q), q.kind === 'targets' ? [String(foe.id)] : answers.shift()) };
    await runRule({ id: 'x', events: ['own_turn.start'], effect: { op: 'sequence', steps: [{ op: 'select', binding: 't', selector: { kind: 'enemy', range: { mode: 'map', origin: 'self' }, count: 1 } }, discard(filter, amount).effect] } }, ctx);
    return asked;
  };
  await run1('status');
  assert.equal(foe.challengeId, 1, 'a Status discard never takes it');
  await run1('non_unique');
  assert.equal(foe.challengeId, 1, 'nor a non-Unique one');
  protectedNow = true;
  const offeredWhenProtected = (await run1('any', ['weakness'], 1)).find((q) => q.kind === 'choose');
  assert.ok(!offeredWhenProtected || !offeredWhenProtected.options.some((o) => o.id === 'challenge'), 'protected: never offered');
  assert.equal(foe.challengeId, 1);
  protectedNow = false;
  foe.tokens.weakness = 1;
  const asked = await run1('any', ['challenge']);
  assert.deepEqual(asked.find((q) => q.kind === 'choose').options.map((o) => o.id), ['weakness', 'challenge'], 'an any discard offers it');
  assert.equal(foe.challengeId, null);
  assert.deepEqual(removed, [[2, 1]], 'removed through the world, by whoever discards');
  foe.challengeId = 1;
  delete foe.tokens.weakness;
  await run1('unique');
  assert.equal(foe.challengeId, null, 'a Unique discard takes it');
});

test("a Challenge the Shield blocked: not given, no follow-on; Decoy heals the ally nearest the former holder", async () => {
  const me = fighter(1, 'a', { square: { col: 0, row: 0 } });
  const near = fighter(3, 'a', { square: { col: 4, row: 1 } });
  const far = fighter(4, 'a', { square: { col: 0, row: 5 } });
  const foe = fighter(2, 'b', { square: { col: 5, row: 1 } });
  const { w } = makeWorld([me, near, far, foe]);
  w.challenge = async () => ({ given: false, blocked: true });
  const emitted = [];
  const lines = [];
  await runRule({ id: 'c', events: ['own_turn.start'], effect: { op: 'challenge', target: { ref: 'targets.t' }, challenger: { ref: 'self' } } }, {
    world: w, self: me, state: {}, usage: {}, log: (l) => lines.push(l), ask: async () => null, emit: async (ev) => emitted.push(ev),
  }).catch(() => {});
  // Through an Action-like select so the target is bound.
  await runRule({ id: 'c2', events: ['own_turn.start'], effect: { op: 'sequence', steps: [{ op: 'select', binding: 't', selector: { kind: 'enemy', range: { mode: 'map', origin: 'self' }, count: 1 } }, { op: 'challenge', target: { ref: 'targets.t' }, challenger: { ref: 'self' } }] } }, {
    world: w, self: me, state: {}, usage: {}, log: (l) => lines.push(l), ask: async (q) => [q.options[0].id], emit: async (ev) => emitted.push(ev),
  });
  assert.ok(!emitted.includes('self.challenge_given_to_enemy'), 'a blocked Challenge was never given');
  assert.ok(lines.some((l) => /Shield blocks/.test(l)), lines.join(' | '));
  const decoy = rulesOf('ability.style-decoy.decoy-style', 'enemy.removed_own_challenge_by_enemy_action_or_ability')[0];
  assert.ok(ruleSupport(decoy).ok, ruleSupport(decoy).reason);
  near.hp = 5;
  far.hp = 5;
  await runRule(decoy, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => [q.options[0].id], event: { formerHolder: foe } });
  assert.equal(near.hp, 7, 'the ally nearest the former holder heals (Heal Value 2)');
  assert.equal(far.hp, 5);
  for (const id of ['ability.style-armored.armored-style', 'ability.style-judgment.judgment-style', 'ability.style-shining.shining-style', 'ability.style-quickdraw.quickdraw-style', 'ability.style-crying.crying-style', 'ability.style-taunting.taunting-style']) {
    for (const r of rulesOf(id, 'enemy.removed_own_challenge_by_enemy_action_or_ability')) assert.ok(ruleSupport(r).ok, `${r.id}: ${ruleSupport(r).reason}`);
  }
});

test('Brambles: "Range 1-X" with X the destroyed Shield is evaluated — it hits; the choices name their obstacles', async () => {
  const me = fighter(1, 'a', { square: { col: 0, row: 0 } });
  const near = fighter(2, 'b', { square: { col: 1, row: 1 } });
  const far = fighter(3, 'b', { square: { col: 4, row: 0 } });
  const { w } = makeWorld([me, near, far]);
  w.inRange = (from, to, range) => targetable({ from: from.square, to: to.square, range, stanceRange: { minimum: 1, maximum: 1 }, walls: new Set(), fogged: () => false, enemy: true });
  const effect = idx.get('action.form-thorns.brambles').effect;
  const asked = [];
  await runRule({ id: 'b', events: ['own_turn.start'], effect }, { world: w, self: me, state: {}, usage: {}, log: () => {}, payment: { destroyedShieldValue: 2 }, ask: async (q) => (asked.push(q), q.options.map((o) => o.id)) });
  assert.deepEqual(asked[0]?.options.map((o) => o.id), ['2'], 'within Range 1-2: the diagonal neighbour (2), not the one 4 away');
  assert.equal(near.hp, 9);
  assert.equal(far.hp, 10);
  assert.equal(me.tokens.power, 1);
  const mysterious = rulesOf('ability.build-mysterious.mysterious-build', 'own_turn.start')[0];
  assert.deepEqual(mysterious.effect.options.map((o) => describe(o.effect)), ['place Copy', 'place Fog']);
});

test('"a different enemy" (excludeBindings): Left, Right! never hits the same enemy twice; alone, the second hit has no target', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b');
  const other = fighter(3, 'b');
  const { w } = makeWorld([me, foe, other]);
  const effect = idx.get('action.form-one-two.left-right').effect;
  const asked = [];
  await runRule({ id: 'lr', events: ['own_turn.start'], effect }, { world: w, self: me, state: {}, usage: {}, log: () => {}, ask: async (q) => (asked.push(q.options.map((o) => o.id)), [q.options[0].id]) });
  assert.deepEqual(asked, [['2', '3'], ['3']], 'the second pick leaves out the first target');
  assert.equal(foe.hp, 9);
  assert.equal(other.hp, 8);
  const solo = makeWorld([fighter(1, 'a'), fighter(2, 'b')]);
  const lone = solo.w.fighters()[1];
  await runRule({ id: 'lr', events: ['own_turn.start'], effect }, { world: solo.w, self: solo.w.fighters()[0], state: {}, usage: {}, log: () => {}, ask: async (q) => [q.options[0].id] });
  assert.equal(lone.hp, 9, 'only the 1 damage: nobody different for the 2');
  // Every "different / another" target in the content carries the flag.
  const marked = ['action.form-one-two.left-right', 'action.form-vigilance.stand-strong', 'action.style-jumping.leap-out', 'action.style-taunting.is-that-all-you-got', 'action.archetype-winterblossom.frostbite'];
  for (const id of marked) assert.ok(JSON.stringify(idx.get(id)).includes('excludeBindings'), id);
});
