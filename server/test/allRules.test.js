// **Every rule, run (the QA pass).** Each Ability rule, Action and Super Move
// in the content is executed through the interpreter against a full fake
// world, with every question answered (the first legal option, "yes"), at a
// low and a high Gate. Nothing may throw, and nothing may come back "by hand":
// the census (coverage.js) says what is automatic, this proves it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { runIt } from './fakeWorld.js';
import { ENGINE_NATIVE, isNativeRule } from '../../client/src/lib/patd/coverage.js';

const idx = patdContent();
const C = idx.content;

const abilityRules = (C.abilities ?? []).filter((a) => !ENGINE_NATIVE.has(a.id)).flatMap((a) => (a.rules ?? []).filter((r) => !r.events.includes('continuous') && !r.events.includes('stance.construct') && !isNativeRule(r)).map((r) => ({ a, r })));

test('every triggered Ability rule runs to the end, with nothing by hand', async () => {
  const failures = [];
  for (const { a, r } of abilityRules) {
    for (const gate of [2, 9]) {
      try {
        const by = await runIt(a.name, { ...r, condition: undefined, limit: undefined }, { gate });
        if (by.length) failures.push(`${a.name} (${r.id}): by hand — ${by.join(', ')}`);
      } catch (err) {
        failures.push(`${a.name} (${r.id}) at ${gate}: ${err.message}`);
      }
    }
  }
  assert.deepEqual([...new Set(failures)], []);
});

test('every Action runs to the end at its lowest and highest Gate, with nothing by hand', async () => {
  const failures = [];
  for (const x of C.actions ?? []) {
    for (const gate of [1, 10]) {
      try {
        const by = await runIt(x.name, { id: x.id, effect: x.effect }, { gate });
        if (by.length) failures.push(`${x.name}: by hand — ${by.join(', ')}`);
      } catch (err) {
        failures.push(`${x.name} at ${gate}: ${err.message}`);
      }
    }
  }
  assert.deepEqual([...new Set(failures)], []);
});

// **Something happens (fixed after Crush did nothing):** at its highest Gate,
// every Action that targets or changes something does at least one thing.
// Exempt: those that only change the rules for a while or act through the
// world's own calls (movement, placing), which this fake world doesn't log.
test('every Action does something at its highest Gate — none resolves silently', async () => {
  const quiet = [];
  for (const x of C.actions ?? []) {
    const lines = [];
    const calls = [];
    try {
      await runIt(x.name, { id: x.id, effect: x.effect }, { gate: 10, lines });
    } catch {
      continue;
    }
    if (!lines.length && !calls.length && !/"op":"(move|teleport|teleport_to|push|pull|pull_until|swap_spaces|temporary|modify_rule|perform_action|place_obstacle|destroy_obstacle|replace_obstacle|move_obstacles|reduce_damage|split_incoming_damage|notify|schedule|register_trigger|return_to_play|remove_from_play|replay_start_effects|reroll_die|reroll_dice|combine_pool_numbers|split_pool_number|set_pool_number|increase_pool_number|duplicate_pool_number|modify_pool_numbers|forcedObstacle)"/.test(JSON.stringify(x.effect)))
      quiet.push(x.name);
  }
  assert.deepEqual(quiet, []);
});

test('every Super Move runs to the end, with nothing by hand (Transcendant Spirit: the engine’s own)', async () => {
  const failures = [];
  for (const x of C.superMoves ?? []) {
    if (x.id === 'super-move.archetype-teacher.transcendant-spirit') continue;
    try {
      const by = await runIt(x.name, { id: x.id, effect: x.effect }, { gate: 6 });
      if (by.length) failures.push(`${x.name}: by hand — ${by.join(', ')}`);
    } catch (err) {
      failures.push(`${x.name}: ${err.message}`);
    }
  }
  assert.deepEqual(failures, []);
});
