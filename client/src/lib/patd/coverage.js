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

// A continuous rule is in effect when it only installs enforced modifiers
// (and lasting Armor); anything else in it is by hand.
export function continuousSupport(rule) {
  const problems = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.op === 'sequence') return (n.steps ?? []).forEach(walk);
    if (n.op === 'grant_armor') return;
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
      const s = ENGINE_NATIVE.has(a.id) ? { ok: true } : continuous ? continuousSupport(r) : ruleSupport(r);
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
      const s = ruleSupport(asRule(x));
      if (s.ok) t.automatic++;
      else t.byHand.push({ id: x.id, reason: s.reason });
    }
  }
  return out;
}
