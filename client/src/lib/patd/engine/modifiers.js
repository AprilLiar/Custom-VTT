// **Passive rule modifiers (full automation, phase A).** `modify_rule` (and
// lasting `grant_armor`) in an Ability's `continuous` rules are in effect while
// their source is: constant Abilities always, a Form's or Style's while its
// Stance is active (the fighter's abilityIds already say which). Their target
// is the owner (`{ ref: 'self' }`) or a selector — an aura over allies or
// enemies in range. Temporary ones (`temporary` effects) live in the fight
// runtime until they expire.
//
// modifiersOn(fighter, world, idx, temps) → [{ rule, value, source, ownerId, node }]

import { atZero } from './turn.js';

const nodesOf = (effect) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.op === 'modify_rule' || (n.op === 'grant_armor' && !n.temporary)) out.push(n);
    if (n.op === 'sequence') return n.steps.forEach(walk);
  };
  walk(effect);
  return out;
};

// Does a modifier's target take in `fighter`, given its owner?
export function targetsFighter(target, owner, fighter, world) {
  if (!target || target.ref === 'self') return owner.id === fighter.id;
  if (typeof target.kind !== 'string') return false;
  // "You and your Copies" (Spirit Style): a Copy moves by its Original's rules.
  if (target.kind === 'self_and_own_copies') return owner.id === fighter.id;
  const sameSide = owner.side === fighter.side;
  const kindOk =
    target.kind === 'enemy' ? !sameSide : target.kind === 'ally' ? sameSide && (owner.id !== fighter.id || !target.excludeSelf) : target.kind === 'self_and_allies' ? sameSide : target.kind === 'unit';
  if (!kindOk) return false;
  if (owner.id === fighter.id) return true;
  return world ? world.inRange(owner, fighter, target.range ?? { mode: 'stance', origin: 'self' }) : true;
}

// "Their Abilities are disabled" (Synchro Breaker — phase J): a temporary
// `abilities.disabled` on them turns off their rules, continuous ones included.
export const abilitiesOff = (fighterId, temps = []) => temps.some((t) => t.rule === 'abilities.disabled' && t.targetId === fighterId && t.value !== false);

// Every modifier now in effect on `fighter`.
export function modifiersOn(fighter, world, idx, temps = []) {
  const out = [];
  for (const owner of world.fighters()) {
    if (abilitiesOff(owner.id, temps)) continue;
    // Abilities do not work while Taken Out (book p.62 — batch 5).
    if (atZero(owner.hp)) continue;
    for (const abilityId of owner.abilityIds ?? []) {
      const ability = idx.get(abilityId);
      for (const rule of ability?.rules ?? []) {
        if (!rule.events.includes('continuous')) continue;
        // **Only while its condition holds (fixed in the QA pass):** Mad Style's
        // Knife and Pistol, Fullmetal's Tracer ammo, Hidden Style in Fog, Vortex
        // Style on a Pit. The world answers (it knows the fighter's choices).
        if (rule.condition && world.ruleHolds && !world.ruleHolds(rule, owner)) continue;
        for (const node of nodesOf(rule.effect)) {
          if (!targetsFighter(node.target, owner, fighter, world)) continue;
          out.push({ rule: node.op === 'grant_armor' ? 'armor.source' : node.rule, value: node.op === 'grant_armor' ? node : node.value, source: ability.id, ownerId: owner.id, node });
        }
      }
    }
  }
  for (const t of temps) if (t.targetId === fighter.id && t.rule) out.push({ rule: t.rule, value: t.value, source: t.source, ownerId: t.ownerId, node: t.node ?? null, temporary: true });
  return out;
}

// **The rule keys the engine enforces** (grows phase by phase). A `modify_rule`
// with any other key is never silently dropped: in a triggered rule or an
// Action it makes that step "by hand" (interpreter.js).
export const ENFORCED_RULES = new Set([
  // phase A — the End Phase
  'end_phase.speed_discard',
  'end_phase.speed_discard_floor',
  // phase C — damage (engine/damage.js)
  'unblockable',
  'next_damage_action.unblockable',
  'enhance_hit.additional_uses',
  'power_tokens.additional_per_hit',
  'iron_tokens.additional_per_hit',
  'opponents.iron_token_limit_per_hit',
  'spend_target_weakness_as_own_power',
  'weakness.damage_reduction',
  'damage.immunity',
  'action_damage.adjustment',
  'armor.first_trigger_reduction',
  'armor.triggers_per_turn',
  'armor.not_spent_when_one_damage_hit_fully_blocked',
  'armor.disabled',
  'shield.disabled',
  // phase G — range, sight, movement, dice, Speed
  'range.maximum_bonus',
  'range.set',
  'range.minimum_set',
  'range.maximum_set',
  'next_action.maximum_range_bonus',
  'current_action.maximum_range_bonus',
  'sight.ignore',
  'rubble.no_fatigue',
  'free_movement.cost_per_space',
  'free_movement.disabled',
  'speed_tokens.cannot_gain_or_spend',
  'action_dice.additional',
  // phase J
  'abilities.disabled',
  // the QA pass — targeting (interpreter.js, server/triggers.js world.inRange)
  'actions.additional_targets_in_stance_range',
  'next_action.additional_legal_targets',
  'throw.target_range',
  'throw.target_selector',
  'own_challenged_enemies.always_in_range',
  // movement (engine/board.js flags set per mover by server/engine/moves.js)
  'action_movement.set',
  'movement.cannot_enter_adjacent_to_self',
  'walls.treat_as',
  'walls.may_move_over',
  'movement.all_spaces_empty',
  'movement.all_pits_adjacent',
  // tokens and costs (world.spend / spendable; tokenCost.js; engine/actions.js)
  'iron_can_pay_as',
  'allies_can_spend_own_tokens',
  'action_cost.reduction',
  'control.dodge_cost',
  'poltergeist.total_per_action',
  'weapon.disabled',
  // Copies (server/triggers.js world.damage)
  'copies.maximum_hp',
  'iron.can_reduce_hits_to_own_copies',
  // Challenge (decided: a Unique token) — server/triggers.js world.challenge / removeChallenge
  'challenge.unblockable',
  'challenge.cannot_discard',
  'own_challenges.immune_to_enemy_action_or_ability_removal',
]);

// **A fighter's range now (phase G):** their Stance's range changed by
// `range.set`, `range.minimum_set`, `range.maximum_set` ('infinite'), and the
// summed bonuses (`range.maximum_bonus`; "your next Action" and "this Action"
// bonuses too). The Stance's own construct rules are already in its range.
export function effectiveRange(base, mods, extraBonus = 0) {
  let { minimum = 1, maximum = 1 } = base ?? {};
  for (const m of modsFor(mods, 'range.set')) {
    if (m.value && typeof m.value === 'object') {
      minimum = m.value.minimum ?? minimum;
      maximum = m.value.maximum ?? maximum;
    }
  }
  for (const m of modsFor(mods, 'range.minimum_set')) minimum = Number(m.value) || 0;
  for (const m of modsFor(mods, 'range.maximum_set')) maximum = m.value === 'infinite' ? Infinity : Number(m.value) || maximum;
  maximum += sumMod(mods, 'range.maximum_bonus') + sumMod(mods, 'next_action.maximum_range_bonus') + sumMod(mods, 'current_action.maximum_range_bonus') + extraBonus;
  return { minimum, maximum };
}

// Queries over a modifier list.
export const modsFor = (mods, rule) => mods.filter((m) => m.rule === rule);
export const hasMod = (mods, rule, pred = () => true) => mods.some((m) => m.rule === rule && pred(m.value));
export const sumMod = (mods, rule) => modsFor(mods, rule).reduce((n, m) => n + (Number(m.value) || 0), 0);
// The last-installed value (temporaries after continuous), or `fallback`.
export const valueOf = (mods, rule, fallback = null) => {
  const list = modsFor(mods, rule);
  return list.length ? list[list.length - 1].value : fallback;
};
// A list-valued modifier (unblockable: ['shields', 'armor'], damage.immunity: ['fall']).
export const listMod = (mods, rule) => [...new Set(modsFor(mods, rule).flatMap((m) => (Array.isArray(m.value) ? m.value : [m.value])))];
