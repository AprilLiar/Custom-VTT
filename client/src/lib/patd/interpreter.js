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
]);
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
]);
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
]);
const OBSTACLE_OPS_KINDS = new Set(['trap', 'fog', 'pit', 'rubble', 'wall', 'copy']);
// Copies aren't tracked on the board, so "you or your Copies" is your own range.
const RANGE_MODES = new Set(['stance', 'visible', 'adjacent', 'explicit', 'none', 'map', 'self_or_copies_range']);
const REF_OK = [
  /^self$/,
  /^self\.bleeding$/,
  /^self\.space$/,
  /^(targets|bindings)\.[A-Za-z]+\.space$/,
  /^self\.tokens\.[a-z_]+$/,
  /^self\.currentBar\.damage$/,
  /^context\.(healValue|bleedValue|round|activeCharacter)$/,
  /^targets\.[A-Za-z]+$/,
  /^bindings\.[A-Za-z]+$/,
  /^variables\.[A-Za-z]+$/,
  /^state\.[A-Za-z]+$/,
  /^event\.(target|activeCharacter|attacker|amount|isCostPayment|shieldBroke|damage|enemy|enemyCount|enemyDamageDealers)$/,
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
  if (rule.limit && rule.limit.metric !== 'activations') return { ok: false, reason: `limit ${rule.limit.metric}` };
  const problems = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.op === 'string' && !SUPPORTED_OPS.has(n.op)) problems.push(`op ${n.op}`);
    if (n.op === 'grant_armor' && !n.temporary) problems.push('lasting armor');
    if (n.op === 'modify_rule' && !ENFORCED_RULES.has(n.rule)) problems.push(`rule ${n.rule}`);
    if (n.op === 'temporary' && (!TEMP_DURATIONS.has(n.duration) || !tempItems(n.effect))) problems.push(`temporary ${n.duration}`);
    if (typeof n.operator === 'string' && !(n.operator in OPERATORS) && n.operator !== 'if') problems.push(`operator ${n.operator}`);
    if (typeof n.ref === 'string' && !REF_OK.some((re) => re.test(n.ref))) problems.push(`ref ${n.ref}`);
    if (typeof n.kind === 'string' && n.range && !SELECTOR_KINDS.has(n.kind)) problems.push(`selector ${n.kind}`);
    if (n.range && typeof n.range === 'object' && n.range.mode && !RANGE_MODES.has(n.range.mode)) problems.push(`range ${n.range.mode}`);
    if (n.range?.origin && n.range.origin !== 'self') problems.push(`origin ${n.range.origin}`);
    if (n.inFog || n.originBinding || n.obstacleBinding) problems.push('selector detail');
    if (n.op === 'place_obstacle' && !OBSTACLE_OPS_KINDS.has(n.obstacle)) problems.push(`obstacle ${n.obstacle}`);
    if (n.actor) problems.push('actor');
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
    return readPath(scope[head], rest);
  }
  if (typeof v.operator === 'string') {
    if (v.operator === 'if') {
      const [c, a, b] = v.args;
      return evalValue(c, scope) ? evalValue(a, scope) : evalValue(b, scope);
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
    context: ctx.world.context,
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
  if (rule.condition && !evalValue(rule.condition, scope)) return { ran: false };
  if (rule.limit) {
    const key = `${rule.id}:${ctx.self.id}:${rule.limit.period}`;
    const max = evalValue(rule.limit.maximum, scope);
    if ((ctx.usage[key] ?? 0) >= max) return { ran: false };
    ctx.usage[key] = (ctx.usage[key] ?? 0) + 1;
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
    if (n.op === 'grant_armor') return out.push(n) > 0;
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

const DECLINED = Symbol('declined');
// A "you may" opening with a pick offers its own skip (phase D: a square too).
const PICK_OPS = new Set(['discard_tokens', 'select_token', 'move', 'teleport', 'place_obstacle']);
const opensWithPick = (e) => PICK_OPS.has(e?.op) || (e?.op === 'sequence' && PICK_OPS.has(e.steps?.[0]?.op));

async function targetsOf(v, scope, ctx, label) {
  if (isSelector(v)) return select(v, scope, ctx, label);
  return asList(evalValue(v, scope)).filter((x) => x && typeof x === 'object' && x.id != null);
}

// **Spaces (phase E):** squares in range — `empty` ones only when asked —
// picked one at a time on the map or lane (`square` prompts).
async function selectSpaces(sel, scope, ctx, from, { optional = false } = {}) {
  const { world } = ctx;
  if (!world.spaces) throw new Unsupported('spaces');
  let pool = world.spaces(from, sel.range, { empty: Boolean(sel.empty) });
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

// The candidates a selector allows, and the pick when one is needed.
async function select(sel, scope, ctx, label = 'a target') {
  const { world } = ctx;
  const self = scope.self;
  // Acting from one of your Copies (phase E): ranges count from its square.
  const from = ctx.originSquare ? { ...self, square: ctx.originSquare } : self;
  if (sel.kind === 'space') return selectSpaces(sel, scope, ctx, from);
  const copies = world.copies?.() ?? [];
  let pool;
  if (sel.kind === 'enemy') pool = [...world.enemiesOf(self), ...copies.filter((c) => c.side !== self.side)];
  else if (sel.kind === 'ally' || sel.kind === 'self_and_allies' || sel.kind === 'self_or_ally') pool = world.alliesOf(self);
  else if (sel.kind === 'own_copy') pool = copies.filter((c) => c.ownerId === self.id);
  else if (sel.kind === 'obstacle') pool = world.obstacles?.(from, sel.range, { types: sel.types ?? null }) ?? [];
  else if (sel.kind.endsWith('_or_obstacle')) {
    const units = sel.kind === 'enemy_or_obstacle' ? world.enemiesOf(self) : sel.kind === 'ally_or_obstacle' ? world.alliesOf(self) : world.fighters();
    pool = [...units, ...(world.obstacles?.(from, sel.range, {}) ?? [])];
  } else pool = [...world.fighters(), ...copies];
  if (sel.excludeSelf) pool = pool.filter((f) => f.id !== self.id);
  // Dodged with Control (phase F): immune to this Action.
  if (ctx.immuneIds?.length) pool = pool.filter((f) => !ctx.immuneIds.includes(f.id));
  pool = pool.filter((f) => f.isObstacle || (f.isCopy && sel.range?.mode === 'none') || world.inRange(from, f, sel.range));
  const count = sel.count;
  if (count === 'all' || sel.kind === 'self_and_allies') return pool;
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
      const list = await select(node.selector, scope, ctx);
      for (const f of list) {
        scope.bindings[node.binding] = f;
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
        await world.gainTokens(f, key, amount);
        ctx.log(`${f.name} gains ${amount} ${tokenName(key)}`);
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
        let keys = Object.keys(held).filter(
          (k) => held[k] > 0 && !NOT_DISCARDABLE.has(k) && (filter === 'status' ? STATUS.includes(k) : filter === 'any' || filter == null || k === filter)
        );
        if (!keys.length) {
          if (decline) return DECLINED;
          continue;
        }
        const total = keys.reduce((n, k) => n + held[k], 0);
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
      const n = val(node.amount);
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const healed = await world.heal(f, n);
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
            await world.destroyObstacle(f);
            ctx.log(`${scope.self.name} destroys the ${f.name}${f.kind === 'wall' ? ' (Rubble now)' : ''}`);
          }
          continue;
        }
        const r = await world.damage(f, n, scope.self, {
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
        ctx.log(`${scope.self.name} deals ${taken} damage to ${f.name}${steps.length ? ` (${steps.join(', ')})` : ''}`);
        // What this resolution did (history.*): damage actually dealt, who was hit
        // (an attempt counts for the Challenge, even when it was all blocked).
        scope.history.damageDealt = (scope.history.damageDealt ?? 0) + taken;
        (scope.history.damagedIds ??= []).push(f.id);
        if (taken > 0 && f.side !== scope.self.side) (scope.history.enemyDamagedIds ??= []).push(f.id);
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
        const legal = world.spaces(from, sel.range, { empty: sel.empty }).filter((sq) => world.canPlace(kind, sq));
        squares = await selectSpaces({ ...sel, count: sel.count ?? node.count ?? 1 }, scope, { ...ctx, world: { ...world, spaces: () => legal } }, from, { optional: decline });
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
        if (to) await world.replaceObstacle(o, to);
        else await world.destroyObstacle(o);
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
      }
      return;
    }
    case 'push':
    case 'pull': {
      if (!world.forced) return unsupported(node, scope, ctx);
      const distance = val(node.distance);
      const from = node.origin ? asList(val(node.origin))[0] : scope.self;
      for (const f of await targetsOf(node.target, scope, ctx, 'an enemy')) {
        await world.forced(f, {
          distance,
          origin: from?.square ?? scope.self.square ?? null,
          pull: node.op === 'pull',
          upTo: Boolean(node.upTo),
          chooser: scope.self,
          hit: scope.history.hits?.[f.id] ?? null,
          unblockable: ctx.unblockable ?? [],
        });
      }
      return;
    }
    case 'swap_spaces': {
      if (!world.swap) return unsupported(node, scope, ctx);
      const actor = node.actor ? asList(val(node.actor))[0] : scope.self;
      for (const f of await targetsOf(node.target, scope, ctx)) if (actor) await world.swap(actor, f);
      return;
    }
    // "You move one less space" when pushed or pulled (`self.would_be_pushed_or_pulled`).
    case 'reduce_forced_movement':
      scope.event.reduction = (scope.event.reduction ?? 0) + (Number(val(node.amount)) || 0);
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
