// Board animations: the server's effects log (fx.js) and the client's queue
// and held display (boardFx.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainFx, groupBeats, muteFx, recordFx, resetFx, tokenChanges, unmuteFx } from '../fx.js';
import { CATCH_UP_AFTER, MAX_WAITING, enqueue, heldFight, playMs, signOf } from '../../client/src/lib/boardFx.js';

const st = (tokens = {}, current = 10, challenge_id = null) => ({ tokens, hp: { max: 10, current, bars: 1, broken: 0, dizzy: false }, challenge_id });
const fx = (combatantId, kind, before, after, data = {}) => ({ sceneId: 1, mode: 'combat', combatantId, kind, before, after, data });

test('token changes: deltas per key, no zeros', () => {
  assert.deepEqual(tokenChanges({ power: 2, iron: 1 }, { power: 2, iron: 3, dizzy: 1 }), [
    { key: 'iron', delta: 2 },
    { key: 'dizzy', delta: 1 },
  ]);
  assert.deepEqual(tokenChanges({ shield: 2 }, {}), [{ key: 'shield', delta: -2 }]);
});

test('a fighter’s token writes back to back are one effect; nothing changed is none', () => {
  resetFx();
  recordFx(fx(1, 'tokens', st({}), st({ power: 1 })));
  recordFx(fx(1, 'tokens', st({ power: 1 }), st({ power: 1, iron: 2 })));
  recordFx(fx(2, 'tokens', st({ dizzy: 1 }), st({ dizzy: 1 })));
  const beats = drainFx();
  assert.equal(beats.length, 1);
  assert.deepEqual(beats[0].effects[0].data.changes, [
    { key: 'power', delta: 1 },
    { key: 'iron', delta: 2 },
  ]);
  assert.deepEqual(drainFx(), []);
});

test('muted fighters record nothing (a hit collects its own changes)', () => {
  resetFx();
  muteFx(1);
  recordFx(fx(1, 'tokens', st({ shield: 2 }), st({ shield: 1 })));
  recordFx(fx(2, 'tokens', st({}), st({ power: 1 })));
  unmuteFx(1);
  recordFx(fx(1, 'damage', st({ shield: 2 }), st({ shield: 1 }, 7), { amount: 3, absorbed: 1 }));
  const beats = drainFx();
  assert.deepEqual(
    beats.map((b) => b.effects.map((e) => [e.combatantId, e.kind])),
    [[[2, 'tokens']], [[1, 'damage']]]
  );
});

test('same kind on different fighters, back to back, is one beat; the same fighter again starts a new one', () => {
  const e = (id, kind, data = {}, cid = id) => ({ id, sceneId: 1, mode: 'combat', combatantId: cid, kind, data });
  const beats = groupBeats([
    e(1, 'damage', {}, 10),
    e(2, 'damage', {}, 11),
    e(3, 'damage', {}, 10),
    e(4, 'tokens', { changes: [{ key: 'dizzy', delta: 1 }] }, 11),
    e(5, 'tokens', { changes: [{ key: 'dizzy', delta: 1 }] }, 12),
    e(6, 'tokens', { changes: [{ key: 'power', delta: 1 }] }, 13),
  ]);
  assert.deepEqual(
    beats.map((b) => b.effects.map((x) => x.id)),
    [[1, 2], [3], [4, 5], [6]]
  );
});

test('held display: before the beat its waiting state, while playing its after, else the real one', () => {
  const real = { combatant_id: 7, active_stance_id: 's', ...st({ power: 3 }, 4) };
  const beatA = { id: 1, effects: [{ id: 1, combatantId: 7, kind: 'damage', before: st({ power: 3 }, 10), after: st({ power: 3 }, 6) }] };
  const beatB = { id: 2, effects: [{ id: 2, combatantId: 7, kind: 'damage', before: st({ power: 3 }, 6), after: st({ power: 3 }, 4) }] };
  assert.equal(heldFight(real, null, [beatA, beatB]).hp.current, 10);
  assert.equal(heldFight(real, beatA, [beatB]).hp.current, 6);
  assert.equal(heldFight(real, beatB, []).hp.current, 4);
  assert.equal(heldFight(real, null, []), real);
  // Only what's drawn is held: the Stance stays the real one.
  assert.equal(heldFight(real, null, [beatA]).active_stance_id, 's');
  // Someone else's beat leaves this fighter as it is.
  assert.equal(heldFight({ ...real, combatant_id: 8 }, beatA, [beatB]).hp.current, 4);
});

test('pacing: speed setting, catching up, never too many waiting', () => {
  const beat = { effects: [{ kind: 'tokens' }, { kind: 'shield' }] };
  assert.equal(playMs(beat, 'normal', 0), 1200);
  assert.equal(playMs(beat, 'fast', 0), 600);
  assert.equal(playMs(beat, 'normal', CATCH_UP_AFTER + 1), 600);
  assert.equal(playMs(beat, 'off', 0), 0);
  const many = Array.from({ length: MAX_WAITING + 5 }, (_, i) => ({ id: i, effects: [{ kind: 'heal' }] }));
  const q = enqueue([], many);
  assert.equal(q.length, MAX_WAITING);
  assert.equal(q[0].id, 5);
  assert.deepEqual(enqueue([], [{ id: 1, effects: [] }]), []);
});

test('signs: one is "+"/"-", two or more doubles it', () => {
  assert.deepEqual([1, 2, 5, -1, -2].map(signOf), ['+', '++', '++', '-', '--']);
});
