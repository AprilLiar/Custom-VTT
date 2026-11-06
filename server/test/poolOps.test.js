// Full automation, phase H — the Action Pool changed by rules (rerolls,
// increase, set, replace, duplicate, combine, split, Judgment's lowest die),
// Actions performed by rules, teleporting to a picked space, ranges measured
// from a bound target, and how many obstacles a placement makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { ruleSupport, runRule } from '../../client/src/lib/patd/interpreter.js';
import { addPoolValue, livePool, poolOf, removePoolNumber, setPoolValue } from '../../client/src/lib/patd/diceBoard.js';

const idx = patdContent();
const rulesOf = (abilityId, event) => idx.get(abilityId).rules.filter((r) => r.events.includes(event));
const fighter = (id, side, extra = {}) => ({ id, name: `F${id}`, side, tokens: {}, hp: 10, ...extra });
const board = (results, extra = []) => ({ results: results.map(([die, result, more = {}]) => ({ die, result, ...more })), extra: extra.map((value) => ({ value, source: 'ability' })), placements: [] });

// A fake world with each fighter's board (`boards`) and the pool calls.
function makeWorld(fighters, boards = {}, extra = {}) {
  const performed = [];
  const teleports = [];
  const placed = [];
  const w = {
    context: { healValue: 2, bleedValue: 4, round: 1, ...(extra.context ?? {}) },
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
    heal: async (f, n) => ((f.hp += n), n),
    damage: async (f, n) => ((f.hp -= n), { taken: n, steps: [] }),
    pool: (f) => livePool(boards[f.id]),
    changePool: async (f, change) => (boards[f.id] ? (change(boards[f.id]), boards[f.id]) : null),
    addPoolNumber: async (f, v) => boards[f.id] && addPoolValue(boards[f.id], v),
    actionsFor: (f, { gunslinger = false } = {}) => (f.actions ?? []).map((id) => idx.get(id)).filter((a) => a && (!gunslinger || (a.tags ?? []).includes('gunslinger'))),
    performAction: async (actor, actionId, { rating }) => (performed.push({ actor: actor.id, actionId, rating }), { ok: true, lines: ['done'], manual: [] }),
    // Every square of a 10×10 board, empty unless someone stands there.
    spaces: (from, range, { empty = false } = {}) => {
      const out = [];
      for (let col = 0; col < 10; col++) for (let row = 0; row < 10; row++) if (!empty || !fighters.some((f) => f.square?.col === col && f.square?.row === row)) out.push({ col, row });
      return out;
    },
    canPlace: () => true,
    placeObstacle: async (kind, sq) => (placed.push({ kind, ...sq }), { kind, square: sq }),
    teleportTo: async (f, sq) => (teleports.push({ id: f.id, ...sq }), (f.square = sq)),
  };
  return { w, performed, teleports, placed };
}

const ctxFor = (w, self, { answers = [], abilityId = null, rolls = [], usage = {}, event = {} } = {}) => {
  const asked = [];
  return {
    asked,
    ctx: {
      world: w,
      self,
      state: {},
      usage,
      ability: abilityId ? idx.get(abilityId) : null,
      event,
      log: () => {},
      ask: async (q) => (asked.push(q), answers.shift()),
      // `rolls`: the next Math.random() values.
      random: () => (rolls.length ? rolls.shift() : 0.5),
    },
  };
};

test('the pool helpers: changed values, taken-out numbers keep their index, spent dice leave the live pool', () => {
  const d = board([[10, 3], [10, 7], [4, 2, { bonus: true }]], [5]);
  assert.deepEqual(poolOf(d).map((p) => p.index), [0, 1, 2, 3]);
  setPoolValue(d, 0, 9);
  removePoolNumber(d, 1);
  const i = addPoolValue(d, 6);
  assert.equal(i, 4);
  assert.deepEqual(poolOf(d).map((p) => [p.index, p.value]), [[0, 9], [2, 2], [3, 5], [4, 6]]);
  d.placements = [{ kind: 'die', die: 0, committed: true }, { kind: 'die', die: 2, committed: false }];
  assert.deepEqual(livePool(d).map((p) => p.index), [2, 3, 4], 'a committed die is spent; a placed one is not yet');
});

test('Wardancer: +3, +2 and +1 to three different numbers, to a maximum of 9', async () => {
  const me = fighter(1, 'a');
  const boards = { 1: board([[10, 8], [10, 4], [10, 1]]) };
  const { w } = makeWorld([me], boards);
  const r = rulesOf('ability.archetype-wardancer.focused-wardancer', 'own_action_phase.start')[0];
  assert.ok(ruleSupport(r).ok, ruleSupport(r).reason);
  const { ctx, asked } = ctxFor(w, me, { answers: ['0', '1', '2'], abilityId: 'ability.archetype-wardancer.focused-wardancer' });
  await runRule(r, ctx);
  assert.deepEqual(poolOf(boards[1]).map((p) => p.value), [9, 6, 2], '8+3 capped at 9, 4+2, 1+1');
  assert.ok(!asked[1].options.some((o) => o.id === '0'), 'a number already raised is not offered again');
});

test('Improved Focus: re-roll up to three dice and keep the new results; a skip is offered', async () => {
  const me = fighter(1, 'a');
  const boards = { 1: board([[10, 1], [10, 2], [6, 3]], [4]) };
  const { w } = makeWorld([me], boards);
  const r = rulesOf('ability.feature-improved-focus.improved-focus', 'self.action_dice.rolled')[0];
  assert.ok(ruleSupport(r).ok, ruleSupport(r).reason);
  const { ctx, asked } = ctxFor(w, me, { answers: [['0', '2']], rolls: [0.95, 0.7], abilityId: 'ability.feature-improved-focus.improved-focus' });
  await runRule(r, ctx);
  assert.equal(asked.length, 1, 'one pick, no yes/no first');
  assert.equal(asked[0].minimum, 0);
  assert.equal(asked[0].maximum, 3);
  assert.ok(!asked[0].options.some((o) => o.id === '3'), 'an added number is not a die');
  assert.deepEqual(poolOf(boards[1]).map((p) => p.value), [10, 2, 5, 4]);
});

test('Flashy Style: combine two numbers into their sum, then split one in half', async () => {
  const me = fighter(1, 'a');
  const boards = { 1: board([[10, 3], [10, 4], [10, 7]]) };
  const { w } = makeWorld([me], boards);
  const r = rulesOf('ability.style-flashy.flashy-style', 'self.action_dice.rolled')[0];
  assert.ok(ruleSupport(r).ok, ruleSupport(r).reason);
  const { ctx } = ctxFor(w, me, { answers: ['0', '1', '2'], abilityId: 'ability.style-flashy.flashy-style' });
  await runRule(r, ctx);
  assert.deepEqual(poolOf(boards[1]).map((p) => p.value).sort((a, b) => a - b), [3, 4, 7], '3+4 → 7; 7 → 4 and 3');
  // Skipping both: nothing changes.
  const b2 = { 1: board([[10, 3], [10, 4]]) };
  const { w: w2 } = makeWorld([me], b2);
  const { ctx: c2 } = ctxFor(w2, me, { answers: ['__skip', '__skip'], abilityId: 'ability.style-flashy.flashy-style' });
  await runRule(r, c2);
  assert.deepEqual(poolOf(b2[1]).map((p) => p.value), [3, 4]);
});

test('Focused Mastery sets a number to 1–9; Fusion Mastery copies one of 6 or less; Frenzy Mastery replaces one with a d12', async () => {
  const me = fighter(1, 'a');
  const boards = { 1: board([[10, 2], [10, 8]]) };
  const { w } = makeWorld([me], boards);
  await runRule(rulesOf('ability.feature-focused-mastery.focused-mastery', 'self.action_dice.rolled')[0], ctxFor(w, me, { answers: ['0', '9'] }).ctx);
  assert.deepEqual(poolOf(boards[1]).map((p) => p.value), [9, 8]);
  const b2 = { 1: board([[10, 5], [10, 8]]) };
  const { w: w2 } = makeWorld([me], b2);
  const fusion = ctxFor(w2, me, {});
  await runRule(rulesOf('ability.feature-fusion-mastery.fusion-mastery', 'self.action_dice.rolled')[0], fusion.ctx);
  assert.deepEqual(poolOf(b2[1]).map((p) => p.value), [5, 8, 5], 'only the 5 qualifies: copied without asking');
  const b3 = { 1: board([[10, 2], [10, 8]]) };
  const { w: w3 } = makeWorld([me], b3);
  await runRule(rulesOf('ability.feature-frenzy-mastery.frenzy-mastery', 'self.action_dice.rolled')[0], ctxFor(w3, me, { answers: ['0'], rolls: [0.95] }).ctx);
  assert.deepEqual(poolOf(b3[1]).map((p) => p.value), [12, 8]);
});

test('Judgment Style: an enemy holding your Challenge loses their lowest Action Die at the start of their turn', async () => {
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b', { challengeId: 1 });
  const free = fighter(3, 'b');
  const boards = { 2: board([[10, 9], [4, 4], [6, 1]]), 3: board([[10, 9], [4, 4]]) };
  const { w } = makeWorld([me, foe, free], boards);
  const r = rulesOf('ability.style-judgment.judgment-style', 'enemy.turn.start')[0];
  assert.ok(ruleSupport(r).ok, ruleSupport(r).reason);
  await runRule(r, ctxFor(w, me, { event: { activeCharacter: foe } }).ctx);
  assert.deepEqual(poolOf(boards[2]).map((p) => [p.die, p.value]), [[10, 9], [6, 1]], 'the d4 goes: the smallest die');
  await runRule(r, ctxFor(w, me, { event: { activeCharacter: free } }).ctx);
  assert.equal(poolOf(boards[3]).length, 2, 'not without your Challenge');
});

test('Training: once per Action, spend a Training token to raise a number by 2 (only with numbers left)', async () => {
  const me = fighter(1, 'a', { tokens: { training: 2 }, actionPool: [{ value: 3 }] });
  const boards = { 1: board([[10, 3]]) };
  const { w } = makeWorld([me], boards, { context: { activeCharacter: me } });
  const r = rulesOf('ability.resource-mechanic-training.training-mechanics', 'self.action.resolved')[0];
  assert.ok(ruleSupport(r).ok, ruleSupport(r).reason);
  const usage = {};
  const emitted = [];
  const run1 = ctxFor(w, me, { answers: [true], usage });
  run1.ctx.actionSeq = 1;
  run1.ctx.emit = async (ev) => emitted.push(ev);
  await runRule(r, run1.ctx);
  assert.deepEqual(poolOf(boards[1]).map((p) => p.value), [5]);
  assert.equal(me.tokens.training, 1);
  assert.deepEqual(emitted, ['self.training_token_spent']);
  const again = ctxFor(w, me, { answers: [true], usage });
  again.ctx.actionSeq = 1;
  await runRule(r, again.ctx);
  assert.equal(me.tokens.training, 1, 'not twice for the same Action');
  const next = ctxFor(w, me, { answers: [true], usage });
  next.ctx.actionSeq = 2;
  next.ctx.emit = async () => {};
  await runRule(r, next.ctx);
  assert.equal(me.tokens.training, 0, 'the next Action may');
});

test('perform_action: Gunkata picks one of its Gunslinger Actions and performs it with a 4', async () => {
  const me = fighter(1, 'a', { actions: ['action.style-crosshair.take-aim', 'action.system-basic-actions.damage', 'action.style-akimbo.kneecapper'] });
  const { w, performed } = makeWorld([me]);
  const r = rulesOf('ability.archetype-gunkata.focused-gunkata', 'own_turn.start')[0];
  assert.ok(ruleSupport(r).ok, ruleSupport(r).reason);
  const { ctx, asked } = ctxFor(w, me, { answers: ['action.style-akimbo.kneecapper'] });
  await runRule(r, ctx);
  assert.deepEqual(asked[0].options.map((o) => o.id).sort(), ['action.style-akimbo.kneecapper', 'action.style-crosshair.take-aim'], 'Gunslinger Actions only');
  assert.deepEqual(performed, [{ actor: 1, actionId: 'action.style-akimbo.kneecapper', rating: 4 }]);
});

test('teleport_to a space adjacent to the target; a placement makes as many obstacles as its count', async () => {
  const me = fighter(1, 'a', { square: { col: 0, row: 0 } });
  const foe = fighter(2, 'b', { square: { col: 5, row: 5 } });
  const { w, teleports, placed } = makeWorld([me, foe]);
  const rule = { id: 't', events: ['own_turn.start'], effect: idx.get('action.style-relentless.nothing-personal').effect };
  const tp = { op: 'teleport_to', target: { ref: 'self' }, destination: { kind: 'space', range: { mode: 'adjacent_to_binding', origin: 'self' }, count: 1, empty: true, originBinding: 'target' } };
  assert.ok(ruleSupport({ id: 'x', events: ['own_turn.start'], effect: { op: 'sequence', steps: [{ op: 'select', binding: 'target', selector: { kind: 'enemy', range: { mode: 'stance', origin: 'self' }, count: 1 } }, tp] } }).ok);
  const { ctx, asked } = ctxFor(w, me, { answers: ['4,4'] });
  await runRule({ id: 'x', events: ['own_turn.start'], effect: { op: 'sequence', steps: [{ op: 'select', binding: 'target', selector: { kind: 'enemy', range: { mode: 'stance', origin: 'self' }, count: 1 } }, tp] } }, ctx);
  const offered = asked.find((q) => q.kind === 'square').options.map((o) => o.id).sort();
  assert.deepEqual(offered, ['4,4', '4,5', '4,6', '5,4', '5,6', '6,4', '6,5', '6,6'], 'the 8 spaces around the target');
  assert.deepEqual(teleports, [{ id: 1, col: 4, row: 4 }]);
  assert.ok(rule.effect);
  // Pyroclasm: 3 Traps, one space per pick.
  const py = idx.get('action.style-volcanic.pyroclasm');
  const node = JSON.parse(JSON.stringify(py.effect));
  const found = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.op === 'place_obstacle') found.push(n);
    for (const v of Object.values(n)) walk(v);
  };
  walk(node);
  const place = { ...found[0], target: { kind: 'space', range: { mode: 'map', origin: 'self' }, count: 1, empty: true } };
  const p2 = ctxFor(w, me, { answers: ['1,1', '2,2', '3,3'] });
  await runRule({ id: 'p', events: ['own_turn.start'], effect: place }, p2.ctx);
  assert.equal(placed.length, Number(found[0].count), `${found[0].count} placed`);
});

test('a range from another target: "within range of the ally" picks from the ally (origin targets.ally)', async () => {
  const me = fighter(1, 'a', { square: { col: 0, row: 0 } });
  const pal = fighter(2, 'a', { square: { col: 5, row: 5 } });
  const near = fighter(3, 'b', { square: { col: 6, row: 5 } });
  const far = fighter(4, 'b', { square: { col: 1, row: 0 } });
  const { w } = makeWorld([me, pal, near, far]);
  // In range of whoever measures: within 1 of them.
  w.inRange = (from, to) => Math.max(Math.abs(from.square.col - to.square.col), Math.abs(from.square.row - to.square.row)) <= 1;
  const effect = {
    op: 'sequence',
    steps: [
      { op: 'select', binding: 'ally', selector: { kind: 'ally', range: { mode: 'stance', origin: 'self' }, count: 1, excludeSelf: true } },
      { op: 'damage', amount: 1, target: { kind: 'enemy', range: { mode: 'stance', origin: 'targets.ally' }, count: 1 }, actor: { ref: 'targets.ally' } },
    ],
  };
  assert.ok(ruleSupport({ id: 'x', events: ['own_turn.start'], effect }).ok, ruleSupport({ id: 'x', events: ['own_turn.start'], effect }).reason);
  w.inRange = (from, to) => (from.id === 1 ? true : Math.max(Math.abs(from.square.col - to.square.col), Math.abs(from.square.row - to.square.row)) <= 1);
  await runRule({ id: 'x', events: ['own_turn.start'], effect }, ctxFor(w, me, {}).ctx);
  assert.equal(near.hp, 9, 'the enemy next to the ally');
  assert.equal(far.hp, 10, 'not the one next to me');
});
