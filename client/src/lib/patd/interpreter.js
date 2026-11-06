// **The turn-trigger interpreter (builder phase 3 — decided).** Runs the
// rules content's ability rules (effect trees of `op` nodes) for a safe subset
// of operations, against a `world` the server supplies. Pure apart from what
// the world does; no `eval`, no `Function` — values are resolved by an
// explicit dispatch table and safe property traversal (import guide).
//
// What it automates (the user's choices):
//   - self effects — tokens, Shield, heal, temporary Armor, Action Pool numbers;
//   - choices — "you may" (`optional`), "choose one" (`choose`, `choose_mode`),
//     via `ask` (a prompt to whoever controls the fighter);
//   - targets — Challenge, damage, tokens on others, via `ask` with the
//     candidates the board allows (range, Walls, Fog — the world decides).
// Movement and placing, and anything else unsupported, are NOT run: a rule
// that contains any such operation, reference or selector is reported as
// `manual` before anything happens, so a rule is never applied halfway.
//
// world: {
//   fighters()                       → [fighter]  (fighter: { id, name, side, ... })
//   enemiesOf(f), alliesOf(f)        → [fighter]  (allies include f)
//   inRange(from, to, range)         → bool       range: { mode, minimum?, maximum? }
//   gainTokens(f, key, n), discardTokens(f, keys, n) → number discarded
//   heldTokens(f)                    → { key: n }
//   gainShield(f, v), heal(f, n), payHp(f, n), tempArmor(f)
//   damage(f, n, attacker, opts)     → { taken, steps, bled, absorbed, broke }
//     opts: { source, ignore, allowIron, mods, unblockable, power, emit } — the
//     whole Damage Resolution (engine/damage.js) runs in the world
//   addTemp({ rule, value, targetId, ownerId, source, duration })  (phase C)
//   challenge(target, challenger)
//   addPoolNumber(f, value)
//   context                          → { healValue, bleedValue, round, activeCharacter }
// }
// ask(request) → Promise(answer). request: { kind: 'confirm' | 'choose' | 'targets', fighter, title, text, options?, minimum?, maximum? }

import { ENFORCED_RULES } from './engine/modifiers.js';
import { addPoolValue, removePoolNumber, setPoolValue } from './diceBoard.js';

export const SUPPORTED_OPS = new Set([
  'sequence',
  'gain_tokens',
  'gain_shield',
  'heal',
  'damage',
  'pay_hp',
  'optional',
  'select',
  'challenge',
  'discard_tokens',
  'add_pool_number',
  'if',
  'switch',
  'choose',
  'choose_mode',
  'set_state',
  'set_variable',
  'for_each',
  'grant_armor',
  'distribute_distinct_basic_tokens',
  'limited',
  'trigger_warrior_path',
  'select_token',
  'steal_tokens',
  'convert_tokens',
  'notify',
  // full automation, phase C
  'modify_rule',
  'temporary',
  'spend_tokens',
  'reduce_damage',
  'split_incoming_damage',
  // full automation, phase D
  'move',
  'teleport',
  'push',
  'pull',
  'swap_spaces',
  'reduce_forced_movement',
  // full automation, phase E
  'place_obstacle',
  'destroy_obstacle',
  'replace_obstacle',
  // full automation, phase G
  'register_trigger',
  'schedule',
  'replace_token_gain',
  // full automation, phase H: the Action Pool
  'increase_pool_number',
  'set_pool_number',
  'replace_pool_number',
  'duplicate_pool_number',
  'increase_distinct_pool_numbers',
  'reroll_die',
  'reroll_dice',
  'combine_pool_numbers',
  'split_pool_number',
  'remove_lowest_action_die',
  'modify_pool_numbers',
  'roll_die',
  'perform_action',
  'repeat',
  'teleport_to',
  // phase I
  'gain_tokens_until',
  'destroy_shield',
]);
// When a `schedule` runs (engine/runtime.js runs them at those moments).
const SCHEDULE_AT = new Set(['current_turn.end', 'next_turn.start']);
// Durations a `temporary` can have (engine/runtime.js expires them).
const TEMP_DURATIONS = new Set([
  'end_of_current_turn',
  'end_of_current_turn_or_next_action',
  'end_of_that_turn',
  'after_end_of_target_next_turn',
  'start_of_next_own_turn',
  'end_of_current_round',
  'end_of_next_round',
  'until_next_damage_dealing_action',
  'current_hit',
  'end_of_fight',
]);
export const SUPPORTED_EVENTS = new Set([
  'own_turn.start',
  'own_turn.end_abilities',
  'allied_turn.start',
  'allied_turn.end_abilities',
  'any_turn.start',
  'any_turn.end_abilities',
  'enemy_turn.start',
  'enemy.turn.start',
  'self.challenge_given_to_enemy',
  'self.bleed',
  'self.damage_taken',
  'warrior_path.trigger',
  'self.tokens_discarded_by_action_or_ability',
  'self.shield_absorbed',
  'self.shield_absorbed_from_enemy_action',
  // Actions (phase B: server/engine/actions.js)
  'self.action.before',
  'self.action.cost_paid',
  'self.action.resolved',
  'self.dice_action.resolved',
  'self.damage_dealing_action.resolved',
  'self.first_action_on_own_turn.resolved',
  'self.action.damage_dealt_to_enemy',
  'ally.action.resolved',
  'any_action.fully_resolved',
  'self.token_action.pay_cost',
  'self.hp_paid',
  // Damage Resolution (phase C: engine/damage.js via server/triggers.js)
  'self.would_take_damage',
  'ally_in_range.would_take_damage',
  'self.hit_enhanced_with_power',
  'self.power_tokens_spent',
  'self.iron_tokens_spent',
  'self.hit_reduced',
  'self.hit_reduced_from_enemy',
  'self.damage_reduced_by_iron',
  'self.damage_reduced_by_armor',
  'self.armor_triggered',
  'self.damage_dealt',
  'self.damage_dealt_to_enemy',
  'self.action_or_ability.damage_dealt',
  'self.took_damage_from_action',
  'self.took_damage_from_enemy_action',
  'self.burning_token_damage_taken',
  'self.fell_to_zero_hp',
  'enemy_in_range.trap_damage_taken',
  'enemy_in_range.damaged_allied_shield',
  'enemy_in_range.broke_allied_shield',
  'enemy_in_range.own_shield_damaged',
  'enemy_in_range.own_shield_broken',
  'shield_in_range.broken',
  // Movement (phase D: server/engine/moves.js)
  'self.would_be_pushed_or_pulled',
  'enemy_in_range.action.cost_paid_before_resolution',
  'self.control_tokens_spent',
  'self.pushed',
  'self.push_finished',
  'self.movement.finished',
  'self.free_movement.one_space_finished',
  'any_movement_phase.start',
  // Modifiers, durations and the turn's phases (phase G: server/triggers.js)
  'self.gain_speed_tokens',
  'end_phase.speed_discard', // read by the End Phase as a modifier (Scrambling Style)
  'self.action_dice.rolled',
  'own_action_phase.start',
  'self.giving_heroic_spirit',
  'self.tokens_given_to_enemy',
  'self.weakness_given_to_enemy',
  'visible_enemy.gain_basic_tokens',
  'self.copy_destroyed',
  'enemy.destroyed_own_copy',
  'self.reactive_action.before',
  'stance.construct', // applied when the Stance is derived (build.js stanceRange)
  // phase H
  'self.training_token_spent',
]);
const ACTOR_OPS = new Set(['perform_action', 'swap_spaces', 'damage']);
// A selector's range measured from a target or binding (phase H).
const ORIGIN_REF = /^(targets|bindings)\.[A-Za-z]+$/;
// A rule's `limit` metrics: how often it ran, or how much it healed or gave
// this period (phase G: "a maximum of 3 HP per turn").
const LIMIT_METRICS = new Set(['activations', 'uses', 'hp_healed', 'tokens_gained']);
const SELECTOR_KINDS = new Set([
  'enemy',
  'ally',
  'unit',
  'self_and_allies',
  'self_or_ally',
  // phase E: board spaces, obstacles (Copies among them) and your own Copies
  'space',
  'obstacle',
  'own_copy',
  'enemy_or_obstacle',
  'unit_or_obstacle',
  'ally_or_obstacle',
  // phase H: numbers and dice in your own Action Pool (the pool ops pick them)
  'own_pool_number',
  'rolled_die',
  'action', // an Action to perform (perform_action)
  'self_and_visible_allies', // phase I
]);
const OBSTACLE_OPS_KINDS = new Set(['trap', 'fog', 'pit', 'rubble', 'wall', 'copy']);
// Copies aren't tracked on the board, so "you or your Copies" is your own range.
const RANGE_MODES = new Set(['stance', 'visible', 'adjacent', 'explicit', 'none', 'map', 'self_or_copies_range', 'adjacent_to_any_own_copy', 'adjacent_to_binding', 'on_or_adjacent_to_binding', 'target_and_adjacent']);
const REF_OK = [
  /^self$/,
  /^self\.bleeding$/,
  /^self\.space$/,
  /^(targets|bindings)\.[A-Za-z]+\.space$/,
  /^self\.tokens\.[a-z_]+$/,
  /^self\.currentBar\.damage$/,
  // This turn so far, and where you stand (phase G: server/triggers.js envFor).
  /^self\.(performedActionThisTurn|tookDamageThisTurn|obstaclesDestroyedThisTurn|standingOnWall)$/,
  // The numbers still in your Action Pool (phase H).
  /^self\.actionPool\.length$/,
  // What this resolution did, what paid for it, what they hold (phase H).
  /^history\.(tokensDiscarded|damageDealtToTargetByThisAction|damageTakenByEach|enemiesDamagedByThisAction|challengedByThisAction)$/,
  /^payment\.(hp|tokens\.[a-z_]+)$/,
  /^(targets|bindings)\.[A-Za-z]+\.(tokens\.[a-z_]+|statusTokenCount)$/,
  /^self\.hpLostThisTurn$/,
  // The Actions a perform_action offers (performCandidates).
  /^(self|activeCharacter|context\.activeCharacter)\.currentStance\.(gunslingerActions|uniqueActions)$/,
  /^self\.availableActions$/,
  // "Holds your Challenge": relative to whoever the rule belongs to.
  /^(targets|bindings)\.[A-Za-z]+\.holdsOwnChallenge$/,
  /^event\.(attacker|activeCharacter)\.holdsOwnChallenge$/,
  /^context\.(healValue|bleedValue|round|activeCharacter|isOwnTurn|isEnemyTurn|isAlliedTurn)$/,
  /^targets\.[A-Za-z]+$/,
  /^bindings\.[A-Za-z]+$/,
  /^variables\.[A-Za-z]+$/,
  /^state\.[A-Za-z]+$/,
  /^event\.(target|activeCharacter|attacker|amount|isCostPayment|shieldBroke|damage|enemy|enemyCount|enemyDamageDealers)$/,
  // What an Action did (phase G: server/engine/actions.js), who pushed you, what hit you.
  /^event\.(enemiesDamaged|enemiesForcedMoved|alliesForcedMoved|movedSwappedOrTeleportedSelf|source|sourceType)$/,
  /^event\.(enemiesDamaged|enemiesForcedMoved|alliesForcedMoved)\.length$/,
  /^resolution\.gateRating$/,
  /^payment\.(rating|destroyedShieldValue|challengeHolder)$/,
  /^variables\.[A-Za-z]+$/,
];
const OPERATORS = {
  add: (a) => a.reduce((x, y) => x + y, 0),
  subtract: ([a, b]) => a - b,
  multiply: (a) => a.reduce((x, y) => x * y, 1),
  divide: ([a, b]) => (b ? a / b : 0),
  floor: ([a]) => Math.floor(a),
  ceil: ([a]) => Math.ceil(a),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  eq: ([a, b]) => a === b,
  gt: ([a, b]) => a > b,
  gte: ([a, b]) => a >= b,
  lt: ([a, b]) => a < b,
  lte: ([a, b]) => a <= b,
  and: (a) => a.every(Boolean),
  not: ([a]) => !a,
  // phase G
  not_in: ([a, list]) => !(Array.isArray(list) ? list : [list]).includes(a),
  is_obstacle: ([a]) => Boolean(a?.isObstacle || a?.isCopy),
  is_enemy: () => false, // relative to the rule's owner: evalValue answers it
  is_ally: () => false, // likewise
  tier_value: ([rating, tiers]) => {
    let out = 0;
    for (const [t, v] of tiers ?? []) if (rating >= t) out = v;
    return out;
  },
};

// ------------------------------------------------------------------ support check

export class Unsupported extends Error {}

// Whether a rule can be run automatically: { ok, reason }.
export function ruleSupport(rule) {
  if (!rule?.events?.some((e) => SUPPORTED_EVENTS.has(e))) return { ok: false, reason: 'event' };
  if (rule.limit && !LIMIT_METRICS.has(rule.limit.metric)) return { ok: false, reason: `limit ${rule.limit.metric}` };
  const problems = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.op === 'string' && !SUPPORTED_OPS.has(n.op)) problems.push(`op ${n.op}`);
    if (n.op === 'grant_armor' && !n.temporary) problems.push('lasting armor');
    if (n.op === 'modify_rule' && !ENFORCED_RULES.has(n.rule)) problems.push(`rule ${n.rule}`);
    if (n.op === 'temporary' && (!TEMP_DURATIONS.has(n.duration) || !tempItems(n.effect))) problems.push(`temporary ${n.duration}`);
    if (n.op === 'schedule' && !SCHEDULE_AT.has(n.at)) problems.push(`schedule ${n.at}`);
    if (typeof n.operator === 'string' && !(n.operator in OPERATORS) && n.operator !== 'if') problems.push(`operator ${n.operator}`);
    if (typeof n.ref === 'string' && !REF_OK.some((re) => re.test(n.ref))) problems.push(`ref ${n.ref}`);
    if (typeof n.kind === 'string' && n.range && !SELECTOR_KINDS.has(n.kind)) problems.push(`selector ${n.kind}`);
    if (n.range && typeof n.range === 'object' && n.range.mode && !RANGE_MODES.has(n.range.mode)) problems.push(`range ${n.range.mode}`);
    // "Your Original" is you (a Copy's maker); a target or binding names another origin (phase H).
    if (n.range?.origin && n.range.origin !== 'self' && n.range.origin !== 'original' && !ORIGIN_REF.test(n.range.origin)) problems.push(`origin ${n.range.origin}`);
    // `originBinding` is understood by the binding ranges (phase H) only.
    if (n.inFog || n.obstacleBinding || (n.originBinding && !BINDING_RANGES.has(n.range?.mode))) problems.push('selector detail');
    if (n.op === 'place_obstacle' && !OBSTACLE_OPS_KINDS.has(n.obstacle)) problems.push(`obstacle ${n.obstacle}`);
    // Someone else doing the step: understood for performing an Action, a swap and damage (phase H).
    if (n.actor && !ACTOR_OPS.has(n.op)) problems.push('actor');
    for (const [k, v] of Object.entries(n)) if (k !== 'range') walk(v);
  };
  walk(rule.effect);
  walk(rule.condition);
  return problems.length ? { ok: false, reason: problems[0] } : { ok: true };
}

// ------------------------------------------------------------------ values

function readPath(root, parts) {
  let v = root;
  for (const p of parts) {
    if (v == null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, p)) return undefined;
    v = v[p];
  }
  return v;
}

export function evalValue(v, scope) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => evalValue(x, scope));
  if (typeof v.ref === 'string') {
    const [head, ...rest] = v.ref.split('.');
    if (!Object.prototype.hasOwnProperty.call(scope, head)) throw new Unsupported(`ref ${v.ref}`);
    // "…holds your Challenge" (phase G): their Challenger is the rule's owner.
    if (rest[rest.length - 1] === 'holdsOwnChallenge') {
      const who = readPath(scope[head], rest.slice(0, -1));
      return Boolean(who && scope.self && who.challengeId != null && String(who.challengeId) === String(scope.self.id));
    }
    return readPath(scope[head], rest);
  }
  if (typeof v.operator === 'string') {
    if (v.operator === 'if') {
      const [c, a, b] = v.args;
      return evalValue(c, scope) ? evalValue(a, scope) : evalValue(b, scope);
    }
    if (v.operator === 'is_enemy' || v.operator === 'is_ally') {
      const a = evalValue(v.args?.[0], scope);
      if (!a || !scope.self || a.side == null) return false;
      return v.operator === 'is_enemy' ? a.side !== scope.self.side : a.side === scope.self.side;
    }
    const fn = OPERATORS[v.operator];
    if (!fn) throw new Unsupported(`operator ${v.operator}`);
    return fn(v.args.map((a) => evalValue(a, scope)));
  }
  return v;
}

const STATUS = ['burning', 'fatigue', 'weakness'];
const NOT_DISCARDABLE = new Set(['shield', 'armor', 'temp_armor', 'challenge']);
const NON_UNIQUE = new Set(['power', 'iron', 'speed', 'burning', 'fatigue', 'weakness']);
const BASIC = ['power', 'iron', 'speed'];
const SKIP = '__skip';
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const isSelector = (v) => v && typeof v === 'object' && typeof v.kind === 'string' && v.range;
const tokenName = (k) => String(k).charAt(0).toUpperCase() + String(k).slice(1).replace(/_/g, ' ');

// A short human label for an effect, for choice prompts.
export function describe(node) {
  if (!node || typeof node !== 'object') return '';
  const n = (v) => (typeof v === 'number' ? v : v?.ref === 'context.healValue' ? 'the Heal Value' : '');
  switch (node.op) {
    case 'sequence':
      return node.steps.map(describe).filter(Boolean).join(', then ');
    case 'gain_tokens':
      return `gain ${n(node.amount)} ${typeof node.token === 'string' ? tokenName(node.token) : 'tokens'}`.replace('  ', ' ');
    case 'gain_shield':
      return `gain Shield ${n(node.value)}`;
    case 'heal':
      return `heal ${n(node.amount)}`.trim();
    case 'damage':
      return `deal ${n(node.amount)} damage`;
    case 'challenge':
      return 'Challenge an enemy';
    case 'add_pool_number':
      return `add a ${n(node.value)} to the Action Pool`;
    case 'discard_tokens':
      return `discard ${n(node.amount)} token${node.amount === 1 ? '' : 's'}`;
    case 'optional':
      return `may ${describe(node.effect)}`;
    case 'steal_tokens':
      return 'steal the token';
    case 'convert_tokens':
      return `convert it into ${tokenName(node.to ?? 'iron')}`;
    case 'select_token':
      return 'pick a token';
    case 'notify':
      return 'a note in the chat';
    case 'move':
      return `move ${node.upTo ? 'up to ' : ''}${n(node.distance)}`.replace('  ', ' ');
    case 'teleport':
      return `teleport ${n(node.distance)}`.trim();
    case 'push':
    case 'pull':
      return `${node.op} ${node.upTo ? 'up to ' : ''}${n(node.distance)}`.replace('  ', ' ').trim();
    case 'swap_spaces':
      return 'swap spaces';
    default:
      return node.op?.replace(/_/g, ' ') ?? '';
  }
}

// ------------------------------------------------------------------ running

// Runs one rule's effect. ctx: { world, ask, self, event, ability, state, usage, log, emit }
//   state — this fighter's persistent choices for the fight (Song, Mood, ...)
//   usage — counters for `limited` / rule limits
//   log(line) — what happened, for the chat card
//   emit(event, fighter, payload) — follow-on events the engine runs (Bleed, ...)
// Actions add (full automation, phase B):
//   resolution — { gateRating } (the Gate the Action resolves to)
//   payment    — { rating, poolNumbers, tokens, hp, destroyedShieldValue, challengeHolder }
//   history    — what this resolution did (damage dealt, Challenged enemies …)
//   mustTarget — the Challenger a damaging Action must include (decided: enforced)
//   onUnsupported(node) — a step the engine can't run yet
export async function runRule(rule, ctx) {
  const scope = {
    self: ctx.self,
    // The fight's context, and whether it is the rule's owner's own turn.
    context: {
      ...ctx.world.context,
      isOwnTurn: ctx.world.context?.activeCharacter != null && ctx.world.context.activeCharacter.id === ctx.self?.id,
      isEnemyTurn: ctx.world.context?.activeCharacter != null && ctx.world.context.activeCharacter.side !== ctx.self?.side,
      isAlliedTurn: ctx.world.context?.activeCharacter != null && ctx.world.context.activeCharacter.side === ctx.self?.side && ctx.world.context.activeCharacter.id !== ctx.self?.id,
    },
    targets: {},
    bindings: {},
    variables: { ...(ctx.variables ?? {}) },
    state: ctx.state,
    event: ctx.event ?? {},
    resolution: ctx.resolution ?? {},
    payment: ctx.payment ?? {},
    history: ctx.history ?? {},
    // Rules changed for this resolution only (`modify_rule` run as an effect).
    mods: [...(ctx.mods ?? [])],
  };
  // A scheduled effect runs with what it captured (phase G).
  if (ctx.captured) Object.assign(scope.targets, ctx.captured.targets ?? {}), Object.assign(scope.bindings, ctx.captured.bindings ?? {}), Object.assign(scope.variables, ctx.captured.variables ?? {});
  if (rule.condition && !evalValue(rule.condition, scope)) return { ran: false };
  if (rule.limit) {
    // "Per Action" counts within that one Action (`ctx.actionSeq`).
    const key = `${rule.id}:${ctx.self.id}:${rule.limit.period}${rule.limit.period === 'action' ? `#${ctx.actionSeq ?? 0}` : ''}`;
    const max = Number(evalValue(rule.limit.maximum, scope)) || 0;
    if ((ctx.usage[key] ?? 0) >= max) return { ran: false };
    // HP healed / tokens gained: the heal or gain itself is cut to what's left.
    if (['activations', 'uses'].includes(rule.limit.metric ?? 'activations')) ctx.usage[key] = (ctx.usage[key] ?? 0) + 1;
    else scope.cap = { metric: rule.limit.metric, key, max };
  }
  // **A "you may" rule (`optional` on the rule).** When it opens by picking
  // something (a token to discard or take), the pick itself offers "skip" and
  // a rule with nothing to pick is skipped without asking. Otherwise it asks.
  if (rule.optional && rule.effect?.op !== 'optional') {
    if (!affordable(rule.effect, scope, ctx)) return { ran: false };
    if (opensWithPick(rule.effect)) scope.mayDecline = true;
    else {
      const yes = await ctx.ask({ kind: 'confirm', fighter: ctx.self, title: ctx.ability?.name ?? 'Optional', text: `You may ${describe(rule.effect) || 'use this'}.` });
      if (!yes) return { ran: false };
    }
  }
  const out = await run(rule.effect, scope, ctx);
  return { ran: out !== DECLINED };
}

// A `temporary`'s effect as the modifiers it installs (`modify_rule` with an
// enforced key, temporary `grant_armor`), or null when it holds anything else.
export function tempItems(effect) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return false;
    if (n.op === 'sequence') return (n.steps ?? []).every(walk);
    if (n.op === 'modify_rule' && ENFORCED_RULES.has(n.rule)) return out.push(n) > 0;
    if (n.op === 'grant_armor' || n.op === 'register_trigger') return out.push(n) > 0;
    return false;
  };
  return walk(effect) ? out : null;
}

// A "you may" whose effect opens by spending tokens is only offered when they
// can be spent (Iron Form: "you may spend 1 Iron to take 1 less damage").
function affordable(effect, scope, ctx) {
  const first = effect?.op === 'sequence' ? effect.steps?.[0] : effect;
  if (first?.op !== 'spend_tokens') return true;
  const who = first.target?.ref === 'self' || !first.target ? [scope.self] : asList(evalValue(first.target, scope));
  return who.every((f) => f && (ctx.world.heldTokens(f)[evalValue(first.token, scope)] ?? 0) >= (Number(evalValue(first.amount, scope)) || 0));
}

// What a delayed effect keeps of its scope: fighters by id, squares as they are.
function capture(scope) {
  // Fighters and Copies by id (they are live objects); squares and obstacles as data.
  const keep = (v) => (Array.isArray(v) ? v.map(keep) : v && typeof v === 'object' && v.id != null && (v.side != null || v.isCopy) ? { ref: v.id } : v);
  const each = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, keep(v)]));
  return { targets: each(scope.targets), bindings: each(scope.bindings), variables: each(scope.variables) };
}

// An amount cut to what a rule's HP-healed / tokens-gained limit still allows,
// counted against it (a heal counts what it really healed: `later`).
function capped(scope, ctx, metric, amount, later = false) {
  const cap = scope.cap;
  if (cap?.metric !== metric) return amount;
  const n = Math.max(0, Math.min(Number(amount) || 0, cap.max - (ctx.usage[cap.key] ?? 0)));
  if (!later) ctx.usage[cap.key] = (ctx.usage[cap.key] ?? 0) + n;
  return n;
}

// ---- the Action Pool (phase H)
// "You may …" on the rule: the pick itself offers the skip (taken once).
const takeDecline = (scope) => {
  const d = Boolean(scope.mayDecline);
  scope.mayDecline = false;
  return d;
};
const poolLabel = (p) => (p.die ? `${p.value} (d${p.die}${p.bonus ? ', bonus' : ''})` : p.added ? `${p.value} (added)` : `${p.value}`);
// One number of `owner`'s live pool, picked by the rule's owner (one choice needs no asking).
async function pickPool(scope, ctx, owner, { filter = () => true, text, decline = false }) {
  const pool = (ctx.world.pool?.(owner) ?? []).filter(filter);
  if (!pool.length) return null;
  if (pool.length === 1 && !decline) return pool[0];
  const options = pool.map((p) => ({ id: String(p.index), label: poolLabel(p) }));
  if (decline) options.push({ id: SKIP, label: 'Skip' });
  const ans = await ctx.ask({ kind: 'choose', fighter: scope.self, title: ctx.ability?.name ?? 'Action Pool', text, options, minimum: 1, maximum: 1 });
  const id = String(asList(ans)[0] ?? '');
  if (id === SKIP) return null;
  return pool.find((p) => String(p.index) === id) ?? (decline ? null : pool[0]);
}
async function chooseInteger(scope, ctx, spec, text) {
  const lo = Number(spec?.minimum) || 1;
  const hi = Number(spec?.maximum) || 9;
  const options = Array.from({ length: hi - lo + 1 }, (_, i) => ({ id: String(lo + i), label: String(lo + i) }));
  const ans = await ctx.ask({ kind: 'choose', fighter: scope.self, title: ctx.ability?.name ?? 'Choose a number', text, options, minimum: 1, maximum: 1 });
  const v = Number(asList(ans)[0]);
  return Number.isFinite(v) && v >= lo && v <= hi ? v : hi;
}
const rollDie = (ctx, sides) => 1 + Math.floor((ctx.random ?? Math.random)() * sides);

// The Actions a `perform_action` offers (phase H), or null when its selector is unknown.
//   ref …currentStance.gunslingerActions — Gunkata
//   ref …currentStance.uniqueActions — the Teacher's (the active character's)
//   ref …availableActions — any of the actor's
//   { kind: 'action', diceAction, unique, availableInCurrentStanceOfAnyUnit,
//     excludeSelfAction, notSelectedByThisActionThisTurn } — the Elder's, A Warrior's Death
function performCandidates(sel, scope, ctx, actor) {
  const world = ctx.world;
  if (typeof sel?.ref === 'string') {
    const owner = /^(context\.)?activeCharacter\./.test(sel.ref) ? scope.context.activeCharacter : actor;
    if (!owner) return [];
    if (/currentStance\.gunslingerActions$/.test(sel.ref)) return world.actionsFor(owner, { gunslinger: true });
    if (/currentStance\.uniqueActions$/.test(sel.ref)) return world.actionsFor(owner, { unique: true });
    if (/availableActions$/.test(sel.ref)) return world.actionsFor(owner, {});
    return null;
  }
  if (sel?.kind !== 'action') return null;
  const owners = sel.availableInCurrentStanceOfAnyUnit ? world.fighters() : [actor];
  const seen = new Map();
  for (const o of owners) for (const a of world.actionsFor(o, { unique: Boolean(sel.unique), dice: Boolean(sel.diceAction) })) seen.set(a.id, a);
  let list = [...seen.values()];
  if (sel.excludeSelfAction) list = list.filter((a) => a.id !== ctx.ability?.id);
  if (sel.notSelectedByThisActionThisTurn) {
    const picked = ctx.usage[`picked:${ctx.ability?.id}:${scope.self.id}:turn`] ?? [];
    list = list.filter((a) => !picked.includes(a.id));
  }
  return list;
}

const DECLINED = Symbol('declined');
// A "you may" opening with a pick offers its own skip (phase D: a square too).
const PICK_OPS = new Set([
  'discard_tokens',
  'select_token',
  'move',
  'teleport',
  'place_obstacle',
  // phase H: a number or die of the Action Pool
  'increase_pool_number',
  'set_pool_number',
  'replace_pool_number',
  'duplicate_pool_number',
  'reroll_die',
  'reroll_dice',
  'combine_pool_numbers',
  'split_pool_number',
  'teleport_to',
]);
const opensWithPick = (e) => PICK_OPS.has(e?.op) || (e?.op === 'sequence' && PICK_OPS.has(e.steps?.[0]?.op));
const firstOp = (e) => (e?.op === 'sequence' ? e.steps?.[0]?.op : e?.op);
// An `optional` step opening with one of these asks no yes/no first (phase H).
const POOL_PICKS = new Set(['increase_pool_number', 'set_pool_number', 'replace_pool_number', 'duplicate_pool_number', 'reroll_die', 'reroll_dice', 'combine_pool_numbers', 'split_pool_number']);

async function targetsOf(v, scope, ctx, label) {
  if (isSelector(v)) return select(v, scope, ctx, label);
  return asList(evalValue(v, scope)).filter((x) => x && typeof x === 'object' && x.id != null);
}

// **Spaces (phase E):** squares in range — `empty` ones only when asked —
// picked one at a time on the map or lane (`square` prompts).
async function selectSpaces(sel, scope, ctx, from, { optional = false } = {}) {
  const { world } = ctx;
  if (!world.spaces) throw new Unsupported('spaces');
  // "A space adjacent to the target" (phase H): measured from the bound one.
  let pool = BINDING_RANGES.has(sel.range?.mode)
    ? world.spaces(from, { mode: 'map' }, { empty: Boolean(sel.empty) }).filter((sq) => nearAnchor(sel, anchorOf(sel, scope), sq))
    : world.spaces(from, sel.range, { empty: Boolean(sel.empty) });
  const count = sel.count;
  if (count === 'all') return pool;
  const maximum = typeof count === 'number' ? count : typeof count === 'object' && count?.maximum != null ? evalValue(count.maximum, scope) : 1;
  const upTo = optional || (typeof count === 'object' && count?.maximum != null);
  const picked = [];
  for (let i = 0; i < maximum && pool.length; i++) {
    // One legal space and no choice to skip: no need to ask.
    if (pool.length === 1 && !upTo && maximum === 1) {
      picked.push(pool[0]);
      break;
    }
    const ans = await ctx.ask({
      kind: 'square',
      mode: world.mode,
      fighter: scope.self,
      title: ctx.ability?.name ?? 'Pick a space',
      text: maximum > 1 ? `Pick a space (${i + 1} of ${upTo ? 'up to ' : ''}${maximum}).` : 'Pick a space.',
      options: pool.map((sq) => ({ id: `${sq.col},${sq.row}`, label: `${sq.col},${sq.row}`, col: sq.col, row: sq.row })),
      minimum: upTo ? 0 : 1,
      maximum: 1,
    });
    const id = asList(ans)[0];
    const sq = pool.find((x) => `${x.col},${x.row}` === id) ?? (upTo ? null : pool[0]);
    if (!sq) break;
    picked.push(sq);
    pool = pool.filter((x) => x !== sq);
  }
  return picked;
}

// **Ranges measured from a bound thing (phase H):** "a space adjacent to the
// target", "enemies on or adjacent to the Trap" — `originBinding` names it
// (a target, a binding, or a ref such as `event.target`).
// `target_and_adjacent` (Lead Rain): the target itself and everyone next to it.
const BINDING_RANGES = new Set(['adjacent_to_binding', 'on_or_adjacent_to_binding', 'target_and_adjacent']);
function anchorOf(sel, scope) {
  const b = sel.originBinding;
  if (typeof b !== 'string') return null;
  if (b.includes('.')) return asList(evalValue({ ref: b }, scope))[0] ?? null;
  return asList(scope.targets[b] ?? scope.bindings[b])[0] ?? null;
}
function nearAnchor(sel, anchor, sq) {
  const at = anchor?.square ?? (Number.isInteger(anchor?.col) ? anchor : null);
  if (!at || !sq) return false;
  const d = chebyshev(at, sq);
  return sel.range.mode === 'adjacent_to_binding' ? d === 1 : d <= 1;
}

// The candidates a selector allows, and the pick when one is needed.
async function select(sel, scope, ctx, label = 'a target') {
  const { world } = ctx;
  const self = scope.self;
  // Acting from one of your Copies (phase E): ranges count from its square;
  // "this Action's maximum range +X" (phase G) rides along.
  const bonus = (scope.mods ?? []).filter((m) => m.targetId === self.id && m.rule === 'current_action.maximum_range_bonus').reduce((n, m) => n + (Number(m.value) || 0), 0);
  let from = ctx.originSquare || bonus ? { ...self, square: ctx.originSquare ?? self.square, rangeBonus: bonus } : self;
  // "Within range of that ally / of the Copy / of the obstacle" (phase H): a
  // fighter or Copy measures with its own range, an obstacle with yours.
  if (ORIGIN_REF.test(sel.range?.origin ?? '')) {
    const o = asList(evalValue({ ref: sel.range.origin }, scope))[0];
    if (!o?.square) return [];
    from = o.side != null ? o : { ...self, square: o.square };
  }
  if (sel.kind === 'space') return selectSpaces(sel, scope, ctx, from);
  const copies = world.copies?.() ?? [];
  // "Adjacent to the target" (phase H): from the bound one, not from you.
  const bound = BINDING_RANGES.has(sel.range?.mode);
  const obstacleRange = bound ? { mode: 'map' } : sel.range;
  let pool;
  if (sel.kind === 'enemy') pool = [...world.enemiesOf(self), ...copies.filter((c) => c.side !== self.side)];
  else if (sel.kind === 'ally' || sel.kind === 'self_and_allies' || sel.kind === 'self_or_ally') pool = world.alliesOf(self);
  // "Yourself and each ally you can see" (Inspire Perfection — phase I).
  else if (sel.kind === 'self_and_visible_allies') pool = world.alliesOf(self).filter((f) => f.id === self.id || world.inRange(from, f, { mode: 'visible', origin: 'self' }));
  else if (sel.kind === 'own_copy') pool = copies.filter((c) => c.ownerId === self.id);
  else if (sel.kind === 'obstacle') pool = world.obstacles?.(from, obstacleRange, { types: sel.types ?? null }) ?? [];
  else if (sel.kind.endsWith('_or_obstacle')) {
    const units = sel.kind === 'enemy_or_obstacle' ? world.enemiesOf(self) : sel.kind === 'ally_or_obstacle' ? world.alliesOf(self) : world.fighters();
    pool = [...units, ...(world.obstacles?.(from, obstacleRange, {}) ?? [])];
  } else pool = [...world.fighters(), ...copies];
  if (sel.excludeSelf) pool = pool.filter((f) => f.id !== self.id);
  // Dodged with Control (phase F): immune to this Action.
  if (ctx.immuneIds?.length) pool = pool.filter((f) => !ctx.immuneIds.includes(f.id));
  if (bound) {
    const anchor = anchorOf(sel, scope);
    pool = pool.filter((f) => (f !== anchor || sel.range.mode === 'target_and_adjacent') && nearAnchor(sel, anchor, f.square));
  } else pool = pool.filter((f) => f.isObstacle || (f.isCopy && sel.range?.mode === 'none') || world.inRange(from, f, sel.range));
  const count = sel.count;
  if (count === 'all' || sel.kind === 'self_and_allies' || sel.kind === 'self_and_visible_allies') return pool;
  if (!pool.length) return [];
  const maximum = typeof count === 'number' ? count : typeof count === 'object' && count?.maximum != null ? evalValue(count.maximum, scope) : 1;
  const minimum = typeof count === 'object' && count?.maximum != null ? 0 : Math.min(1, pool.length);
  // **Challenge (decided: enforced).** A damaging Action must include the
  // Challenger whenever they are a legal target: the only choice for a single
  // target, and a required pick among several.
  const must = ctx.mustTarget != null && (sel.kind === 'enemy' || sel.kind === 'unit') ? pool.find((f) => f.id === ctx.mustTarget) : null;
  if (must && maximum === 1) {
    ctx.log?.(`${must.name} must be the target (Challenge)`);
    return [must];
  }
  const answer = await ctx.ask({
    kind: 'targets',
    fighter: self,
    title: ctx.ability?.name ?? 'Choose',
    text: `Choose ${maximum === 1 ? label : `up to ${maximum}`}${must ? ` — ${must.name} must be one (Challenge)` : ''}.`,
    options: pool.map((f) => ({ id: String(f.id), label: f.isObstacle || f.isCopy ? `${f.name} (${f.square.col},${f.square.row})` : f.name })),
    minimum: Math.max(minimum, must ? 1 : 0),
    maximum,
    required: must ? [String(must.id)] : [],
  });
  const ids = new Set(asList(answer).map(String));
  if (must) ids.add(String(must.id));
  const picked = pool.filter((f) => ids.has(String(f.id))).slice(0, maximum);
  return picked.length || minimum === 0 ? picked : pool.slice(0, 1);
}

async function run(node, scope, ctx) {
  if (!node || typeof node !== 'object') return;
  const { world } = ctx;
  const val = (v) => evalValue(v, scope);
  switch (node.op) {
    case 'sequence':
      for (const s of node.steps) if ((await run(s, scope, ctx)) === DECLINED) return DECLINED;
      return;
    case 'if':
      if (val(node.condition)) await run(node.then, scope, ctx);
      else if (node.else) await run(node.else, scope, ctx);
      return;
    case 'switch': {
      const m = val(node.match);
      const c = (node.cases ?? []).find((x) => x.value === m || x.when === m) ?? (node.cases ?? []).find((x) => x.default);
      if (c) await run(c.effect, scope, ctx);
      return;
    }
    case 'optional': {
      if (!affordable(node.effect, scope, ctx)) return;
      // "You may combine two of your numbers": the pick offers the skip (phase H).
      if (opensWithPick(node.effect) && POOL_PICKS.has(firstOp(node.effect))) {
        scope.mayDecline = true;
        const out = await run(node.effect, scope, ctx);
        scope.mayDecline = false;
        return out === DECLINED ? undefined : out;
      }
      const yes = await ctx.ask({
        kind: 'confirm',
        fighter: scope.self,
        title: ctx.ability?.name ?? 'Optional',
        text: `You may ${describe(node.effect) || 'use this'}.`,
      });
      if (yes) await run(node.effect, scope, ctx);
      return;
    }
    case 'choose': {
      const options = node.options.map((o, i) => ({ id: o.id, label: describe(o.effect) || `Option ${i + 1}` }));
      const ans = await ctx.ask({ kind: 'choose', fighter: scope.self, title: ctx.ability?.name ?? 'Choose', text: (node.maximum ?? 1) > 1 ? `Choose ${node.minimum ?? 1}–${node.maximum}.` : 'Choose one.', options, minimum: node.minimum ?? 1, maximum: node.maximum ?? 1 });
      const ids = asList(ans).map(String);
      for (const o of node.options) if (ids.includes(o.id)) await run(o.effect, scope, ctx);
      return;
    }
    case 'choose_mode': {
      const options = asList(val(node.options)).map((o) => ({ id: String(o), label: tokenName(o) }));
      const ans = await ctx.ask({ kind: 'choose', fighter: scope.self, title: ctx.ability?.name ?? 'Choose', text: `Choose your ${tokenName(val(node.stateKey))}.`, options, minimum: 1, maximum: 1 });
      const picked = asList(ans)[0] ?? options[0]?.id;
      scope.state[val(node.stateKey)] = picked;
      ctx.log(`chose ${tokenName(picked)}`);
      return;
    }
    case 'set_state':
      scope.state[val(node.key)] = val(node.value);
      return;
    case 'set_variable':
      scope.variables[val(node.name)] = val(node.value);
      return;
    case 'select':
      scope.targets[node.binding] = await select(node.selector, scope, ctx, node.selector.kind === 'ally' ? 'an ally' : 'an enemy');
      if (Array.isArray(scope.targets[node.binding]) && node.selector.count === 1) scope.targets[node.binding] = scope.targets[node.binding][0] ?? null;
      return;
    case 'for_each': {
      // A selector to pick from, or a ref to a list (Knockdown's damagers, Dance's pushed enemies).
      const list = await targetsOf(node.selector, scope, ctx);
      for (const f of list) {
        scope.bindings[node.binding] = f;
        // "Any target that takes 0 damage from it" (Grape Shot — phase H).
        scope.history.damageTakenByEach = scope.history.damageByTarget?.[f.id] ?? 0;
        await run(node.effect, scope, ctx);
      }
      return;
    }
    case 'limited': {
      const key = `limited:${ctx.ability?.id}:${scope.self.id}:${node.period}`;
      if ((ctx.usage[key] ?? 0) >= val(node.maximum)) return;
      ctx.usage[key] = (ctx.usage[key] ?? 0) + 1;
      await run(node.effect, scope, ctx);
      return;
    }
    case 'gain_tokens': {
      const key = val(node.token);
      const amount = val(node.amount);
      if (typeof key !== 'string' || !(amount > 0)) return;
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const n = capped(scope, ctx, 'tokens_gained', amount);
        if (!(n > 0)) continue;
        // Who gave them (phase G: "after you give tokens to an enemy").
        await world.gainTokens(f, key, n, scope.self);
        ctx.log(`${f.name} gains ${n} ${tokenName(key)}`);
      }
      return;
    }
    // "Discards all Shields they hold" (Lucky Hit — phase I).
    case 'destroy_shield': {
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const s = world.heldTokens(f).shield ?? 0;
        if (!s) continue;
        await world.discardTokens(f, ['shield'], s);
        ctx.log(`${f.name}'s Shield is destroyed`);
      }
      return;
    }
    // "Give them Burning tokens until they hold 6" (Super Moves — phase I).
    case 'gain_tokens_until': {
      const key = val(node.token);
      const total = Number(val(node.total)) || 0;
      if (typeof key !== 'string') return;
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const n = Math.max(0, total - (world.heldTokens(f)[key] ?? 0));
        if (!n) continue;
        await world.gainTokens(f, key, n, scope.self);
        ctx.log(`${f.name} gains ${n} ${tokenName(key)} (now ${total})`);
      }
      return;
    }
    case 'distribute_distinct_basic_tokens': {
      let types = [...val(node.types)];
      for (const amount of val(node.amounts)) {
        let pick = types[0];
        if (types.length > 1) {
          const ans = await ctx.ask({
            kind: 'choose',
            fighter: scope.self,
            title: ctx.ability?.name ?? 'Tokens',
            text: `Gain ${amount} of which?`,
            options: types.map((t) => ({ id: t, label: tokenName(t) })),
            minimum: 1,
            maximum: 1,
          });
          pick = types.includes(asList(ans)[0]) ? asList(ans)[0] : types[0];
        }
        types = types.filter((t) => t !== pick);
        await world.gainTokens(scope.self, pick, amount);
        ctx.log(`${scope.self.name} gains ${amount} ${tokenName(pick)}`);
      }
      return;
    }
    case 'discard_tokens': {
      const amount = val(node.amount);
      const decline = scope.mayDecline;
      scope.mayDecline = false;
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const held = world.heldTokens(f);
        const filter = val(node.tokenFilter);
        // Shield, Armor and Challenge are never "tokens you hold" to discard here.
        // Kinds (phase I): Status, Basic (Power, Iron, Speed), Unique, non-Unique, one key, any.
        const kindOk = (k) =>
          filter === 'status' ? STATUS.includes(k) : filter === 'basic' ? BASIC.includes(k) : filter === 'unique' ? !NON_UNIQUE.has(k) : filter === 'non_unique' ? NON_UNIQUE.has(k) : filter === 'any' || filter == null || k === filter;
        let keys = Object.keys(held).filter((k) => held[k] > 0 && !NOT_DISCARDABLE.has(k) && kindOk(k));
        if (!keys.length) {
          if (decline) return DECLINED;
          continue;
        }
        const total = keys.reduce((n, k) => n + held[k], 0);
        // "Discards all Basic tokens they hold" (Lucky Hit).
        if (amount === 'all') {
          await world.discardTokens(f, keys, total);
          scope.history.tokensDiscarded = (scope.history.tokensDiscarded ?? 0) + total;
          ctx.log(`${f.name} discards ${total} token${total === 1 ? '' : 's'}`);
          await ctx.emit?.('self.tokens_discarded_by_action_or_ability', f, { amount: total, isCostPayment: false });
          continue;
        }
        if (decline || (keys.length > 1 && amount < total)) {
          const options = keys.map((k) => ({ id: k, label: `${tokenName(k)} (${held[k]})` }));
          if (decline) options.push({ id: SKIP, label: "Don't discard" });
          const ans = await ctx.ask({
            kind: 'choose',
            fighter: scope.self,
            title: ctx.ability?.name ?? 'Discard',
            text: `${decline ? 'You may discard' : 'Discard'} ${amount === 1 ? 'one token' : `up to ${amount}`}: which ${amount === 1 ? '' : 'first'}?`.replace(/ \?$/, '?'),
            options,
            minimum: 1,
            maximum: 1,
          });
          const first = asList(ans)[0];
          if (decline && (first == null || first === SKIP)) return DECLINED;
          if (keys.includes(first)) keys = [first, ...keys.filter((k) => k !== first)];
        }
        const n = await world.discardTokens(f, keys, amount);
        // "For each token they discarded" (Hunger — phase H).
        scope.history.tokensDiscarded = (scope.history.tokensDiscarded ?? 0) + (Number(n) || 0);
        if (n) {
          ctx.log(`${f.name} discards ${n} token${n === 1 ? '' : 's'}`);
          await ctx.emit?.('self.tokens_discarded_by_action_or_ability', f, { amount: n, isCostPayment: false });
        }
      }
      return;
    }
    // **Trickster (decided: automated).** Pick one non-Unique token held by
    // someone in range; later steps steal or convert it (`targets.<binding>`
    // is { holder, key }).
    case 'select_token': {
      const decline = scope.mayDecline;
      scope.mayDecline = false;
      const pool = world.fighters().filter((f) => f.id !== scope.self.id && world.inRange(scope.self, f, node.holder?.range));
      const options = [];
      for (const f of pool) {
        const held = world.heldTokens(f);
        for (const k of Object.keys(held)) {
          if (!(held[k] > 0) || NOT_DISCARDABLE.has(k)) continue;
          if (val(node.tokenFilter) === 'non_unique' && !NON_UNIQUE.has(k)) continue;
          options.push({ id: `${f.id}:${k}`, label: `${f.name}: ${tokenName(k)} (${held[k]})`, holder: f, key: k });
        }
      }
      if (!options.length) return decline ? DECLINED : undefined;
      const choices = options.map(({ id, label }) => ({ id, label }));
      if (decline) choices.push({ id: SKIP, label: 'Skip' });
      const ans = asList(
        await ctx.ask({ kind: 'choose', fighter: scope.self, title: ctx.ability?.name ?? 'Pick a token', text: `${decline ? 'You may pick' : 'Pick'} a token held by someone in range.`, options: choices, minimum: 1, maximum: 1 })
      )[0];
      const pick = options.find((o) => o.id === ans);
      if (!pick) return decline ? DECLINED : undefined;
      scope.targets[node.binding] = { holder: pick.holder, key: pick.key };
      return;
    }
    case 'steal_tokens': {
      const t = val(node.target);
      const to = asList(val(node.recipient))[0] ?? scope.self;
      if (!t?.holder || !t.key) return;
      if (!(await world.discardTokens(t.holder, [t.key], 1))) return;
      await world.gainTokens(to, t.key, 1);
      ctx.log(`${to.name} steals 1 ${tokenName(t.key)} from ${t.holder.name}`);
      scope.targets = Object.fromEntries(Object.entries(scope.targets).map(([k, v]) => [k, v === t ? { holder: to, key: t.key } : v]));
      return;
    }
    case 'convert_tokens': {
      const t = val(node.target);
      const into = val(node.to) ?? 'iron';
      if (!t?.holder || !t.key) return;
      if (!(await world.discardTokens(t.holder, [t.key], 1))) return;
      await world.gainTokens(t.holder, into, 1);
      ctx.log(`${t.holder.name}'s ${tokenName(t.key)} becomes ${tokenName(into)}`);
      t.key = into;
      return;
    }
    case 'gain_shield': {
      const v = val(node.value);
      for (const f of await targetsOf(node.target, scope, ctx)) {
        await world.gainShield(f, v);
        ctx.log(`${f.name} gains Shield ${v}`);
      }
      return;
    }
    case 'heal': {
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const n = capped(scope, ctx, 'hp_healed', val(node.amount), true);
        if (!(n > 0)) continue;
        const healed = await world.heal(f, n);
        if (scope.cap?.metric === 'hp_healed') ctx.usage[scope.cap.key] = (ctx.usage[scope.cap.key] ?? 0) + (Number(healed ?? n) || 0);
        ctx.log(`${f.name} heals ${healed ?? n}`);
      }
      return;
    }
    case 'pay_hp': {
      const n = val(node.amount);
      for (const f of await targetsOf(node.target, scope, ctx)) {
        await world.payHp(f, n);
        ctx.log(`${f.name} pays ${n} HP`);
      }
      return;
    }
    // **Damage (phase C):** the world runs the whole Damage Resolution
    // (engine/damage.js — Weakness, Power, Iron, Shield, Armor) and emits its
    // events; this step only says who hits whom, from what, and how.
    case 'damage': {
      const n = val(node.amount);
      for (const f of await targetsOf(node.target, scope, ctx, 'an enemy')) {
        // A Wall or Rubble hit for 2+ in one hit is destroyed (book p.11; phase E).
        if (f.isObstacle && !f.isCopy) {
          if (n >= 2 && (f.kind === 'wall' || f.kind === 'rubble')) {
            await world.destroyObstacle(f, scope.self);
            ctx.log(`${scope.self.name} destroys the ${f.name}${f.kind === 'wall' ? ' (Rubble now)' : ''}`);
          }
          continue;
        }
        // Dealt by someone else when the step says so (Slugfest's target hits back — phase H).
        const attacker = node.actor ? (asList(val(node.actor))[0] ?? scope.self) : scope.self;
        const r = await world.damage(f, n, attacker, {
          source: ctx.source ?? 'ability',
          ignore: node.ignoreDefenses ?? null,
          allowIron: Boolean(node.allowIronTokens),
          mods: scope.mods ?? [],
          unblockable: ctx.unblockable ?? [],
          power: ctx.power ?? null,
          emit: ctx.emit ?? null,
        });
        const taken = r?.taken ?? r?.toHp ?? n;
        const steps = r?.steps?.length ? r.steps : r?.absorbed ? [`Shield absorbs ${r.absorbed}${r.broke ? ' and breaks' : ''}`] : [];
        ctx.log(`${attacker.name} deals ${taken} damage to ${f.name}${steps.length ? ` (${steps.join(', ')})` : ''}`);
        // What this resolution did (history.*): damage actually dealt, who was hit
        // (an attempt counts for the Challenge, even when it was all blocked).
        scope.history.damageDealt = (scope.history.damageDealt ?? 0) + taken;
        (scope.history.damagedIds ??= []).push(f.id);
        if (taken > 0 && f.side !== scope.self.side) (scope.history.enemyDamagedIds ??= []).push(f.id);
        // Per target, and the enemies it damaged as fighters (phase H: Burning
        // Fist, Grape Shot, Icicle Fall).
        const byTarget = (scope.history.damageByTarget ??= {});
        byTarget[f.id] = (byTarget[f.id] ?? 0) + taken;
        scope.history.damageDealtToTargetByThisAction = byTarget[scope.targets.target?.id] ?? 0;
        if (taken > 0 && f.side !== scope.self.side && !(scope.history.enemiesDamagedByThisAction ??= []).includes(f)) scope.history.enemiesDamagedByThisAction.push(f);
        // A push after this hit carries its Power (+1 each) and Iron (−1 each) — phase D.
        (scope.history.hits ??= {})[f.id] = { pushBonus: r?.pushBonus ?? 0, pushResist: r?.pushResist ?? 0 };
      }
      return;
    }
    // **A rule changed for this resolution only** (import guide: an Action's
    // or triggered Ability's `modify_rule`) — Shockwave's "Unblockable by
    // Armor and Shields". Lasting ones are `continuous` (engine/modifiers.js).
    case 'modify_rule': {
      if (!ENFORCED_RULES.has(node.rule)) return unsupported(node, scope, ctx);
      const value = val(node.value);
      // "Your next Action …" lasts until that Action (or the turn's end).
      if (/^next_(damage_)?action\./.test(node.rule) && world.addTemp) {
        for (const f of node.target ? await targetsOf(node.target, scope, ctx) : [scope.self]) {
          await world.addTemp({ rule: node.rule, value, targetId: f.id, ownerId: scope.self.id, source: ctx.ability?.id ?? null, duration: node.rule.startsWith('next_damage') ? 'until_next_damage_dealing_action' : 'end_of_current_turn_or_next_action' });
        }
        return;
      }
      for (const f of node.target ? await targetsOf(node.target, scope, ctx) : [scope.self]) {
        (scope.mods ??= []).push({ rule: node.rule, value, targetId: f.id, ownerId: scope.self.id, source: ctx.ability?.id ?? null });
      }
      return;
    }
    // **Until a duration ends** (engine/runtime.js expires it): modifiers and
    // temporary Armor installed in the fight's runtime.
    case 'temporary': {
      const items = TEMP_DURATIONS.has(node.duration) ? tempItems(node.effect) : null;
      if (!items || !world.addTemp) return unsupported(node, scope, ctx);
      for (const item of items) {
        if (item.op === 'register_trigger') {
          await world.addTemp({ trigger: { events: item.events ?? [], effect: item.effect }, targetId: scope.self.id, ownerId: scope.self.id, source: ctx.ability?.id ?? null, duration: node.duration });
          ctx.log(`${scope.self.name}: a new trigger until ${node.duration.replace(/_/g, ' ')}`);
          continue;
        }
        for (const f of item.target ? await targetsOf(item.target, scope, ctx) : [scope.self]) {
          if (item.op === 'grant_armor') {
            await world.tempArmor(f);
            ctx.log(`${f.name} gains temporary Armor`);
            continue;
          }
          await world.addTemp({ rule: item.rule, value: val(item.value), targetId: f.id, ownerId: scope.self.id, source: ctx.ability?.id ?? null, duration: node.duration });
        }
      }
      return;
    }
    // Spending tokens as part of an effect (not a cost): all or nothing.
    case 'spend_tokens': {
      const key = val(node.token);
      const amount = Number(val(node.amount)) || 0;
      for (const f of node.target ? await targetsOf(node.target, scope, ctx) : [scope.self]) {
        if ((world.heldTokens(f)[key] ?? 0) < amount) return DECLINED;
        await world.discardTokens(f, [key], amount);
        ctx.log(`${f.name} spends ${amount} ${tokenName(key)}`);
        // "After you spend a Training Token" (Training Style — phase H).
        if (key === 'training' && amount > 0) await ctx.emit?.('self.training_token_spent', f, { amount });
      }
      return;
    }
    // **Obstacles (phase E):** placed on picked spaces by the book's stacking
    // (mapTiles.js); a Copy is placed for whoever makes it (`self`).
    case 'place_obstacle': {
      const kind = val(node.obstacle);
      if (!world.placeObstacle || !OBSTACLE_OPS_KINDS.has(kind)) return unsupported(node, scope, ctx);
      // "You may place …": the space pick itself offers the skip.
      const decline = scope.mayDecline;
      scope.mayDecline = false;
      let squares;
      if (isSelector(node.target)) {
        const sel = { ...node.target, empty: node.target.empty || kind === 'copy' || kind === 'wall' };
        const from = ctx.originSquare ? { ...scope.self, square: ctx.originSquare } : scope.self;
        // Only spaces it can legally go on.
        // "Adjacent to the target": every space, then selectSpaces keeps those near it.
        const legal = world.spaces(from, BINDING_RANGES.has(sel.range?.mode) ? { mode: 'map' } : sel.range, { empty: sel.empty }).filter((sq) => world.canPlace(kind, sq));
        // How many to place is the node's count (3 Traps, "up to 3", X); the
        // target's own count is one space per pick.
        const raw = node.count ?? sel.count ?? 1;
        const count = raw && typeof raw === 'object' && 'ref' in raw ? Math.max(0, Number(val(raw)) || 0) : raw;
        if (count === 0) return;
        squares = await selectSpaces({ ...sel, count }, scope, { ...ctx, world: { ...world, spaces: () => legal } }, from, { optional: decline });
        if (decline && !squares.length) return DECLINED;
      } else {
        squares = asList(val(node.target)).map((x) => x?.square ?? x).filter((x) => x && Number.isInteger(x.col) && world.canPlace(kind, x));
      }
      const placed = [];
      for (const sq of squares) placed.push(await world.placeObstacle(kind, sq, scope.self));
      if (placed.length) ctx.log(`${scope.self.name} places ${placed.length === 1 ? `a ${kind === 'copy' ? 'Copy' : kind}` : `${placed.length} ${kind === 'copy' ? 'Copies' : kind}`}`);
      if (node.binding) scope.bindings[node.binding] = placed.length === 1 ? placed[0] : placed;
      return;
    }
    case 'destroy_obstacle':
    case 'replace_obstacle': {
      if (!world.destroyObstacle) return unsupported(node, scope, ctx);
      const to = node.op === 'replace_obstacle' ? val(node.replacement) : null;
      for (const o of await targetsOf(node.target, scope, ctx, 'an obstacle')) {
        if (!o.isObstacle && !o.isCopy) continue;
        if (to) await world.replaceObstacle(o, to, scope.self);
        else await world.destroyObstacle(o, scope.self);
        ctx.log(`${to ? 'replaces' : 'destroys'} the ${o.name}${to ? ` with ${to}` : ''}`);
      }
      return;
    }
    // **Movement (phase D):** the world plans it, asks for the square and
    // applies it (server/engine/moves.js); it posts its own notice.
    case 'move':
    case 'teleport': {
      const fn = node.op === 'move' ? world.move : world.teleport;
      if (!fn) return unsupported(node, scope, ctx);
      const distance = val(node.distance);
      const decline = scope.mayDecline;
      scope.mayDecline = false;
      for (const f of node.target ? await targetsOf(node.target, scope, ctx) : [scope.self]) {
        const to = await fn(f, { distance, upTo: Boolean(node.upTo), ...(decline ? { allowNone: true } : {}) });
        if (decline && to == null) return DECLINED;
        // "If it moved, swapped or teleported you" (Dance Form — phase G).
        if (to != null && f.id === scope.self.id) scope.history.selfMoved = true;
      }
      return;
    }
    case 'push':
    case 'pull': {
      if (!world.forced) return unsupported(node, scope, ctx);
      const distance = val(node.distance);
      const from = node.origin ? asList(val(node.origin))[0] : scope.self;
      for (const f of await targetsOf(node.target, scope, ctx, 'an enemy')) {
        const before = f.square ? `${f.square.col},${f.square.row}` : null;
        await world.forced(f, {
          distance,
          origin: from?.square ?? scope.self.square ?? null,
          pull: node.op === 'pull',
          upTo: Boolean(node.upTo),
          chooser: scope.self,
          hit: scope.history.hits?.[f.id] ?? null,
          unblockable: ctx.unblockable ?? [],
        });
        // Who this resolution moved by force (phase G: Ogre's, Dance Form).
        const after = f.square ? `${f.square.col},${f.square.row}` : null;
        if (before !== after && !f.isObstacle) (scope.history.forcedIds ??= []).push(f.id);
        if (before !== after && f.id === scope.self.id) scope.history.selfMoved = true;
      }
      return;
    }
    case 'swap_spaces': {
      if (!world.swap) return unsupported(node, scope, ctx);
      const actor = node.actor ? asList(val(node.actor))[0] : scope.self;
      for (const f of await targetsOf(node.target, scope, ctx)) {
        if (!actor) continue;
        // Swapping with a Wall (Walled In) moves a tile: by hand.
        if (f.isObstacle && !f.isCopy) {
          unsupported(node, scope, ctx);
          continue;
        }
        await world.swap(actor, f);
        if (actor.id === scope.self.id || f.id === scope.self.id) scope.history.selfMoved = true;
      }
      return;
    }
    // **Teleport to a picked space (phase H):** "teleport to a space adjacent
    // to the target", "anywhere you can see", "anywhere on the map".
    case 'teleport_to': {
      const dest = node.destination;
      if (!world.teleportTo || !isSelector(dest) || dest.kind !== 'space') return unsupported(node, scope, ctx);
      const decline = takeDecline(scope);
      for (const f of node.target ? await targetsOf(node.target, scope, ctx) : [scope.self]) {
        const squares = await selectSpaces({ ...dest, empty: dest.empty !== false, count: 1 }, scope, ctx, scope.self, { optional: decline });
        if (!squares.length) {
          if (decline) return DECLINED;
          continue;
        }
        await world.teleportTo(f, squares[0]);
        if (f.id === scope.self.id) scope.history.selfMoved = true;
      }
      return;
    }
    // "You move one less space" when pushed or pulled (`self.would_be_pushed_or_pulled`).
    case 'reduce_forced_movement':
      scope.event.reduction = (scope.event.reduction ?? 0) + (Number(val(node.amount)) || 0);
      return;
    // A trigger for a while (outside a `temporary`: for the rest of the fight).
    case 'register_trigger':
      if (!world.addTemp) return unsupported(node, scope, ctx);
      await world.addTemp({ trigger: { events: node.events ?? [], effect: node.effect }, targetId: scope.self.id, ownerId: scope.self.id, source: ctx.ability?.id ?? null, duration: 'end_of_fight' });
      return;
    // **Later (phase G):** an effect at the end of this turn or the start of
    // your next, with this resolution's targets, bindings and variables
    // captured now (import guide).
    case 'schedule':
      if (!world.schedule || !SCHEDULE_AT.has(node.at)) return unsupported(node, scope, ctx);
      await world.schedule({ at: node.at, effect: node.effect, ownerId: scope.self.id, source: ctx.ability?.id ?? null, captured: capture(scope) });
      return;
    // Power Form / Iron Form: "when you gain Speed, replace half with Power".
    case 'replace_token_gain':
      scope.event.replace = { from: val(node.fromToken), to: val(node.toToken), amount: Math.max(0, Number(val(node.amount)) || 0) };
      return;
    // "Take 1 less damage" while a hit is being resolved (`self.would_take_damage`).
    case 'reduce_damage':
      scope.event.reduction = (scope.event.reduction ?? 0) + (Number(val(node.amount)) || 0);
      return;
    // Heroic Style: an ally's incoming damage is split with you (decided: the
    // first redirector only).
    case 'split_incoming_damage': {
      if (scope.event.split) return;
      const to = asList(val(node.recipient))[0] ?? scope.self;
      scope.event.split = { keep: Number(val(node.originalShare)) || 0, give: [{ to, amount: Number(val(node.recipientShare)) || 0 }] };
      ctx.log(`${to.name} takes half the damage`);
      return;
    }
    case 'challenge': {
      const challenger = asList(val(node.challenger))[0] ?? scope.self;
      for (const f of await targetsOf(node.target, scope, ctx, 'an enemy')) {
        await world.challenge(f, challenger);
        (scope.history.challengedIds ??= []).push(f.id);
        (scope.history.challengedByThisAction ??= []).push(f);
        ctx.log(`${challenger.name} Challenges ${f.name}`);
        await ctx.emit?.('self.challenge_given_to_enemy', challenger, { target: f });
      }
      return;
    }
    // **A Text notification** (homebrew, decided): a reminder card in the chat
    // with this text — or the Ability's rules text when it has none.
    case 'notify':
      await ctx.notify?.(String(val(node.text) || ctx.ability?.rulesText || ''));
      return;
    // The character's Warrior's Path rules run as a follow-on event.
    case 'trigger_warrior_path':
      await ctx.emit?.('warrior_path.trigger', scope.self, {});
      return;
    case 'add_pool_number': {
      const v = val(node.value);
      for (const f of await targetsOf(node.target, scope, ctx)) {
        await world.addPoolNumber(f, v);
        ctx.log(`${f.name} adds a ${v} to their Action Pool`);
      }
      return;
    }
    // **The Action Pool (phase H):** numbers on the owner's turn board, picked
    // by the owner and changed in place (server/engine/actions.js changePool).
    case 'increase_pool_number':
    case 'set_pool_number':
    case 'replace_pool_number':
    case 'duplicate_pool_number': {
      if (!world.changePool) return unsupported(node, scope, ctx);
      const decline = takeDecline(scope);
      const maxValue = node.target?.maximumValue;
      const verb = { increase_pool_number: `increase by ${val(node.amount)}`, set_pool_number: 'change', replace_pool_number: 'replace', duplicate_pool_number: 'copy' }[node.op];
      const pick = await pickPool(scope, ctx, scope.self, { filter: (p) => maxValue == null || p.value <= maxValue, text: `Which number to ${verb}?`, decline });
      if (!pick) return decline ? DECLINED : undefined;
      if (node.op === 'duplicate_pool_number') {
        await world.changePool(scope.self, (d) => addPoolValue(d, pick.value, 'ability'));
        ctx.log(`${scope.self.name} copies a ${pick.value} into their Action Pool`);
        return;
      }
      let value;
      if (node.op === 'increase_pool_number') value = Math.min(Number(val(node.maximum)) || Infinity, pick.value + (Number(val(node.amount)) || 0));
      else if (node.value?.chooseInteger) value = await chooseInteger(scope, ctx, node.value.chooseInteger, `Change the ${pick.value} to…`);
      else value = Number(val(node.value)) || 0;
      await world.changePool(scope.self, (d) => setPoolValue(d, pick.index, value));
      ctx.log(`${scope.self.name}: a ${pick.value} in their Action Pool becomes a ${value}`);
      return;
    }
    // Wardancer: +3, +2 and +1 to three different numbers (to a maximum).
    case 'increase_distinct_pool_numbers': {
      if (!world.changePool) return unsupported(node, scope, ctx);
      const max = Number(val(node.maximum)) || Infinity;
      const used = new Set();
      for (const amount of asList(val(node.amounts))) {
        const pick = await pickPool(scope, ctx, scope.self, { filter: (p) => !used.has(p.index) && p.value < max, text: `Which number gets +${amount}?` });
        if (!pick) break;
        used.add(pick.index);
        const value = Math.min(max, pick.value + amount);
        await world.changePool(scope.self, (d) => setPoolValue(d, pick.index, value));
        ctx.log(`${scope.self.name}: ${pick.value} → ${value}`);
      }
      return;
    }
    // Rerolls keep the new result (`mustKeepNew` is the only kind in the book).
    case 'reroll_die':
    case 'reroll_dice': {
      if (!world.changePool || (node.target && !isSelector(node.target))) return unsupported(node, scope, ctx);
      const decline = takeDecline(scope);
      const dice = (world.pool(scope.self) ?? []).filter((p) => p.die > 0 && !p.added);
      if (!dice.length) return decline ? DECLINED : undefined;
      const max = node.op === 'reroll_die' ? 1 : Number(val(node.maximum)) || 1;
      const ans = await ctx.ask({
        kind: 'targets',
        fighter: scope.self,
        title: ctx.ability?.name ?? 'Re-roll',
        text: max === 1 ? 'Re-roll which die? You keep the new result.' : `Re-roll up to ${max} dice? You keep the new results.`,
        options: dice.map((p) => ({ id: String(p.index), label: poolLabel(p) })),
        minimum: decline || max > 1 ? 0 : 1,
        maximum: max,
      });
      const picks = asList(ans).map(String).map((id) => dice.find((p) => String(p.index) === id)).filter(Boolean).slice(0, max);
      if (!picks.length) return decline ? DECLINED : undefined;
      const rolled = picks.map((p) => ({ p, value: rollDie(ctx, p.die) }));
      await world.changePool(scope.self, (d) => rolled.forEach(({ p, value }) => setPoolValue(d, p.index, value)));
      ctx.log(`${scope.self.name} re-rolls ${rolled.map(({ p, value }) => `d${p.die} ${p.value} → ${value}`).join(', ')}`);
      return;
    }
    // Flashy Style: two numbers into one (their sum); one number into its halves.
    case 'combine_pool_numbers': {
      if (!world.changePool) return unsupported(node, scope, ctx);
      const decline = takeDecline(scope);
      const count = Number(val(node.count)) || 2;
      if ((world.pool(scope.self) ?? []).length < count) return decline ? DECLINED : undefined;
      const picks = [];
      for (let i = 0; i < count; i++) {
        const pick = await pickPool(scope, ctx, scope.self, { filter: (p) => !picks.some((x) => x.index === p.index), text: i ? 'Combine it with which number?' : 'Combine which number?', decline: decline && i === 0 });
        if (!pick) return decline ? DECLINED : undefined;
        picks.push(pick);
      }
      const sum = picks.reduce((n, p) => n + p.value, 0);
      await world.changePool(scope.self, (d) => {
        for (const p of picks) removePoolNumber(d, p.index);
        addPoolValue(d, sum, 'ability');
      });
      ctx.log(`${scope.self.name} combines ${picks.map((p) => p.value).join(' and ')} into a ${sum}`);
      return;
    }
    case 'split_pool_number': {
      if (!world.changePool) return unsupported(node, scope, ctx);
      const decline = takeDecline(scope);
      const min = Number(val(node.minimumOriginal)) || 2;
      const pick = await pickPool(scope, ctx, scope.self, { filter: (p) => p.value >= min, text: 'Split which number in half?', decline });
      if (!pick) return decline ? DECLINED : undefined;
      const halves = [Math.ceil(pick.value / 2), Math.floor(pick.value / 2)];
      await world.changePool(scope.self, (d) => {
        removePoolNumber(d, pick.index);
        for (const h of halves) addPoolValue(d, h, 'ability');
      });
      ctx.log(`${scope.self.name} splits a ${pick.value} into ${halves.join(' and ')}`);
      return;
    }
    // Judgment Style: an enemy with your Challenge loses their lowest Action Die
    // (else their bonus die, else their smallest number).
    case 'remove_lowest_action_die': {
      if (!world.changePool) return unsupported(node, scope, ctx);
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const pool = world.pool(f) ?? [];
        const bySize = (a, b) => a.die - b.die || a.value - b.value;
        const gone = pool.filter((p) => p.die > 0 && !p.added && !p.bonus).sort(bySize)[0] ?? pool.find((p) => p.bonus) ?? pool.filter((p) => p.fixed || p.added).sort((a, b) => a.value - b.value)[0];
        if (!gone) continue;
        await world.changePool(f, (d) => removePoolNumber(d, gone.index));
        ctx.log(`${f.name} loses their ${gone.die ? `d${gone.die} (${gone.value})` : gone.value}`);
      }
      return;
    }
    // Every number of theirs changes (to a minimum).
    case 'modify_pool_numbers': {
      if (!world.changePool) return unsupported(node, scope, ctx);
      const amount = Number(val(node.amount)) || 0;
      const min = Number(val(node.minimum)) || 0;
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const pool = world.pool(f) ?? [];
        if (!pool.length) continue;
        await world.changePool(f, (d) => pool.forEach((p) => setPoolValue(d, p.index, Math.max(min, p.value + amount))));
        ctx.log(`${f.name}'s numbers ${amount >= 0 ? '+' : '−'}${Math.abs(amount)}`);
      }
      return;
    }
    // **An Action performed by a rule (phase H):** picked from those on offer,
    // performed without paying its cost, with `rating` for its Gates and X.
    case 'perform_action': {
      if (!world.performAction || !world.actionsFor) return unsupported(node, scope, ctx);
      const actor = node.actor ? asList(val(node.actor))[0] : scope.self;
      if (!actor) return;
      const list = performCandidates(node.selector, scope, ctx, actor);
      if (list == null) return unsupported(node, scope, ctx);
      if (!list.length) {
        ctx.log(`${actor.name}: no Action to perform`);
        return;
      }
      let action = list[0];
      if (list.length > 1) {
        const ans = await ctx.ask({ kind: 'choose', fighter: scope.self, title: ctx.ability?.name ?? 'Perform an Action', text: `${actor.name} performs which Action?`, options: list.map((a) => ({ id: a.id, label: a.name })), minimum: 1, maximum: 1 });
        action = list.find((a) => a.id === String(asList(ans)[0])) ?? list[0];
      }
      if (node.selector?.notSelectedByThisActionThisTurn) (ctx.usage[`picked:${ctx.ability?.id}:${scope.self.id}:turn`] ??= []).push(action.id);
      const rating = Number(val(node.rating)) || 4;
      // "Spend that 10" (A Warrior's Death): the number added for it leaves the pool.
      if (node.payCost && world.changePool) {
        const added = (world.pool(actor) ?? []).filter((p) => p.added && p.value === rating).at(-1);
        if (added) await world.changePool(actor, (d) => removePoolNumber(d, added.index));
      }
      const r = await world.performAction(actor, action.id, { rating });
      ctx.log(`${actor.name} performs ${action.name}${r?.lines?.length ? `: ${r.lines.join('; ')}` : ''}`);
      for (const m of r?.manual ?? []) ctx.onUnsupported?.({ op: m });
      return;
    }
    // "Repeat N times" (Mentor: once per Mentor token).
    case 'repeat': {
      const lo = Number(val(node.minimum)) || 0;
      const hi = node.maximum == null ? null : Number(val(node.maximum)) || 0;
      if (hi == null || node.continueChooser || node.stopWhen) return unsupported(node, scope, ctx);
      for (let i = 0; i < Math.min(hi, 20); i++) {
        if (i >= lo) {
          const more = await ctx.ask({ kind: 'confirm', fighter: scope.self, title: ctx.ability?.name ?? 'Again?', text: `Again? (${i} so far)` });
          if (!more) break;
        }
        if ((await run(node.effect, scope, ctx)) === DECLINED) break;
      }
      return;
    }
    // Frenzy Mastery's mythical d12.
    case 'roll_die': {
      const sides = Number(val(node.sides)) || 6;
      const value = rollDie(ctx, sides);
      if (node.binding) scope.bindings[node.binding] = value;
      ctx.log(`${scope.self.name} rolls a d${sides}: ${value}`);
      return;
    }
    case 'grant_armor': {
      for (const f of await targetsOf(node.target, scope, ctx)) {
        await world.tempArmor(f);
        ctx.log(`${f.name} gains temporary Armor`);
      }
      return;
    }
    default:
      return unsupported(node, scope, ctx);
  }
}

// An Action runs what it can (full automation, phase B): a step the engine
// can't do yet is handed to people (a "by hand" note) and the rest goes on.
// Ability rules are pre-checked by ruleSupport instead.
function unsupported(node, scope, ctx) {
  if (ctx.onUnsupported) return ctx.onUnsupported(node, scope);
  throw new Unsupported(`op ${node.op}${node.rule ? ` ${node.rule}` : ''}`);
}

// ------------------------------------------------------------------ board geometry (range and sight)

// Squares: { col, row }. Distance with a diagonal counting 1 (decided).
export const chebyshev = (a, b) => Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));

// Line of sight between two squares' centres (book p.35: a line that only
// touches a Wall's corner or runs along its edge is fine). `walls`: Set of
// "col,row". The two end squares never block.
export function lineOfSight(a, b, walls) {
  if (!walls?.size) return true;
  const steps = Math.max(8, chebyshev(a, b) * 16);
  const ax = a.col + 0.5;
  const ay = a.row + 0.5;
  const bx = b.col + 0.5;
  const by = b.row + 0.5;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const onEdge = fx < 1e-6 || fx > 1 - 1e-6 || fy < 1e-6 || fy > 1 - 1e-6;
    if (onEdge) continue;
    const col = Math.floor(x);
    const row = Math.floor(y);
    if ((col === a.col && row === a.row) || (col === b.col && row === b.row)) continue;
    if (walls.has(`${col},${row}`)) return false;
  }
  return true;
}

// Whether `to` is a legal target from `from` for a range mode. `fogged(sq)`:
// the square holds Fog or is next to Fog. `enemy`: Walls and Fog only limit
// targeting enemies.
export function targetable({ from, to, range, stanceRange, walls, fogged, enemy }) {
  if (!from || !to) return range?.mode === 'none' || range?.mode === 'map';
  const d = chebyshev(from, to);
  const sight = !enemy || lineOfSight(from, to, walls);
  const fogOk = !enemy || d <= 1 || !fogged(to);
  switch (range?.mode) {
    case 'none':
    case 'map':
      return true;
    case 'adjacent':
      return d === 1 && sight;
    case 'explicit':
      return d >= (range.minimum ?? 0) && d <= (range.maximum ?? Infinity) && sight && fogOk;
    case 'visible':
      return sight && fogOk;
    case 'stance':
    default: {
      const r = stanceRange ?? { minimum: 0, maximum: 1 };
      return d >= r.minimum && d <= r.maximum && sight && fogOk;
    }
  }
}
