// Turn structure and reactions (client/src/lib/patd/engine/turn.js, phase F).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { actionUsable, atZero, comebackSquares, evalCondition, reactionClusters, recordUse, turnContext } from '../../client/src/lib/patd/engine/turn.js';

const idx = patdContent();
const SWIFT = 'action.style-swift.swift-strike';
const DAMAGE = 'action.system-basic-actions.damage';

test('turn context: own, allied, enemy turns', () => {
  assert.deepEqual(turnContext({ actorId: 1, actorSide: 'a', activeId: 1, activeSide: 'a' }).isOwnTurn, true);
  const ally = turnContext({ actorId: 2, actorSide: 'a', activeId: 1, activeSide: 'a' });
  assert.deepEqual([ally.isOwnTurn, ally.isAlliedTurn, ally.isEnemyTurn], [false, true, false]);
  assert.equal(turnContext({ actorId: 3, actorSide: 'b', activeId: 1, activeSide: 'a' }).isEnemyTurn, true);
});

test('conditions: Swift Strike only during enemy turns; token equality; unknown refs are left to people', () => {
  const swift = idx.get(SWIFT);
  const own = turnContext({ actorId: 1, actorSide: 'a', activeId: 1, activeSide: 'a' });
  const enemy = turnContext({ actorId: 1, actorSide: 'a', activeId: 9, activeSide: 'b' });
  assert.equal(actionUsable(swift, own, {}, 1).ok, false);
  assert.match(actionUsable(swift, own, {}, 1).reason, /enemy's turn/);
  assert.equal(actionUsable(swift, enemy, {}, 1).ok, true);
  assert.equal(evalCondition({ operator: 'eq', args: [{ ref: 'self.tokens.power' }, 0] }, { tokens: {} }), true);
  assert.equal(evalCondition({ ref: 'context.somethingElse' }, {}), null);
});

test('limits: once per turn counts what was performed and what is still placed', () => {
  const swift = idx.get(SWIFT);
  const enemy = turnContext({ actorId: 1, actorSide: 'a', activeId: 9, activeSide: 'b' });
  const usage = {};
  assert.equal(actionUsable(swift, enemy, usage, 1, 1).ok, false, 'one already placed');
  recordUse(usage, swift, 1);
  assert.deepEqual(Object.keys(usage), [`action:${SWIFT}:1:turn`]);
  assert.match(actionUsable(swift, enemy, usage, 1).reason, /once per turn/);
  assert.equal(actionUsable(swift, enemy, usage, 2).ok, true, 'per fighter');
});

test('reactions by resource: token Actions you can pay, and dice Actions a Chaos token (a 4) reaches', () => {
  const enemy = turnContext({ actorId: 1, actorSide: 'a', activeId: 9, activeSide: 'b' });
  const state = { tokens: { iron: 2 }, hp: 10, shield: 0, challengeHolders: [] };
  const c = reactionClusters({ ids: [SWIFT, DAMAGE], idx, ctx: enemy, usage: {}, fighterId: 1, state, chaos: 1 });
  assert.deepEqual(c.map((x) => [x.resource, x.ids]), [['tokens', [SWIFT]], ['chaos', [DAMAGE]]]);
  const broke = reactionClusters({ ids: [SWIFT, DAMAGE], idx, ctx: enemy, usage: {}, fighterId: 1, state: { ...state, tokens: {} }, chaos: 1, chaosUsed: true });
  assert.deepEqual(broke, [], 'nothing to pay with, Chaos already used this turn');
});

test('Taken Out at zero on the last bar; the Comeback squares lie within 3 of the edge', () => {
  assert.equal(atZero({ max: 10, current: 0, bars: 1, broken: 0 }), true);
  assert.equal(atZero({ max: 10, current: 0, bars: 2, broken: 0 }), false);
  const sq = comebackSquares({ colMin: 0, colMax: 9, rowMin: 0, rowMax: 9 }, () => true);
  assert.ok(sq.some((s) => s.col === 2 && s.row === 5) && !sq.some((s) => s.col === 3 && s.row === 5));
  const lane = comebackSquares({ colMin: 0, colMax: 9, rowMin: 0, rowMax: 1 }, () => true, { colsOnly: true });
  assert.ok(lane.some((s) => s.col === 0) && !lane.some((s) => s.col === 4), 'lanes: from the ends');
});
