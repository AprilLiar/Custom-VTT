// **Nothing silently never happens (after Crush did nothing).** Every Action,
// Super Move and Ability rule is run at every Gate 1-12 with different picks
// and in different situations (an enemy's turn, an ally's, Bleeding, an empty
// Action Pool, at zero HP), tracing each condition the interpreter meets:
//   - every `if` must be able to come out true, and every conditional case
//     must be able to run — a branch that never can is a silent failure;
//   - every value read that comes back missing must be one that is meant to
//     be missing sometimes (ALLOWED_MISSING).
// And every `event.*` value a rule reads must be one the engine really sends
// with that event (ENGINE_EVENT_FIELDS — checked against server/triggers.js,
// engine/hits.js, engine/moves.js and engine/actions.js), so a rule reading a
// value no event carries (Artistic Style's `event.enemy`) can't slip in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { runIt } from './fakeWorld.js';

const C = patdContent().content;

const SCENARIOS = [
  [0, null],
  [1, null],
  [2, null],
  [3, null],
  [4, null],
  [0, (w) => (w.world.context.activeCharacter = w.foe)],
  [0, (w) => (w.world.context.activeCharacter = w.ally)],
  [0, (w) => w.world.fighters().forEach((f) => (f.bleeding = true))],
  [0, (w) => ((w.me.actionPool = []), (w.world.pool = () => []))],
  [0, (w) => (w.me.hp.current = 0)],
];
// Missing by design: "if this broke their Shield", an operator's unused argument, the engine's own.
const ALLOWED_MISSING = new Set(['history.shieldBroke', 'history.movementEnd', 'context.heroicSpiritRecipient']);
// The fake world can't make these true; each was checked by hand in the real engine.
const UNREACHABLE_HERE = new Set([]);

test('every condition can come out true, every case can run, and nothing reads a value that is never there', async () => {
  const ifs = new Map();
  const cases = new Map();
  const missing = new Map();
  const items = [
    ...C.actions.map((x) => ({ x, rule: { id: x.id, effect: x.effect } })),
    ...C.superMoves.filter((x) => !x.id.endsWith('transcendant-spirit')).map((x) => ({ x, rule: { id: x.id, effect: x.effect } })),
    ...C.abilities.flatMap((a) => (a.rules ?? []).filter((r) => !r.events.includes('continuous')).map((r) => ({ x: a, rule: { ...r, limit: undefined } }))),
  ];
  for (const it of items) {
    for (let gate = 1; gate <= 12; gate++) {
      for (const [pick, tweak] of SCENARIOS) {
        const trace = (kind, what, yes) => {
          if (kind === 'if') ifs.set(what, { name: it.x.name, yes: (ifs.get(what)?.yes ?? false) || yes, cond: what.condition });
          else if (kind === 'case') cases.set(what, { name: it.x.name, yes: (cases.get(what)?.yes ?? false) || yes });
          else if (kind === 'undefined' && !ALLOWED_MISSING.has(what)) missing.set(`${what} (${it.x.name})`, true);
        };
        try {
          await runIt(it.x.name, it.rule, { gate, pick, trace, tweak });
        } catch {
          /* allRules.test.js covers crashes */
        }
      }
    }
  }
  const never = [...ifs.values()].filter((e) => !e.yes && !UNREACHABLE_HERE.has(e.name)).map((e) => `${e.name}: ${JSON.stringify(e.cond)}`);
  assert.deepEqual(never, [], 'conditions that never come out true');
  assert.deepEqual([...cases.values()].filter((e) => !e.yes).map((e) => e.name), [], 'cases that never run');
  assert.deepEqual([...missing.keys()], [], 'values read that are never there');
});

// What the engine sends with each event a rule reads `event.*` from.
const ENGINE_EVENT_FIELDS = {
  'allied_turn.start': ['activeCharacter'],
  'enemy.turn.start': ['activeCharacter'],
  'enemy_turn.start': ['activeCharacter'],
  'own_turn.start': ['activeCharacter'],
  'any_turn.start': ['activeCharacter'],
  'ally_in_range.would_take_damage': ['damage', 'target', 'attacker'],
  'self.would_take_damage': ['damage', 'target', 'attacker'],
  'enemy.destroyed_own_copy': ['copy', 'attacker'],
  'self.copy_destroyed': ['copy', 'attacker'],
  'enemy.removed_own_challenge_by_enemy_action_or_ability': ['formerHolder', 'remover', 'challenger'],
  'enemy_in_range.action.cost_paid_before_resolution': ['action', 'actor'],
  'enemy_in_range.broke_allied_shield': ['attacker', 'amount', 'shieldBroke', 'target', 'enemy'],
  'enemy_in_range.damaged_allied_shield': ['attacker', 'amount', 'shieldBroke', 'target', 'enemy'],
  'enemy_in_range.own_shield_broken': ['attacker', 'amount', 'shieldBroke', 'target', 'enemy'],
  'enemy_in_range.own_shield_damaged': ['attacker', 'amount', 'shieldBroke', 'target', 'enemy'],
  'enemy_in_range.trap_damage_taken': ['target', 'amount'],
  'self.action.damage_dealt_to_enemy': ['action', 'history', 'enemyCount'],
  'self.action.resolved': ['action', 'history', 'enemiesDamaged', 'enemiesForcedMoved', 'alliesForcedMoved', 'movedSwappedOrTeleportedSelf', 'actionTargets', 'distinctTargetCount', 'enemyTargets', 'obstaclesDestroyed'],
  'self.dice_action.resolved': ['action', 'history', 'enemiesDamaged', 'enemiesForcedMoved', 'alliesForcedMoved', 'movedSwappedOrTeleportedSelf', 'actionTargets', 'distinctTargetCount', 'enemyTargets', 'obstaclesDestroyed'],
  'self.damage_dealing_action.resolved': ['action', 'history', 'enemiesDamaged', 'enemiesForcedMoved', 'alliesForcedMoved', 'movedSwappedOrTeleportedSelf', 'actionTargets', 'distinctTargetCount', 'enemyTargets', 'obstaclesDestroyed'],
  'self.throw_or_grapple.resolved': ['action', 'history', 'enemiesDamaged', 'enemyTargets', 'actionTargets'],
  'self.challenge_given_to_enemy': ['target'],
  'self.control_tokens_spent': ['amount', 'action', 'controlledActor'],
  'self.damage_dealt': ['target', 'amount', 'damage'],
  'self.damage_dealt_to_enemy': ['target', 'enemy', 'amount'],
  'self.damage_taken': ['attacker', 'amount', 'sourceType'],
  'self.took_damage_from_action': ['attacker', 'amount', 'enemyDamageDealers'],
  'self.took_damage_from_enemy_action': ['attacker', 'amount'],
  'self.gain_speed_tokens': ['amount', 'replace'],
  'self.hit_enhanced_with_power': ['target', 'amount'],
  'self.hit_reduced': ['attacker'],
  'self.hit_reduced_from_enemy': ['attacker', 'enemy'],
  'self.pushed': ['pusher', 'source', 'square'],
  'self.shield_absorbed': ['attacker', 'amount', 'shieldBroke', 'target', 'enemy'],
  'self.shield_absorbed_from_enemy_action': ['attacker', 'amount', 'shieldBroke', 'target', 'enemy'],
  'self.tokens_discarded_by_action_or_ability': ['amount', 'isCostPayment'],
  // The engine's own (coverage.js NATIVE_RULES): never emitted, read natively.
  'self.move_over_wall': ['wall'],
  'self.mythical_d12.rolled': ['die'],
};

test('every event value a rule reads is one the engine sends with that event', () => {
  const bad = [];
  for (const a of C.abilities) {
    for (const r of a.rules ?? []) {
      const fields = [...new Set([...JSON.stringify(r).matchAll(/"ref":"event\.([A-Za-z]+)/g)].map((m) => m[1]))];
      for (const ev of r.events) for (const f of fields) if (!(ENGINE_EVENT_FIELDS[ev] ?? []).includes(f)) bad.push(`${a.name}: ${ev} → event.${f}`);
    }
  }
  assert.deepEqual(bad, []);
});
