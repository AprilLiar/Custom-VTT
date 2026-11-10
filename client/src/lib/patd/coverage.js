// **The automation census (full automation, phase J).** Every rule of every
// Ability, every Action and every Super Move in the content is either run by
// the engine or explicitly left by hand — the engine never drops one
// silently: an Ability rule it can't run posts a "by hand" reminder
// (server/triggers.js runOne), and a step of an Action or Super Move it can't
// run is listed under "By hand:" on the Action's card (engine/actions.js).
// This module says which is which, and why, for the census test and the
// report (scripts/coverage.mjs).
import { ENFORCED_RULES } from './engine/modifiers.js';
import { ruleSupport } from './interpreter.js';

// Done by the engine itself, not by their rules (server/triggers.js ENGINE_NATIVE).
export const ENGINE_NATIVE = new Set([
  'ability.resource-mechanic-control.control-mechanics',
  'ability.resource-mechanic-chaos.chaos-mechanics',
  'ability.hero-type-frantic.frantic-versatility',
]);

// **Rules the engine runs itself, not as data (the QA pass):** each listed
// with where. Their data rule is never run by the interpreter.
export const NATIVE_RULES = new Map([
  ['ability.freestyle-mythical.mythical-freestyle.rule-1', 'server/triggers.js turnStartPool: every d12 of 3 or less is re-rolled'],
  ['ability.freestyle-persistant.persistant-freestyle.rule-2', 'server/triggers.js keepPoolNumbers: up to two numbers totalling 5 kept'],
  ['ability.archetype-the-giant.the-giant.rule-5', 'server/engine/moves.js walk: a Wall moved over becomes Rubble, +1 Fatigue'],
  ['ability.resource-mechanic-poltergeist.poltergeist-mechanics.rule-1', 'server/engine/actions.js poltergeist'],
  ['ability.resource-mechanic-luck.luck-mechanics.rule-2', 'tokenCost.js luckPlan, paid in server/engine/actions.js payTokens'],
  ['ability.feature-improved-frenzy.improved-frenzy.rule-2', 'server/triggers.js frenzy (after the dice are rolled)'],
  ['ability.feature-greater-frenzy.greater-frenzy.rule-2', 'server/triggers.js frenzy (as the turn starts)'],
]);
// **Rules the builder applies (build.js deriveBuild — the QA pass).**
export const BUILD_RULES = new Map([
  ['ability.feature-greater-focus.greater-focus.rule-1', 'the original Archetype’s Fused Ability is added'],
  ['ability.feature-greater-fusion.greater-fusion.rule-1', 'build.greaterFusionId becomes Focused'],
  ['ability.feature-improved-frenzy.improved-frenzy.rule-1', 'build.bonusFrantic'],
  ['ability.feature-greater-frenzy.greater-frenzy.rule-1', 'build.bonusFrantic'],
  ['ability.feature-improved-warrior.improved-warrior.rule-1', "build.warriorPathId (its benefit at the start of combat: server/triggers.js runFightStart)"],
  ['ability.archetype-the-machine.the-machine.rule-1', 'a Stance’s form2Id'],
  ['ability.archetype-the-machine.the-machine.rule-2', 'machineDice: no Green Action Dice'],
  ['ability.archetype-the-machine.the-machine.rule-3', 'a build warning, and no Freestyle in a Stance'],
  ['ability.archetype-the-giant.the-giant.rule-1', 'a 2×2 unit (engine/board.js cellsOf; the map draws it 2×2)'],
]);
// Super Moves the engine runs itself: Transcendant Spirit while giving Heroic Spirit.
export const NATIVE_SUPERS = new Map([['super-move.archetype-teacher.transcendant-spirit', 'server/triggers.js transcendantSpirit']]);
export const isNativeRule = (rule) => NATIVE_RULES.has(rule?.id) || BUILD_RULES.has(rule?.id);

// **Iron Form / Mountainous Freestyle's "spend 1 Iron to take 1 less damage
// from any source (even Reduced Hits)"** is done by the damage step itself
// (server/engine/hits.js), with the fighter's Iron preference (Ask / Auto /
// Never) and the Iron already spent on the hit counted — so its rule is
// never run as a rule.
export const isIronAnySource = (rule) => {
  const e = rule?.effect;
  const steps = e?.op === 'optional' ? (e.effect?.op === 'sequence' ? e.effect.steps : [e.effect]) : [];
  return (
    (rule?.events ?? []).includes('self.would_take_damage') &&
    steps.some((s) => s?.op === 'spend_tokens' && s.token === 'iron') &&
    steps.some((s) => s?.op === 'reduce_damage' && s.allowsAlreadyReduced)
  );
};
export const hasIronAnySource = (fighter, idx) => (fighter?.abilityIds ?? []).some((id) => (idx.get(id)?.rules ?? []).some(isIronAnySource));

// A continuous rule is in effect when it only installs enforced modifiers
// (and lasting Armor); anything else in it is by hand.
export function continuousSupport(rule) {
  const problems = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.op === 'sequence') return (n.steps ?? []).forEach(walk);
    if (n.op === 'grant_armor') return;
    // Mastermind Style: the Action runner hands the Action to an ally (engine/actions.js).
    if (n.op === 'delegate_actions') return;
    if (n.op === 'modify_rule') {
      if (!ENFORCED_RULES.has(n.rule)) problems.push(`rule ${n.rule}`);
      return;
    }
    if (typeof n.op === 'string') problems.push(`op ${n.op}`);
  };
  walk(rule.effect);
  return problems.length ? { ok: false, reason: problems[0] } : { ok: true };
}

// → { abilities: { triggered, continuous }, actions, supers }, each
//   { total, automatic, byHand: [{ id, rule?, reason }] }
export function census(content) {
  const tally = () => ({ total: 0, automatic: 0, byHand: [] });
  const out = { abilities: { triggered: tally(), continuous: tally() }, actions: tally(), supers: tally() };
  for (const a of content.abilities ?? []) {
    for (const r of a.rules ?? []) {
      const continuous = r.events?.includes('continuous');
      const t = continuous ? out.abilities.continuous : out.abilities.triggered;
      t.total++;
      const s = ENGINE_NATIVE.has(a.id) || isNativeRule(r) ? { ok: true } : continuous ? continuousSupport(r) : ruleSupport(r);
      if (s.ok) t.automatic++;
      else t.byHand.push({ id: a.id, rule: r.id, reason: s.reason });
    }
  }
  const asRule = (x) => ({ id: x.id, events: ['own_turn.start'], effect: x.effect });
  for (const [key, list] of [
    ['actions', content.actions ?? []],
    ['supers', content.superMoves ?? []],
  ]) {
    for (const x of list) {
      const t = out[key];
      t.total++;
      const s = NATIVE_SUPERS.has(x.id) ? { ok: true } : ruleSupport(asRule(x));
      if (s.ok) t.automatic++;
      else t.byHand.push({ id: x.id, reason: s.reason });
    }
  }
  return out;
}
