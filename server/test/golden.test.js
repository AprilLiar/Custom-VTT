// **Golden rule tests (play feedback 8).** The other content tests prove every
// rule RUNS (allRules.test.js) and that each condition can be met
// (branches.test.js). These prove the most-played Actions DO WHAT THEIR CARD
// SAYS: each case below was worked out by hand from the printed rules text
// (quoted above it) — the exact damage, pushes, tokens, Shields and
// Challenges at each Gate — never copied from the engine's output.
//
// The world is the shared fake one (fakeWorld.js), with each effect recorded:
//   damage(target, n, unblockable?) · push/pull(target, n) · gain(target, token, n)
//   shield(target, value) · tempArmor(target) · challenge(target)
//   teleport(self, n) · move(self, n)
// Questions pick an enemy when one is offered (so "someone" is the enemy F3).
// Token gains are compared as totals, listed after the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patdContent } from '../patdContent.js';
import { makeWorld } from './fakeWorld.js';
import { runRule } from '../../client/src/lib/patd/interpreter.js';

const idx = patdContent();
const action = (id) => {
  const a = idx.get(id);
  assert.ok(a, `no Action ${id}`);
  return a;
};

// Runs an Action at a Gate (its X for an X cost) → the recorded effects, in order.
async function perform(id, gate) {
  const w = makeWorld();
  const log = [];
  const name = (f) => f?.name ?? String(f);
  const wr = w.world;
  const orig = { ...wr };
  wr.damage = async (f, n, attacker, opts = {}) => {
    // Unblockable passed with the hit, or set by the Action as a rule (Crush).
    const ruled = (opts.mods ?? []).filter((m) => m.rule === 'unblockable').flatMap((m) => [].concat(m.value ?? []));
    const ub = [...(opts.unblockable ?? []), ...(opts.ignore ?? []), ...ruled];
    log.push(ub.length ? `damage ${name(f)} ${n} unblockable:${[...new Set(ub)].sort().join('+')}` : `damage ${name(f)} ${n}`);
    return orig.damage(f, n, attacker, opts);
  };
  wr.forced = async (f, opts) => {
    log.push(`${opts.pull ? 'pull' : 'push'} ${name(f)} ${opts.distance}`);
    return orig.forced(f, opts);
  };
  wr.gainTokens = async (f, key, n, giver) => {
    log.push(`gain ${name(f)} ${key} ${n}`);
    return orig.gainTokens?.(f, key, n, giver);
  };
  wr.gainShield = async (f, v) => {
    log.push(`shield ${name(f)} ${v}`);
    return orig.gainShield(f, v);
  };
  wr.tempArmor = async (f) => {
    log.push(`tempArmor ${name(f)}`);
    return orig.tempArmor(f);
  };
  wr.challenge = async (t, c, opts) => {
    log.push(`challenge ${name(t)}`);
    return orig.challenge(t, c, opts);
  };
  wr.teleport = async (f, opts) => {
    log.push(`teleport ${name(f)} ${opts?.distance}`);
    return orig.teleport(f, opts);
  };
  wr.move = async (f, opts) => {
    log.push(`move ${name(f)} ${opts?.distance}`);
    return orig.move(f, opts);
  };
  const a = action(id);
  const foeId = String(w.foe.id);
  const ask = async (q) => {
    if (q.kind === 'confirm') return true;
    const opts = (q.options ?? []).filter((o) => o.id !== '__skip');
    if (!opts.length) return [];
    const n = Math.max(1, Math.min(q.minimum || 1, opts.length));
    // The enemy first, then the rest in order.
    const ordered = [...opts.filter((o) => String(o.id) === foeId), ...opts.filter((o) => String(o.id) !== foeId)];
    return ordered.slice(0, Math.max(n, q.maximum && q.maximum > 1 ? Math.min(q.maximum, opts.length) : n)).map((o) => o.id);
  };
  const unsupported = [];
  await runRule(
    { id: a.id, effect: a.effect },
    {
      world: wr,
      self: w.me,
      state: {},
      usage: {},
      ability: a,
      log: () => {},
      ask,
      askAs: () => ask,
      emit: async () => null,
      notify: async () => null,
      event: {},
      resolution: { gateRating: gate },
      payment: { rating: gate, poolNumbers: [gate], tokens: {} },
      history: {},
      mustTarget: null,
      onUnsupported: (node) => unsupported.push(node.op ?? 'step'),
    }
  );
  assert.deepEqual(unsupported, [], `${a.name} at ${gate}: by hand`);
  return normalize(log);
}

// Token gains as totals (one gain of 4 = two of 2), after everything else in order.
function normalize(log) {
  const gains = new Map();
  const rest = [];
  for (const l of log) {
    const m = /^gain (\S+) (\S+) (\d+)$/.exec(l);
    if (m) gains.set(`${m[1]} ${m[2]}`, (gains.get(`${m[1]} ${m[2]}`) ?? 0) + Number(m[3]));
    else rest.push(l);
  }
  return [...rest, ...[...gains].map(([k, n]) => `gain ${k} ${n}`)];
}

const cases = [
  // "Deal 1 damage to an enemy within range. 3+: Deal 2 damage instead. 5+:
  //  Deal 3 damage instead, and Push 1. 7+: Deal 4 damage instead, and Push 2
  //  instead. 9+: Deal 5 damage instead, and Push 3 instead."
  ['action.system-basic-actions.damage', 1, ['damage F3 1']],
  ['action.system-basic-actions.damage', 3, ['damage F3 2']],
  ['action.system-basic-actions.damage', 5, ['damage F3 3', 'push F3 1']],
  ['action.system-basic-actions.damage', 7, ['damage F3 4', 'push F3 2']],
  ['action.system-basic-actions.damage', 9, ['damage F3 5', 'push F3 3']],
  // "Push 1 to an adjacent enemy. 3+: Push 2 instead. 5+: Push 3 instead, and
  //  deal 1 damage to them. 7+: Push 4 instead, and deal 2 damage instead.
  //  9+: Push 5 instead, and deal 3 damage instead."
  ['action.system-basic-actions.throw', 1, ['push F3 1']],
  ['action.system-basic-actions.throw', 3, ['push F3 2']],
  ['action.system-basic-actions.throw', 5, ['push F3 3', 'damage F3 1']],
  ['action.system-basic-actions.throw', 7, ['push F3 4', 'damage F3 2']],
  ['action.system-basic-actions.throw', 9, ['push F3 5', 'damage F3 3']],
  // "Target someone within Range 1-X. Pull them 2. 4+: Pull 1 more and if they
  //  are an enemy, give them 1 Fatigue token. 7+: Pull 2 more and if they are
  //  an enemy, give them 2 Fatigue tokens." Gates add up unless they say
  //  "instead": at 7, Pull 2 + 1 + 2 and Fatigue 1 + 2.
  ['action.system-basic-actions.grapple', 2, ['pull F3 2']],
  ['action.system-basic-actions.grapple', 4, ['pull F3 2', 'pull F3 1', 'gain F3 fatigue 1']],
  ['action.system-basic-actions.grapple', 7, ['pull F3 2', 'pull F3 1', 'pull F3 2', 'gain F3 fatigue 3']],
  // "Give 2 Fatigue tokens to an adjacent enemy. 7+: Give them 2 more Fatigue
  //  tokens and 2 Weakness tokens."
  ['action.system-basic-actions.stagger', 3, ['gain F3 fatigue 2']],
  ['action.system-basic-actions.stagger', 7, ['gain F3 fatigue 4', 'gain F3 weakness 2']],
  // "Challenge an enemy within Range 1-4. 4+: Challenge up to two more enemies
  //  within Range 1-4." (Two enemies on the board.)
  ['action.system-basic-actions.a-challenger-approaches', 1, ['challenge F3']],
  ['action.system-basic-actions.a-challenger-approaches', 4, ['challenge F3', 'challenge F4']],
  // "You gain X Speed tokens."
  ['action.system-basic-actions.movement', 4, ['gain F1 speed 4']],
  // "You gain temporary Armor."
  ['action.system-basic-actions.guard', 4, ['tempArmor F1']],
  // "You gain Power tokens equal to half of X (rounded up), then you gain a
  //  Shield with a value equal to half of X (rounded down)."
  ['action.form-power.yell', 1, ['gain F1 power 1']],
  ['action.form-power.yell', 4, ['shield F1 2', 'gain F1 power 2']],
  ['action.form-power.yell', 5, ['shield F1 2', 'gain F1 power 3']],
  // "Unblockable by Abilities and Tokens. Deal 3 damage to an enemy within
  //  range. 9+: Deal 5 damage instead, and Crush is Unblockable."
  ['action.form-power.crush', 6, ['damage F3 3 unblockable:abilities+tokens']],
  ['action.form-power.crush', 9, ['damage F3 5 unblockable:all']],
  // "Teleport 2, then deal 1 damage to an enemy within range." — once more at
  //  each of 4+, 6+ and 8+.
  ['action.style-swift.deadly-dance', 2, ['teleport F1 2', 'damage F3 1']],
  ['action.style-swift.deadly-dance', 6, ['teleport F1 2', 'damage F3 1', 'teleport F1 2', 'damage F3 1', 'teleport F1 2', 'damage F3 1']],
  // "Push 1 and deal 1 damage to an adjacent enemy." (The Shield is its cost.)
  ['action.style-brawling.jab', 1, ['push F3 1', 'damage F3 1']],
  // "Deal 2 damage to an enemy within range. … 7+: Deal 2 damage to an enemy
  //  within range." (Their Weakness spent as Power: damage.test.js.)
  ['action.style-frozen.exploit-weakness', 3, ['damage F3 2']],
  ['action.style-frozen.exploit-weakness', 7, ['damage F3 2', 'damage F3 2']],
];

for (const [id, gate, expected] of cases) {
  test(`${idx.get(id)?.name ?? id} at ${gate} does what its card says`, async () => {
    const got = await perform(id, gate);
    assert.deepEqual(got, expected);
  });
}
