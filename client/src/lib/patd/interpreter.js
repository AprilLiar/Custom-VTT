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
//   damage(f, n, attacker)           → { dealt, bled }
//   challenge(target, challenger)
//   addPoolNumber(f, value)
//   context                          → { healValue, bleedValue, round, activeCharacter }
// }
// ask(request) → Promise(answer). request: { kind: 'confirm' | 'choose' | 'targets', fighter, title, text, options?, minimum?, maximum? }

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
]);
const SELECTOR_KINDS = new Set(['enemy', 'ally', 'unit', 'self_and_allies', 'self_or_ally']);
const RANGE_MODES = new Set(['stance', 'visible', 'adjacent', 'explicit', 'none', 'map']);
const REF_OK = [
  /^self$/,
  /^self\.bleeding$/,
  /^self\.tokens\.[a-z_]+$/,
  /^self\.currentBar\.damage$/,
  /^context\.(healValue|bleedValue|round|activeCharacter)$/,
  /^targets\.[A-Za-z]+$/,
  /^bindings\.[A-Za-z]+$/,
  /^variables\.[A-Za-z]+$/,
  /^state\.[A-Za-z]+$/,
  /^event\.(target|activeCharacter|attacker|amount)$/,
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
    if (typeof n.operator === 'string' && !(n.operator in OPERATORS) && n.operator !== 'if') problems.push(`operator ${n.operator}`);
    if (typeof n.ref === 'string' && !REF_OK.some((re) => re.test(n.ref))) problems.push(`ref ${n.ref}`);
    if (typeof n.kind === 'string' && n.range && !SELECTOR_KINDS.has(n.kind)) problems.push(`selector ${n.kind}`);
    if (n.range && typeof n.range === 'object' && n.range.mode && !RANGE_MODES.has(n.range.mode)) problems.push(`range ${n.range.mode}`);
    if (n.range?.origin && n.range.origin !== 'self') problems.push(`origin ${n.range.origin}`);
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
export async function runRule(rule, ctx) {
  const scope = {
    self: ctx.self,
    context: ctx.world.context,
    targets: {},
    bindings: {},
    variables: {},
    state: ctx.state,
    event: ctx.event ?? {},
  };
  if (rule.condition && !evalValue(rule.condition, scope)) return { ran: false };
  if (rule.limit) {
    const key = `${rule.id}:${ctx.self.id}:${rule.limit.period}`;
    const max = evalValue(rule.limit.maximum, scope);
    if ((ctx.usage[key] ?? 0) >= max) return { ran: false };
    ctx.usage[key] = (ctx.usage[key] ?? 0) + 1;
  }
  await run(rule.effect, scope, ctx);
  return { ran: true };
}

async function targetsOf(v, scope, ctx, label) {
  if (isSelector(v)) return select(v, scope, ctx, label);
  return asList(evalValue(v, scope)).filter((x) => x && typeof x === 'object' && x.id != null);
}

// The candidates a selector allows, and the pick when one is needed.
async function select(sel, scope, ctx, label = 'a target') {
  const { world } = ctx;
  const self = scope.self;
  let pool;
  if (sel.kind === 'enemy') pool = world.enemiesOf(self);
  else if (sel.kind === 'ally' || sel.kind === 'self_and_allies' || sel.kind === 'self_or_ally') pool = world.alliesOf(self);
  else pool = world.fighters();
  if (sel.excludeSelf) pool = pool.filter((f) => f.id !== self.id);
  pool = pool.filter((f) => world.inRange(self, f, sel.range));
  const count = sel.count;
  if (count === 'all' || sel.kind === 'self_and_allies') return pool;
  if (!pool.length) return [];
  const maximum = typeof count === 'number' ? count : typeof count === 'object' && count?.maximum != null ? evalValue(count.maximum, scope) : 1;
  const minimum = typeof count === 'object' && count?.maximum != null ? 0 : Math.min(1, pool.length);
  const answer = await ctx.ask({
    kind: 'targets',
    fighter: self,
    title: ctx.ability?.name ?? 'Choose',
    text: `Choose ${maximum === 1 ? label : `up to ${maximum}`}.`,
    options: pool.map((f) => ({ id: String(f.id), label: f.name })),
    minimum,
    maximum,
  });
  const ids = new Set(asList(answer).map(String));
  const picked = pool.filter((f) => ids.has(String(f.id))).slice(0, maximum);
  return picked.length || minimum === 0 ? picked : pool.slice(0, 1);
}

async function run(node, scope, ctx) {
  if (!node || typeof node !== 'object') return;
  const { world } = ctx;
  const val = (v) => evalValue(v, scope);
  switch (node.op) {
    case 'sequence':
      for (const s of node.steps) await run(s, scope, ctx);
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
      const ans = await ctx.ask({ kind: 'choose', fighter: scope.self, title: ctx.ability?.name ?? 'Choose', text: 'Choose one.', options, minimum: 1, maximum: node.maximum ?? 1 });
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
      const STATUS = ['burning', 'fatigue', 'weakness'];
      for (const f of await targetsOf(node.target, scope, ctx)) {
        const held = world.heldTokens(f);
        const filter = val(node.tokenFilter);
        let keys = Object.keys(held).filter((k) => held[k] > 0 && (filter === 'status' ? STATUS.includes(k) : filter === 'any' || filter == null || k === filter));
        if (!keys.length) continue;
        if (keys.length > 1 && amount < Object.values(held).reduce((a, b) => a + b, 0)) {
          const ans = await ctx.ask({
            kind: 'choose',
            fighter: scope.self,
            title: ctx.ability?.name ?? 'Discard',
            text: `Discard ${amount === 1 ? 'which token' : `up to ${amount}: which first`}?`,
            options: keys.map((k) => ({ id: k, label: `${tokenName(k)} (${held[k]})` })),
            minimum: 1,
            maximum: 1,
          });
          const first = asList(ans)[0];
          if (keys.includes(first)) keys = [first, ...keys.filter((k) => k !== first)];
        }
        const n = await world.discardTokens(f, keys, amount);
        if (n) ctx.log(`${f.name} discards ${n} token${n === 1 ? '' : 's'}`);
      }
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
    case 'damage': {
      const n = val(node.amount);
      for (const f of await targetsOf(node.target, scope, ctx, 'an enemy')) {
        const r = await world.damage(f, n, scope.self);
        ctx.log(`${scope.self.name} deals ${n} damage to ${f.name}`);
        await ctx.emit?.('self.damage_taken', f, { attacker: scope.self, amount: n });
        if (r?.bled) await ctx.emit?.('self.bleed', f, {});
      }
      return;
    }
    case 'challenge': {
      const challenger = asList(val(node.challenger))[0] ?? scope.self;
      for (const f of await targetsOf(node.target, scope, ctx, 'an enemy')) {
        await world.challenge(f, challenger);
        ctx.log(`${challenger.name} Challenges ${f.name}`);
        await ctx.emit?.('self.challenge_given_to_enemy', challenger, { target: f });
      }
      return;
    }
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
      throw new Unsupported(`op ${node.op}`);
  }
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
