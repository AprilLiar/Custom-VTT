// The engine core (client/src/lib/patd/engine/): event routing, modifiers,
// runtime boundaries and temporaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { listenersFor, turnEvents } from '../../client/src/lib/patd/engine/bus.js';
import { listMod, modifiersOn, sumMod, valueOf } from '../../client/src/lib/patd/engine/modifiers.js';
import { addTemp, emptyRuntime, expireTemps, fighterRt, startTurn } from '../../client/src/lib/patd/engine/runtime.js';

const idx = patdContent();
const F = (id, side, square, abilityIds = [], range = { minimum: 1, maximum: 2 }) => ({ id, name: `F${id}`, side, square, abilityIds, stance: { range } });
const worldOf = (fighters) => ({
  fighters: () => fighters,
  alliesOf: (f) => fighters.filter((x) => x.side === f.side),
  enemiesOf: (f) => fighters.filter((x) => x.side !== f.side),
  inRange: (a, b, range) => {
    if (range?.mode === 'none' || range?.mode === 'map') return true;
    const d = Math.max(Math.abs(a.square.col - b.square.col), Math.abs(a.square.row - b.square.row));
    const r = range?.mode === 'explicit' ? range : a.stance.range;
    return d >= (r.minimum ?? 0) && d <= r.maximum;
  },
});

test('the bus routes each event name to the right listeners', () => {
  const a = F(1, 'allies', { col: 0, row: 0 });
  const b = F(2, 'allies', { col: 1, row: 0 });
  const e = F(3, 'enemies', { col: 2, row: 0 });
  const far = F(4, 'enemies', { col: 9, row: 9 });
  const w = worldOf([a, b, e, far]);
  const ids = (name, subj) => listenersFor(name, subj, w).map((f) => f.id);
  assert.deepEqual(ids('self.damage_taken', a), [1]);
  assert.deepEqual(ids('ally.action.resolved', a), [2]);
  assert.deepEqual(ids('enemy.removed_own_challenge_by_enemy_action_or_ability', a), [3, 4]);
  assert.deepEqual(ids('enemy_in_range.trap_damage_taken', a), [3], 'only the enemy with F1 in its range');
  assert.deepEqual(ids('any_action.fully_resolved', a), [1, 2, 3, 4]);
  assert.deepEqual(turnEvents('start', 'ally'), ['allied_turn.start', 'any_turn.start']);
});

test('modifiers: continuous rules of active sources, auras over others, and temporaries', () => {
  // Shadow Form keeps Speed; Power Form 2 extra Enhances; Shining Style: enemies can't enter adjacent spaces.
  const me = F(1, 'allies', { col: 0, row: 0 }, ['ability.form-shadow.shadow-form', 'ability.form-power.power-form']);
  const shining = F(2, 'enemies', { col: 3, row: 3 }, ['ability.style-shining.shining-style']);
  const w = worldOf([me, shining]);
  const mods = modifiersOn(me, w, idx, []);
  assert.equal(valueOf(mods, 'end_phase.speed_discard'), 0);
  assert.equal(sumMod(mods, 'enhance_hit.additional_uses'), 2);
  assert.equal(valueOf(mods, 'movement.cannot_enter_adjacent_to_self'), true, "Shining Style's aura reaches its enemies (range: none)");
  assert.equal(valueOf(modifiersOn(shining, w, idx, []), 'movement.cannot_enter_adjacent_to_self'), null, 'but not its owner');
  // A temporary on me only.
  const temps = [{ targetId: 1, rule: 'unblockable', value: ['shields'], duration: 'end_of_current_turn' }];
  assert.deepEqual(listMod(modifiersOn(me, w, idx, temps), 'unblockable'), ['shields']);
  // Iron Form's lasting Armor shows up as an Armor source.
  const iron = F(5, 'allies', { col: 0, row: 1 }, ['ability.form-iron.iron-form']);
  assert.equal(modifiersOn(iron, worldOf([iron]), idx, []).filter((m) => m.rule === 'armor.source').length, 1);
});

test('runtime: turn and round boundaries reset counters, flags and expire temporaries', () => {
  const rt = emptyRuntime();
  rt.usage = { 'r1:1:turn': 1, 'r2:1:round': 1, 'r3:1:fight': 1, 'r4:1:own_turn': 1, 'r4:2:own_turn': 1 };
  fighterRt(rt, 1).flags.moved = true;
  startTurn(rt, 2, 1);
  assert.deepEqual(Object.keys(rt.usage).sort(), ['r2:1:round', 'r3:1:fight', 'r4:1:own_turn'], 'per turn gone; own_turn only for the active fighter (2)');
  assert.deepEqual(fighterRt(rt, 1).flags, {});
  startTurn(rt, 1, 2);
  assert.deepEqual(Object.keys(rt.usage).sort(), ['r3:1:fight'], 'a new round clears per round; own turn of 1 reset');

  const t = emptyRuntime();
  startTurn(t, 1, 1); // turn seq 1, F1's turn
  addTemp(t, { ownerId: 1, targetId: 1, duration: 'start_of_next_own_turn', rule: 'x' });
  addTemp(t, { ownerId: 1, targetId: 3, duration: 'after_end_of_target_next_turn', rule: 'y' });
  addTemp(t, { ownerId: 1, targetId: 1, duration: 'end_of_current_turn_or_next_action', rule: 'z' });
  addTemp(t, { ownerId: 1, targetId: 1, duration: 'end_of_next_round', rule: 'w' });
  assert.deepEqual(expireTemps(t, 'action', { actorId: 1 }).map((x) => x.rule), [], 'not after the Action that made it');
  t.actionSeq = 1; // the next Action (server/engine/actions.js counts them)
  assert.deepEqual(expireTemps(t, 'action', { actorId: 1 }).map((x) => x.rule), ['z'], '"or next action" ends after the next Action');
  assert.deepEqual(expireTemps(t, 'start_of_turn', { activeId: 1 }).map((x) => x.rule), [], 'not the same turn');
  startTurn(t, 3, 1); // F3's turn
  assert.deepEqual(expireTemps(t, 'end_of_turn', { activeId: 3 }).map((x) => x.rule), ['y'], "after the target's next turn");
  startTurn(t, 1, 2);
  assert.deepEqual(expireTemps(t, 'start_of_turn', { activeId: 1 }).map((x) => x.rule), ['x']);
  assert.deepEqual(expireTemps(t, 'end_of_round').map((x) => x.rule), ['w'], 'installed in round 1, ends at the end of round 2');
});
