// Board animations: the server's effects log (fx.js) and the client's queue
// and held display (boardFx.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainFx, groupBeats, muteFx, recordFx, resetFx, tokenChanges, unmuteFx } from '../fx.js';
import { CATCH_UP_AFTER, MAX_WAITING, effectMs, enqueue, heldFight, heldSquare, heldTiles, moveHow, outcomesOf, playMs, signOf, slideTransition } from '../../client/src/lib/boardFx.js';

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

test('phase 2: what a hit or a heal led to is read off its before and after', () => {
  const hp = (current, broken = 0, dizzy = false, bars = 2) => ({ tokens: {}, hp: { max: 10, current, bars, broken, dizzy }, challenge_id: null });
  const dmg = (before, after, data = {}) => ({ kind: 'damage', before, after, data });
  assert.deepEqual(outcomesOf(dmg(hp(10), hp(7), { broke: true, blocked: 2 })), { shieldBroke: true, armor: 2, barBroke: false, dizzied: false, takenOut: false, revived: false });
  const broke = outcomesOf(dmg(hp(2), hp(10, 1, true)));
  assert.ok(broke.barBroke && broke.dizzied && !broke.takenOut);
  assert.ok(outcomesOf(dmg(hp(3, 1, true), hp(0, 1, true))).takenOut);
  assert.ok(outcomesOf({ kind: 'heal', before: hp(0, 1), after: hp(2, 1), data: { amount: 2 } }).revived);
  assert.equal(effectMs(dmg(hp(3, 1, true), hp(0, 1, true))), 1100);
  assert.equal(effectMs(dmg(hp(2), hp(10, 1, true))), 1000);
  assert.equal(effectMs(dmg(hp(10), hp(7))), 800);
});

test('phase 3: a fighter is held where it was until its move plays; a move carries no state', () => {
  const mv = (cid, from, to, how = 'move') => ({ id: cid * 10, kind: 'move', combatantId: cid, before: null, after: null, data: { from, to, how } });
  const A = { col: 1, row: 1 };
  const B = { col: 4, row: 1 };
  const beat = (e) => ({ id: e.id, effects: [e] });
  assert.deepEqual(heldSquare(7, B, null, [beat(mv(7, A, B))]).square, A);
  const playing = beat(mv(7, A, B, 'push'));
  const h = heldSquare(7, B, playing, []);
  assert.deepEqual(h.square, B);
  assert.equal(h.move.data.how, 'push');
  assert.equal(heldSquare(7, null, null, [beat(mv(7, A, null))]).square, A);
  assert.equal(heldSquare(7, B, null, []).square, B);
  // A move playing doesn't un-hold a later damage beat's state.
  const real = { combatant_id: 7, ...st({}, 4) };
  const later = { id: 2, effects: [{ id: 2, combatantId: 7, kind: 'damage', before: st({}, 10), after: st({}, 4) }] };
  assert.equal(heldFight(real, playing, [later]).hp.current, 10);
  assert.equal(moveHow(mv(7, A, null)), 'out');
  assert.equal(moveHow(mv(7, null, A)), 'in');
  assert.equal(effectMs(mv(7, A, B, 'teleport')), 500);
  assert.equal(effectMs(mv(7, A, { col: 2, row: 1 })), 300);
  assert.equal(effectMs(mv(7, A, { col: 9, row: 1 })), 700);
  assert.equal(slideTransition({ how: 'teleport', ms: 500 }, 'x'), 'none');
  assert.equal(slideTransition(null, 'x'), 'x');
  assert.match(slideTransition({ how: 'move', ms: 400 }, 'x'), /^left 360ms/);
});

test('phase 3: tiles are held — waiting placements hidden, destructions shown, moves put back', () => {
  const t = (change, tile, at, extra = {}) => ({ id: Math.random(), kind: 'tile', combatantId: null, data: { change, tile, at, ...extra } });
  const real = [
    { col: 2, row: 2, kind: 'wall' },
    { col: 5, row: 5, kind: 'trap' },
    { col: 3, row: 3, kind: 'copy', owner_id: 9 },
  ];
  const waiting = [
    { id: 1, effects: [t('destroyed', 'rubble', { col: 8, row: 8 })] },
    { id: 2, effects: [t('placed', 'wall', { col: 2, row: 2 })] },
    { id: 3, effects: [t('moved', 'trap', { col: 5, row: 5 }, { from: { col: 1, row: 5 } })] },
    { id: 4, effects: [t('placed', 'copy', { col: 3, row: 3 }, { owner_id: 9 })] },
  ];
  const held = heldTiles(real, waiting);
  const key = (x) => `${x.kind}@${x.col},${x.row}`;
  assert.deepEqual(held.map(key).sort(), ['rubble@8,8', 'trap@1,5']);
  assert.equal(heldTiles(real, []), real);
});

test('phase 3: an obstacle taken off one square and put on another is one "moved" effect; tiles group per square', () => {
  resetFx();
  const tile = (change, tileKind, at) => ({ sceneId: 1, mode: 'combat', kind: 'tile', combatantId: null, data: { change, tile: tileKind, at } });
  recordFx(tile('destroyed', 'trap', { col: 1, row: 1 }));
  recordFx(tile('placed', 'trap', { col: 3, row: 1 }));
  recordFx(tile('destroyed', 'wall', { col: 4, row: 4 }));
  recordFx(tile('placed', 'rubble', { col: 4, row: 4 }));
  recordFx(tile('placed', 'fog', { col: 6, row: 6 }));
  recordFx(tile('placed', 'fog', { col: 7, row: 6 }));
  const beats = drainFx();
  assert.deepEqual(
    beats.map((b) => b.effects.map((e) => `${e.data.change}:${e.data.tile}`)),
    [['moved:trap'], ['destroyed:wall'], ['placed:rubble'], ['placed:fog', 'placed:fog']]
  );
  assert.deepEqual(beats[0].effects[0].data.from, { col: 1, row: 1 });
});
