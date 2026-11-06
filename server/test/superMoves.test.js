// Full automation, phase I — Super Moves on the board (decided: all limits
// enforced) and the Super Moves' own operations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { ruleSupport, runRule } from '../../client/src/lib/patd/interpreter.js';
import { isSuperMove, superOnBoard, superPair, superUsable } from '../../client/src/lib/patd/engine/turn.js';
import { livePool, poolOf } from '../../client/src/lib/patd/diceBoard.js';

const idx = patdContent();
const PILEDRIVER = idx.get('super-move.archetype-angel.heavens-piledriver');
const TRANSCENDANT = idx.get('super-move.archetype-teacher.transcendant-spirit');

test('which Super Moves go on the board: all but Transcendant Spirit (used while giving your Heroic Spirit)', () => {
  assert.ok(isSuperMove(PILEDRIVER) && superOnBoard(PILEDRIVER));
  assert.ok(isSuperMove(TRANSCENDANT) && !superOnBoard(TRANSCENDANT));
  assert.ok(!isSuperMove(idx.get('action.system-basic-actions.damage')));
  const onBoard = idx.content.superMoves.filter(superOnBoard).length;
  assert.equal(onBoard, idx.content.superMoves.length - 1);
});

test('the limits: not in Round 1, once per fight, the side’s per-Round limit by Cinematic Weight', () => {
  const base = { move: PILEDRIVER, round: 2, usedByMe: 0, sideUsed: 0, sideLimit: 1 };
  assert.deepEqual(superUsable(base), { ok: true });
  assert.match(superUsable({ ...base, round: 1 }).reason, /Round 1/);
  assert.match(superUsable({ ...base, usedByMe: 1 }).reason, /once per fight/);
  assert.match(superUsable({ ...base, pending: 1 }).reason, /once per fight/, 'one already placed counts');
  assert.match(superUsable({ ...base, sideUsed: 1 }).reason, /this Round/);
  assert.ok(superUsable({ ...base, sideUsed: 1, sideLimit: 2 }).ok, 'Worldweight: 2 per side per Round');
  assert.match(superUsable({ ...base, sideLimit: 0 }).reason, /Cinematic Weight/, 'Featherweight: none');
  assert.match(superUsable({ ...base, move: TRANSCENDANT }).reason, /Heroic Spirit/);
});

test('the pair: the picked number and a free one matching it, both 3 or higher', () => {
  const data = { results: [{ die: 6, result: 5 }, { die: 6, result: 2 }, { die: 6, result: 5 }, { die: 6, result: 2 }], extra: [] };
  const pool = poolOf(data);
  assert.deepEqual(superPair(pool, 0), [0, 2]);
  assert.deepEqual(superPair(pool, 2), [2, 0]);
  assert.equal(superPair(pool, 1), null, 'a pair of 2s is too low');
  assert.equal(superPair(pool, 0, [2]), null, 'its mate is already placed');
  // Committed, both numbers leave the live pool.
  assert.deepEqual(livePool({ ...data, placements: [{ kind: 'super', die: 0, dice: [0, 2], committed: true }] }).map((p) => p.index), [1, 3]);
});

// A small fake world for the Super Moves' effects.
function makeWorld(fighters) {
  return {
    context: { healValue: 2, bleedValue: 4, round: 2 },
    fighters: () => fighters,
    enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
    alliesOf: (f) => fighters.filter((x) => x.side === f.side),
    inRange: (from, to) => !to.far,
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
    addTemp: () => {},
    forced: async () => null,
  };
}
const fighter = (id, side, extra = {}) => ({ id, name: `F${id}`, side, tokens: {}, hp: 20, ...extra });
const run = (move, self, w, answers = []) => runRule({ id: move.id, events: ['own_turn.start'], effect: move.effect }, { world: w, self, state: {}, usage: {}, ability: move, log: () => {}, ask: async (q) => answers.shift() ?? q.options?.[0]?.id, source: 'super' });

test('Erupting Burning Fist: Burning tokens until they hold 6', async () => {
  const move = idx.get('super-move.archetype-flametongue.erupting-burning-fist');
  assert.ok(ruleSupport({ id: move.id, events: ['own_turn.start'], effect: move.effect }).ok);
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b', { tokens: { burning: 2 } });
  await run(move, me, makeWorld([me, foe]));
  assert.equal(foe.tokens.burning, 6);
  assert.equal(foe.hp, 16);
});

test('Lucky Hit: 4 damage, then all their Basic tokens and their Shield are gone', async () => {
  const move = idx.get('super-move.archetype-underdog.lucky-hit');
  assert.ok(ruleSupport({ id: move.id, events: ['own_turn.start'], effect: move.effect }).ok, ruleSupport({ id: move.id, events: ['own_turn.start'], effect: move.effect }).reason);
  const me = fighter(1, 'a');
  const foe = fighter(2, 'b', { tokens: { power: 2, iron: 1, speed: 3, burning: 1, shield: 3 } });
  await run(move, me, makeWorld([me, foe]));
  assert.equal(foe.hp, 16);
  assert.deepEqual([foe.tokens.power, foe.tokens.iron, foe.tokens.speed, foe.tokens.shield], [0, 0, 0, 0]);
  assert.equal(foe.tokens.burning, 1, 'not a Basic token');
});

test('Lead Rain: the target and every enemy next to it, once per damage step', async () => {
  const move = idx.get('super-move.archetype-gunkata.lead-rain');
  assert.ok(ruleSupport({ id: move.id, events: ['own_turn.start'], effect: move.effect }).ok);
  const me = fighter(1, 'a', { square: { col: 0, row: 0 } });
  const t = fighter(2, 'b', { square: { col: 5, row: 5 } });
  const next = fighter(3, 'b', { square: { col: 6, row: 5 } });
  const away = fighter(4, 'b', { square: { col: 9, row: 9 } });
  await run(move, me, makeWorld([me, t, next, away]), ['2']);
  const hits = move.effect.steps.filter((s) => s.op === 'damage').length;
  assert.ok(hits >= 3);
  assert.equal(t.hp, 20 - hits);
  assert.equal(next.hp, 20 - hits);
  assert.equal(away.hp, 20);
});

test('Inspire Perfection: yourself and each ally you can see', async () => {
  const move = idx.get('super-move.archetype-cavalry.inspire-perfection');
  assert.ok(ruleSupport({ id: move.id, events: ['own_turn.start'], effect: move.effect }).ok);
  const me = fighter(1, 'a', { tokens: { burning: 2 } });
  const pal = fighter(2, 'a');
  const hidden = fighter(3, 'a', { far: true });
  const foe = fighter(4, 'b');
  await run(move, me, makeWorld([me, pal, hidden, foe]));
  assert.equal(me.tokens.power, 2);
  assert.equal(pal.tokens.iron, 2);
  assert.equal(hidden.tokens.power, undefined, 'not one you can’t see');
  assert.equal(foe.tokens.power, undefined);
  assert.equal(me.tokens.burning, 0, 'Status tokens removed');
});
