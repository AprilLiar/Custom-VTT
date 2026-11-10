// **Performing Actions (full automation, phase B).** Commit on the turn board
// (server/diceMarks.js) runs here, on the fight's engine chain: each placed
// Action in placement order — a snapshot first (server/engine/snapshots.js),
// then its cost is paid, then its effect resolves through the interpreter
// with `payment.rating`, `resolution.gateRating` (stopping at an earlier Gate
// if the player chose one) and the Challenge enforced; then the Action events
// go through the bus. Retrieve (GM) restores the snapshot and un-commits that
// placement and every later one.
import { one, run } from '../db.js';
import { applyHpDelta } from '../../client/src/lib/hpBars.js';
import { describe, hasNoTargets, runRule } from '../../client/src/lib/patd/interpreter.js';
import { abilitiesOff, sumMod, valueOf } from '../../client/src/lib/patd/engine/modifiers.js';
import { costBonus, poolOf, removePoolNumber } from '../../client/src/lib/patd/diceBoard.js';
import { BASIC_KEYS, luckRoom, planPayment } from '../../client/src/lib/patd/tokenCost.js';
import { expireTemps, fighterRt } from '../../client/src/lib/patd/engine/runtime.js';
import { hpOf, saveHp, shapeFightState } from '../combatState.js';
import { patdContent } from '../patdContent.js';
import { actingOn, readData, saveBoard, fighterState } from '../diceMarks.js';
import { restoreSnapshot, takeSnapshot } from './snapshots.js';
import { atZero, recordUse, superKey } from '../../client/src/lib/patd/engine/turn.js';

const THROWS = new Set(['action.system-basic-actions.throw', 'action.system-basic-actions.grapple']);
const POLTERGEIST = 'ability.resource-mechanic-poltergeist.poltergeist-mechanics';
// The numbers an Action lists that Poltergeist may raise by 1: plain numbers
// of movement, tokens, healing, Shields and obstacles — never damage or how
// many choices. → [{ path, key, label }]
function numberSpots(effect) {
  const out = [];
  const LABEL = { move: 'Move', teleport: 'Teleport', push: 'Push', pull: 'Pull', gain_tokens: 'tokens', heal: 'heal', gain_shield: 'Shield', place_obstacle: 'obstacles' };
  const walk = (n, path) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, [...path, i]));
    const key = ['move', 'teleport', 'push', 'pull'].includes(n.op) ? 'distance' : n.op === 'gain_tokens' || n.op === 'heal' ? 'amount' : n.op === 'gain_shield' ? 'value' : n.op === 'place_obstacle' ? 'count' : null;
    if (key && typeof n[key] === 'number') out.push({ path, key, label: `${LABEL[n.op]} ${n[key]}${n.op === 'gain_tokens' && typeof n.token === 'string' ? ` ${n.token}` : ''} → ${n[key] + 1}` });
    for (const [k, v] of Object.entries(n)) if (k !== 'target' && k !== 'selector' && typeof v === 'object') walk(v, [...path, k]);
  };
  walk(effect, []);
  return out;
}
const hasDamage = (node) => {
  let found = false;
  const walk = (n) => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.op === 'damage') found = true;
    for (const v of Object.values(n)) walk(v);
  };
  walk(node);
  return found;
};

// kit: { envFor, ask, emitEvent, postCard, emitStageUpdated, emit, queued, onChain, reactionsAvailable }
export function createActionRunner(kit) {
  const { envFor, ask, emitEvent, postCard, emitStageUpdated, emit, queued } = kit;
  const saveQ = (rollId, data) => queued(() => saveBoard(rollId, data, emit));

  const fightOfBoard = async (rollId) => {
    const row = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [rollId]);
    if (!row) return {};
    const c = await one('SELECT scene_id, mode FROM combatants WHERE id = ?', [row.combatant_id]);
    const fight = c ? await one('SELECT * FROM fights WHERE scene_id = ? AND mode = ?', [c.scene_id, c.mode]) : null;
    return { row, fight };
  };

  // Pays a token placement for real; → the payment scope or { error }.
  // Through the world (the QA pass): tokens may come from Iron in their place
  // (Machine Style) or an Unbreakable ally; HP paid counts as HP lost this
  // turn; Elder Style and Luck change what is owed (tokenCost.js).
  async function payTokens(env, payer, row, action, placement, askPayer) {
    const actorId = actingOn(row).combatantId;
    const state = await fighterState(actorId);
    if (!state) return { error: 'no fighter' };
    const world = env.world;
    let answers = placement.answers;
    // "1 Luck Token may also be used to pay for (part of) any Token Action":
    // how many, when more could go in than the cost needs.
    const option = action.cost?.options?.[placement.option];
    const room = option ? luckRoom(option, state) : 0;
    if (room > 0) {
      const need = planPayment(action, placement.option, { ...answers, luck: 0 }, state);
      const least = need.error ? 0 : need.tokens.luck ?? 0;
      if (room > least) {
        const options = Array.from({ length: room - least + 1 }, (_, i) => ({ id: String(least + i), label: least + i ? `${least + i} Luck` : 'No Luck' }));
        const ans = await askPayer(action.name)({ kind: 'choose', title: `${action.name}: Luck`, text: 'Each Luck token pays in place of up to 3 Basic tokens, 3 HP or 3 Shield.', options, minimum: 1, maximum: 1 });
        answers = { ...answers, luck: Number(Array.isArray(ans) ? ans[0] : ans) || least };
      }
    }
    const plan = planPayment(action, placement.option, answers, state);
    if (plan.error) return plan;
    for (const [k, n] of Object.entries(plan.tokens)) {
      const spent = await world.spend(payer, k, n);
      if (spent < n) return { error: `not enough ${k}` };
    }
    if (plan.shield) await world.discardTokens(payer, ['shield'], plan.shield);
    if (plan.hp) await world.payHp(payer, plan.hp);
    if (plan.holderId != null) {
      await queued(() => run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [plan.holderId, actorId]));
      const holder = world.fighters().find((f) => f.id === plan.holderId);
      if (holder) holder.challengeId = null;
    }
    if (plan.tokens.luck) await postCard('reminder', { title: 'Luck', text: `${payer.name} pays with ${plan.tokens.luck} Luck.`, fighters: [{ name: payer.name }], automatic: 'ability', notice: true });
    return {
      rating: plan.rating,
      tokens: plan.tokens,
      hp: plan.hp,
      destroyedShieldValue: plan.shield,
      challengeHolder: plan.holderId,
      isToken: true,
    };
  }

  // **Poltergeist Tokens (the Phantom — the QA pass, native).** "When you pay
  // the cost of an Action, you may spend Poltergeist Tokens to modify that
  // Action. You can spend up to 2 additional … (3 under Arcana Install). X is
  // equal to the number of Poltergeist Tokens spent on this Action" — its cost
  // included. Choose X different ones:
  //   numbers: +1 to up to X different numbers listed in it (never damage or
  //            choices) — distances, tokens, healing, Shields, obstacles;
  //   range:   its maximum Range +X;
  //   start:   teleport X; or place Rubble into X spaces within range;
  //   end:     1 damage to X enemies within range; or Push 1 / Pull 1 to X of
  //            its previous targets.
  // → { effect, rangeBonus, before: [effect], after: [effect], pushPrevious } | null
  async function poltergeist(env, payer, actor, action, payment, askPayer) {
    if (!(payer.abilityIds ?? []).includes(POLTERGEIST) || atZero(payer.hp)) return null;
    const world = env.world;
    const one = (ans) => (Array.isArray(ans) ? ans[0] : ans);
    const limit = Math.max(0, Number(valueOf(world.mods?.(payer) ?? [], 'poltergeist.total_per_action', 2)) || 2);
    const held = payer.tokens.poltergeist ?? 0;
    let extra = 0;
    if (held > 0 && limit > 0) {
      const max = Math.min(held, limit);
      const ans = one(await askPayer(action.name)({ kind: 'choose', title: `${action.name}: Poltergeist`, text: `Spend Poltergeist tokens to change ${action.name}? (${held} held)`, options: Array.from({ length: max + 1 }, (_, i) => ({ id: String(i), label: i ? `${i} Poltergeist` : 'None' })), minimum: 1, maximum: 1 }));
      extra = Math.min(max, Math.max(0, Number(ans) || 0));
      if (extra) await world.discardTokens(payer, ['poltergeist'], extra);
    }
    const X = extra + (Number(payment.tokens?.poltergeist) || 0);
    payment.totalPoltergeistSpentIncludingCost = X;
    if (!X) return null;
    const numbers = numberSpots(action.effect);
    const options = [
      ...(numbers.length ? [{ id: 'numbers', label: `+1 to up to ${X} number${X === 1 ? '' : 's'} in it` }] : []),
      { id: 'range', label: `Maximum Range +${X}` },
      { id: 'teleport', label: `Start: teleport ${X}` },
      { id: 'rubble', label: `Start: Rubble into ${X} space${X === 1 ? '' : 's'} within range` },
      { id: 'damage', label: `End: 1 damage to ${X} enem${X === 1 ? 'y' : 'ies'} within range` },
      { id: 'push', label: `End: Push 1 or Pull 1 to ${X} previous target${X === 1 ? '' : 's'}` },
    ];
    const n = Math.min(X, options.length);
    const ans = await askPayer(action.name)({ kind: 'choose', title: `${action.name}: Poltergeist (${X})`, text: `Choose ${n}, each different.`, options, minimum: n, maximum: n });
    const picks = new Set((Array.isArray(ans) ? ans : [ans]).map(String).filter((id) => options.some((o) => o.id === id)));
    for (const o of options) if (picks.size < n && !picks.has(o.id)) picks.add(o.id);
    const out = { effect: null, rangeBonus: 0, before: [], after: [], pushPrevious: 0 };
    if (picks.has('numbers')) {
      const ids = new Set(
        ((await askPayer(action.name)({ kind: 'choose', title: `${action.name}: Poltergeist`, text: `+1 to which number${X === 1 ? '' : 's'}? (up to ${X})`, options: numbers.map((x, i) => ({ id: String(i), label: x.label })), minimum: 1, maximum: Math.min(X, numbers.length) })) ?? []).toString().split(',')
      );
      const effect = JSON.parse(JSON.stringify(action.effect));
      numbers.forEach((x, i) => {
        if (!ids.has(String(i))) return;
        const node = x.path.reduce((o, k) => o[k], effect);
        node[x.key] = Number(node[x.key]) + 1;
      });
      out.effect = effect;
    }
    if (picks.has('range')) out.rangeBonus = X;
    if (picks.has('teleport')) out.before.push({ op: 'teleport', distance: X, target: { ref: 'self' } });
    if (picks.has('rubble')) out.before.push({ op: 'place_obstacle', obstacle: 'rubble', count: X, target: { kind: 'space', range: { mode: 'stance', origin: 'self' }, count: 1 } });
    if (picks.has('damage')) out.after.push({ op: 'damage', amount: 1, target: { kind: 'enemy', range: { mode: 'stance', origin: 'self' }, count: { maximum: X } } });
    if (picks.has('push')) out.pushPrevious = X;
    await postCard('reminder', { title: 'Poltergeist', text: `${payer.name} spends ${X} Poltergeist on ${action.name}: ${options.filter((o) => picks.has(o.id)).map((o) => o.label).join('; ')}.`, fighters: [{ name: payer.name }], automatic: 'ability', notice: true });
    return out;
  }
  // "Push 1 or Pull 1 to X previous targets of this Action."
  async function pushPrevious(env, actor, history, X, askPayer, action) {
    const targets = (history.targets ?? []).filter((t) => t.square && !t.isObstacle && t.id !== actor.id).slice(0, X);
    for (const t of targets) {
      const ans = await askPayer(action.name)({ kind: 'choose', title: `${action.name}: Poltergeist`, text: `${t.name}: Push 1 or Pull 1?`, options: [{ id: 'push', label: 'Push 1' }, { id: 'pull', label: 'Pull 1' }, { id: 'none', label: 'Neither' }], minimum: 1, maximum: 1 });
      const how = Array.isArray(ans) ? ans[0] : ans;
      if (how !== 'push' && how !== 'pull') continue;
      await env.world.forced(t, { distance: 1, origin: actor.square, pull: how === 'pull', chooser: actor });
    }
  }

  // **Costs paid on top of the placed one (the QA pass).**
  //   - "As an additional cost, you may pay 2 or 4 Basic Tokens" (Roughhousing:
  //     `cost.additionalOptions`, bound into the payment by name);
  //   - "choose one or more" costs (Bag of Tricks: `one_or_more_distinct`): the
  //     placed die or tokens are the first, the others are offered now, and
  //     X is how many were paid.
  // An Action performed for free (Copied, the Teacher's) pays none.
  async function extraCosts(env, payer, action, placement, payment, data, askPayer) {
    const cost = action.cost ?? {};
    const world = env.world;
    const free = Boolean(placement.free || placement.copied);
    const one = (ans) => (Array.isArray(ans) ? ans[0] : ans);
    const name = (k) => k.charAt(0).toUpperCase() + k.slice(1);
    const basicHeld = () => BASIC_KEYS.reduce((n, k) => n + (payer.tokens[k] ?? 0), 0);
    const payBasic = async (amount) => {
      const held = BASIC_KEYS.filter((k) => (payer.tokens[k] ?? 0) > 0);
      let order = held;
      if (held.length > 1 && basicHeld() > amount) {
        const first = one(await askPayer(action.name)({ kind: 'choose', title: `${action.name}: ${amount} Basic tokens`, text: 'Spend which first?', options: held.map((k) => ({ id: k, label: `${name(k)} (${payer.tokens[k]})` })), minimum: 1, maximum: 1 }));
        if (held.includes(first)) order = [first, ...held.filter((k) => k !== first)];
      }
      await world.discardTokens(payer, order, amount);
    };
    const adds = (cost.additionalOptions ?? []).filter((o) => o.bind);
    for (const bind of new Set(adds.map((o) => o.bind))) {
      const amounts = [...new Set(adds.filter((o) => o.bind === bind).map((o) => o.components.reduce((n, c) => n + (c.kind === 'token' && c.token === 'basic' ? Number(c.amount) || 0 : 0), 0)))].filter((a) => a <= basicHeld()).sort((a, b) => a - b);
      let amount = 0;
      if (!free && amounts.some((a) => a > 0)) {
        const pick = one(await askPayer(action.name)({ kind: 'choose', title: `${action.name}: an additional cost`, text: 'You may pay more for more.', options: [0, ...amounts.filter((a) => a > 0)].map((a) => ({ id: String(a), label: a ? `Pay ${a} Basic tokens` : 'Nothing more' })), minimum: 1, maximum: 1 }));
        amount = amounts.includes(Number(pick)) ? Number(pick) : 0;
        if (amount) await payBasic(amount);
      }
      payment[bind] = amount;
    }
    if (cost.selection !== 'one_or_more_distinct') return;
    if (free) {
      payment.selectedOptionCount = payment.rating || 1;
      return;
    }
    const opts = (cost.options ?? []).map((o, i) => ({ o, i }));
    const poolMin = (o) => o.components.find((c) => c.kind === 'pool_number')?.minimum ?? null;
    const others = (o) => o.components.filter((c) => c.kind !== 'pool_number');
    const hpNow = () => payer.hp?.current ?? 0;
    const payRest = async (o) => {
      for (const c of others(o)) {
        if (c.kind === 'token') await (c.token === 'basic' ? payBasic(c.amount) : world.discardTokens(payer, [c.token], c.amount));
        else if (c.kind === 'hp') await world.payHp(payer, c.amount);
      }
    };
    // Which option the placed die or tokens were: the die's cheapest fit.
    let used = opts.find((x) => x.i === placement.option) ?? null;
    if (placement.kind === 'die') {
      used = opts.filter((x) => x.o.category === 'dice' && (poolMin(x.o) ?? 0) <= payment.rating).sort((a, b) => others(a.o).length - others(b.o).length)[0] ?? opts.find((x) => x.o.category === 'dice') ?? null;
      if (used) await payRest(used.o);
    }
    const reserved = new Set((data.placements ?? []).flatMap((p) => (p.kind === 'die' ? [p.die] : p.kind === 'super' ? (p.dice ?? []) : [])));
    const freeNumbers = (min) => (world.pool(payer) ?? []).filter((n) => !reserved.has(n.index) && n.value >= min);
    const can = (o) => {
      const min = poolMin(o);
      if (min != null && !freeNumbers(min).length) return false;
      return others(o).every((c) => (c.kind === 'token' ? (c.token === 'basic' ? basicHeld() : (payer.tokens[c.token] ?? 0)) >= c.amount : c.kind === 'hp' ? hpNow() >= c.amount : false));
    };
    const label = (o) => [poolMin(o) != null ? `a ${poolMin(o)}+` : null, ...others(o).map((c) => (c.kind === 'hp' ? `${c.amount} HP` : `${c.amount} ${name(c.token)}`))].filter(Boolean).join(' and ');
    const open = opts.filter((x) => x.i !== used?.i && can(x.o));
    let count = 1;
    if (open.length) {
      const ans = await askPayer(action.name)({ kind: 'choose', title: `${action.name}: more costs`, text: 'Each cost you pay is one more choice. Pay any others?', options: open.map((x) => ({ id: String(x.i), label: `Spend ${label(x.o)}` })), minimum: 0, maximum: open.length });
      const ids = new Set((Array.isArray(ans) ? ans : ans == null ? [] : [ans]).map(String));
      for (const x of open) {
        if (!ids.has(String(x.i)) || !can(x.o)) continue;
        const min = poolMin(x.o);
        if (min != null) {
          const nums = freeNumbers(min);
          let n = nums[0];
          if (nums.length > 1) {
            const pick = one(await askPayer(action.name)({ kind: 'choose', title: `${action.name}: spend a ${min}+`, text: 'Which number?', options: nums.map((q) => ({ id: String(q.index), label: String(q.value) })), minimum: 1, maximum: 1 }));
            n = nums.find((q) => String(q.index) === String(pick)) ?? n;
          }
          reserved.add(n.index);
          await world.changePool(payer, (d) => removePoolNumber(d, n.index));
        }
        await payRest(x.o);
        count++;
      }
    }
    payment.selectedOptionCount = count;
  }

  // One placed Action, resolved. → { ok, lines, manual, error }
  // `envIn`: run inside a job's own env (an Action performed by a rule —
  // phase H); that job saves the runtime, not this.
  async function perform(fightRow, row, data, placement, envIn = null) {
    const idx = patdContent();
    const action = idx.get(placement.actionId);
    const { env, byId } = envIn ? { env: envIn, byId: (id) => envIn.world.fighters().find((f) => f.id === id) } : await envFor(fightRow);
    const save = () => (envIn ? null : env.save());
    // Whose turn it is, for rules that ask ("during your own turn" — Mastermind's Move 1).
    if (!envIn && env.world.context && env.world.context.activeCharacter == null) {
      let order = [];
      try {
        order = JSON.parse(fightRow.turn_order || '[]');
      } catch {
        order = [];
      }
      env.world.context.activeCharacter = byId(order[fightRow.turn_index]?.id) ?? null;
    }
    // Who pays for it — and, but for a Mastermind, who performs it.
    const payer = byId(actingOn(row).combatantId);
    if (!action || !payer) return { ok: false, error: 'the fighter or the Action is gone' };
    const askPayer = (when) => ask(payer, env.key, env.gen, env.tg, when);
    // **Mastermind Style (batch 5): "You cannot perform Actions. Instead, you
    // pay their costs, but make your allies perform them for you"** — from the
    // ally's location, with their range and Stance bonuses. The Mastermind
    // picks the ally (one in sight: no asking) and answers every choice.
    let actor = payer;
    if (placement.kind !== 'super' && !placement.copied && delegates(env, payer)) {
      const allies = env.world.alliesOf(payer).filter((a) => a.id !== payer.id && a.square && !atZero(a.hp) && env.world.inRange(payer, a, { mode: 'visible', origin: 'self' }));
      if (!allies.length) return { ok: false, error: `${payer.name} can see no ally to perform it (Mastermind Style)`, action };
      let pick = allies[0];
      if (allies.length > 1) {
        const ans = await askPayer(action.name)({
          kind: 'targets',
          title: `${action.name} (Mastermind)`,
          text: 'Which ally performs it?',
          mode: env.world.mode ?? null,
          options: allies.map((a) => ({ id: String(a.id), label: a.name, col: a.square.col, row: a.square.row })),
          minimum: 1,
          maximum: 1,
        });
        pick = allies.find((a) => String(a.id) === String(Array.isArray(ans) ? ans[0] : ans)) ?? null;
        if (!pick) return { ok: false, cancelled: true, action };
      }
      actor = pick;
    }
    // **No valid targets (decided, batch 5):** asked before anything is paid.
    // Yes performs it anyway (whatever needs no target still happens); No
    // takes the Action off the board, its dice back in the pool.
    if (!placement.copied && !placement.free) {
      let none = false;
      try {
        none = hasNoTargets(action.effect, { world: env.world, self: actor, state: fighterRt(env.rt, actor.id).state, usage: env.usage, resolution: { gateRating: placement.stop ?? 0 }, history: {}, payment: {} });
      } catch {
        none = false;
      }
      if (none) {
        const yes = await askPayer(action.name)({ kind: 'confirm', title: `${action.name}: no valid targets`, text: `${actor.name} has nobody to target with ${action.name} right now. Perform it anyway?` });
        if (!yes) return { ok: false, cancelled: true, action };
      }
    }
    let payment;
    if (placement.kind === 'super') {
      // **A Super Move (phase I):** paid with its pair of matching numbers.
      const pool = poolOf(data);
      const nums = (placement.dice ?? []).map((i) => pool.find((p) => p.index === i)?.value ?? 0);
      payment = { rating: nums[0] ?? 0, poolNumbers: nums, isDice: true, isSuper: true };
    } else if (placement.kind === 'die') {
      const n = poolOf(data).find((p) => p.index === placement.die);
      payment = { rating: n?.value ?? 0, poolNumbers: [n?.value ?? 0], isDice: true };
      // A Chaos token spent "as if you had spent a 4" (once per turn — phase F).
      if (n?.source === 'chaos') {
        if (fighterRt(env.rt, payer.id).flags.chaosUsed || !((payer.tokens.chaos ?? 0) > 0)) return { ok: false, error: 'no Chaos token to spend (once per turn)', action };
        await env.world.discardTokens(payer, ['chaos'], 1);
        fighterRt(env.rt, payer.id).flags.chaosUsed = true;
      }
    } else {
      payment = await payTokens(env, payer, row, action, placement, askPayer);
      if (payment.error) return { ok: false, error: payment.error };
      await emitEvent(env, 'self.token_action.pay_cost', payer, { action });
    }
    await extraCosts(env, payer, action, placement, payment, data, askPayer);
    if (payment.hp) await emitEvent(env, 'self.hp_paid', payer, { amount: payment.hp });
    await emitEvent(env, 'self.action.cost_paid', payer, { action, rating: payment.rating });
    if (actor !== payer) await postCard('reminder', { title: 'Mastermind Style', text: `${actor.name} performs ${action.name} for ${payer.name}.`, fighters: [{ name: payer.name }], automatic: 'ability', notice: true });
    // Elder Style: a number counts one higher against the Action's costs and Gates.
    const elder = payment.isDice && !payment.isSuper ? costBonus(action, { costReduction: valueOf(env.world.mods?.(payer) ?? [], 'action_cost.reduction', null) }) : 0;
    const gateRating = placement.stop ?? payment.rating + elder;
    // **Acting from a Copy (phase E, book p.71):** with Copies on the board the
    // Original picks where the Action is performed from; its ranges count from there.
    let originSquare = null;
    const own = (env.world.copies?.() ?? []).filter((c) => c.ownerId === actor.id && c.square);
    if (own.length && actor.square) {
      const options = [actor, ...own].map((o) => ({ id: `${o.square.col},${o.square.row}`, label: o === actor ? `Here (${actor.name})` : o.name, col: o.square.col, row: o.square.row }));
      const ans = await askPayer(`${action.name}`)({ kind: 'square', mode: env.world.mode, title: `${action.name} (act from)`, text: 'Perform it from where you stand, or from one of your Copies.', options, minimum: 1, maximum: 1 });
      const id = Array.isArray(ans) ? ans[0] : ans;
      const pick = options.find((o) => o.id === id);
      if (pick && pick.id !== options[0].id) originSquare = { col: pick.col, row: pick.row };
    }
    const lines = [];
    const manual = [];
    const history = { damageDealt: 0, damagedIds: [], challengedIds: [] };
    const frt = fighterRt(env.rt, actor.id);
    const firstAction = !(frt.flags.actions > 0);
    // "Until your next Action" temporaries made before this one end after it.
    env.rt.actionSeq = (env.rt.actionSeq ?? 0) + 1;
    // A Super Move triggers no "before / after an Action" Abilities
    // (`triggersAbilities: false` — phase I); its hits still do.
    const isSuper = placement.kind === 'super';
    const fires = !(isSuper && action.triggersAbilities === false);
    const actionEvent = (ev, payload) => (fires ? emitEvent(env, ev, actor, payload) : null);
    // A Reactive Action (a reaction board — phase F): "before each Reactive Action" (Swift Style).
    if (data.reaction) await actionEvent('self.reactive_action.before', { action });
    await actionEvent('self.action.before', { action });
    await actionEvent('enemy_in_range.action.cost_paid_before_resolution', { action, actor });
    const damaging = hasDamage(action.effect);
    // **Control tokens (phase F, book p.117):** after the cost is paid and
    // before the Action is performed, each enemy whose range it is in may spend
    // Control (once per turn): 1 to Copy it, 2 to Dodge it, 3 to Parry it.
    // A Super Move isn't an Action (`isAction: false`): no Control against it (phase I).
    const control = isSuper ? { parry: null, dodged: [], copiers: [] } : await controlChances(env, actor, action);
    if (control.parry) {
      const p = control.parry;
      lines.push(`${p.name} Parries it: the Action is negated`);
      frt.flags.actions = (frt.flags.actions ?? 0) + 1;
      recordUse(env.rt.usage, action, actor.id);
      const r = await env.world.damage(actor, 2, p, { source: 'ability' });
      lines.push(`${p.name} deals ${r.taken} damage to ${actor.name}`);
      await env.world.move(p, { distance: 2, upTo: true });
      await save();
      return { ok: true, lines, manual, gateRating, action, actor };
    }
    const ctx = {
      world: env.world,
      self: actor,
      state: frt.state,
      usage: env.usage,
      ability: action,
      event: {},
      log: (l) => lines.push(l),
      // (A Mastermind answers for the ally performing it.)
      ask: askPayer(`${action.name}${gateRating ? ` (${gateRating})` : ''}`),
      // Someone else's part of a shared choice (Song Form's "they also choose one").
      askAs: (f) => ask(f, env.key, env.gen, env.tg, `${action.name}${gateRating ? ` (${gateRating})` : ''}`),
      notify: (text) => postCard('reminder', { title: action.name, text, fighters: [{ name: actor.name }], automatic: 'ability_text' }),
      emit: (ev, f, payload, filter) => emitEvent(env, ev, f, payload, 1, filter),
      resolution: { gateRating },
      payment,
      history,
      // Its hits are an Action's (a Super Move's); the board's Power toggle stands in for "Ask"
      // on your own Actions (decided): on = Enhance each hit as far as allowed.
      source: placement.kind === 'super' ? 'super' : 'action',
      // "No token responses" to a Super Move (`allowsTokenResponses: false`): no Iron against its hits.
      unblockable: placement.kind === 'super' && action.allowsTokenResponses === false ? ['iron_tokens'] : [],
      power: data.power ? 'max' : 'none',
      originSquare,
      // Dodged (Control): they're immune to this Action.
      immuneIds: control.dodged,
      // "Your Actions may apply to one extra target within range" (Blaster
      // Form), "your next Action … may apply to one additional target" (Amplify).
      extraTargets: isSuper ? 0 : sumMod(env.world.mods?.(actor) ?? [], 'actions.additional_targets_in_stance_range') + sumMod(env.world.mods?.(actor) ?? [], 'next_action.additional_legal_targets'),
      mustTarget: damaging && actor.challengeId != null ? actor.challengeId : null,
      onUnsupported: (node) => {
        manual.push(describe(node) || node.op);
      },
    };
    // What's moving people right now, for the square picks' titles ("Shove (Push 2)").
    const prevSource = env.source;
    env.source = action.name;
    // Poltergeist tokens spent on it (the Phantom): before, around and after it.
    const polt = isSuper || placement.free || placement.copied ? null : await poltergeist(env, payer, actor, action, payment, askPayer);
    if (polt?.rangeBonus) (ctx.mods ??= []).push({ rule: 'current_action.maximum_range_bonus', value: polt.rangeBonus, targetId: actor.id, ownerId: payer.id, source: POLTERGEIST });
    try {
      for (const pre of polt?.before ?? []) await runRule({ id: `${action.id}:poltergeist`, effect: pre }, ctx);
      await runRule({ id: action.id, effect: polt?.effect ?? action.effect }, ctx);
      for (const post of polt?.after ?? []) await runRule({ id: `${action.id}:poltergeist`, effect: post }, ctx);
      if (polt?.pushPrevious) await pushPrevious(env, actor, history, polt.pushPrevious, askPayer, action);
    } catch (err) {
      manual.push(`the rest (${err.message})`);
    } finally {
      env.source = prevSource;
    }
    frt.flags.actions = (frt.flags.actions ?? 0) + 1;
    // Its limits count it (once per turn …) — for whoever paid, whose list it is on.
    recordUse(env.rt.usage, action, payer.id);
    if (actor !== payer) {
      const prt = fighterRt(env.rt, payer.id);
      prt.flags.actions = (prt.flags.actions ?? 0) + 1;
    }
    // A Super Move: once per fight for them, and one of their side's this Round.
    if (placement.kind === 'super') {
      env.rt.usage[superKey(actor.id)] = (env.rt.usage[superKey(actor.id)] ?? 0) + 1;
      const side = (env.rt.sides ??= {})[actor.side] ??= { supersThisRound: 0 };
      side.supersThisRound = (side.supersThisRound ?? 0) + 1;
    }
    if (actor.challengeId != null && history.damagedIds.includes(actor.challengeId)) frt.flags.damagedChallenger = true;
    // The Action events (engine/bus.js), with what it did (phase G): the
    // enemies it damaged, who it moved by force, whether it moved you.
    const fightersOf = (ids) => [...new Set(ids ?? [])].map((id) => byId(id)).filter(Boolean);
    const forced = fightersOf(history.forcedIds);
    const did = {
      action,
      history,
      enemiesDamaged: fightersOf(history.enemyDamagedIds),
      enemiesForcedMoved: forced.filter((f) => f.side !== actor.side),
      alliesForcedMoved: forced.filter((f) => f.side === actor.side && f.id !== actor.id),
      movedSwappedOrTeleportedSelf: Boolean(history.selfMoved),
      // Who and what it targeted, and the obstacles it destroyed (the QA pass:
      // Crystal, Whip and Explosion Style).
      actionTargets: history.targets ?? [],
      distinctTargetCount: (history.targets ?? []).length,
      enemyTargets: (history.targets ?? []).filter((t) => !t.isObstacle && !t.isCopy && t.side !== actor.side),
      obstaclesDestroyed: history.obstaclesDestroyed ?? [],
    };
    await actionEvent('self.action.resolved', did);
    // "After you Throw or Grapple an enemy" (Whip Style).
    if (THROWS.has(action.id) && did.enemyTargets.length) await actionEvent('self.throw_or_grapple.resolved', did);
    if (placement.kind === 'die') await actionEvent('self.dice_action.resolved', did);
    if (history.damageDealt > 0 || damaging) await actionEvent('self.damage_dealing_action.resolved', did);
    const enemyCount = new Set(history.enemyDamagedIds ?? []).size;
    if (enemyCount) await actionEvent('self.action.damage_dealt_to_enemy', { action, history, enemyCount });
    if (firstAction && fightRow.turn_order && env.rt.turn?.activeId === actor.id) await actionEvent('self.first_action_on_own_turn.resolved', { action });
    await actionEvent('ally.action.resolved', { action, history });
    await actionEvent('any_action.fully_resolved', { action, history });
    expireTemps(env.rt, 'action', { actorId: actor.id });
    if (damaging) expireTemps(env.rt, 'damage_action', { actorId: actor.id });
    // Copied (Control): the copier performs the same Action now, as a
    // Reactive Action, with a 4 for its X and Gates — in this same env.
    for (const c of control.copiers) {
      const copy = await perform(fightRow, { combatant_id: c.id, character_id: c.characterId, data: '{}' }, { results: [{ result: 4 }], extra: [] }, { kind: 'die', die: 0, actionId: action.id, stop: null, copied: true }, env);
      if (copy.ok) lines.push(`${c.name} Copies it${copy.lines.length ? `: ${copy.lines.join('; ')}` : ''}`);
    }
    await save();
    return { ok: true, lines, manual, gateRating, action, actor };
  }

  // Mastermind Style's `delegate_actions`, while its Stance is on and it works.
  function delegates(env, f) {
    if (abilitiesOff(f.id, env.rt.temps) || atZero(f.hp)) return false;
    const idx = patdContent();
    return (f.abilityIds ?? []).some((id) => (idx.get(id)?.rules ?? []).some((r) => r.effect?.op === 'delegate_actions'));
  }

  // **An Action performed by a rule (phase H: `perform_action`)** — Gunkata's
  // Gunslinger Action, the Elder's, the Teacher's: without paying its cost,
  // with `rating` for its Gates and X, in the rule's own env.
  async function performFree(env, fightRow, actor, actionId, rating) {
    return perform(fightRow, { combatant_id: actor.id, character_id: actor.characterId, data: '{}' }, { results: [{ result: rating }], extra: [] }, { kind: 'die', die: 0, actionId, stop: null, free: true }, env);
  }

  // Each enemy in range holding Control is asked once per turn: Copy (1),
  // Dodge (2) — themselves or an ally in their range — or Parry (3).
  // → { parry: fighter | null, dodged: [id], copiers: [fighter] }
  async function controlChances(env, actor, action) {
    const out = { parry: null, dodged: [], copiers: [] };
    const onceAction = (action.limits ?? []).some((l) => l.period === 'turn' && l.maximum === 1);
    for (const e of env.world.enemiesOf(actor)) {
      const held = e.tokens.control ?? 0;
      const frt = fighterRt(env.rt, e.id);
      if (!held || frt.flags.controlUsed || !e.square || !actor.square || !env.world.inRange(e, actor, { mode: 'stance' })) continue;
      const options = [{ id: 'none', label: 'Let it happen' }];
      // "It only costs you 1 Control Token to Dodge an Action" (The Untouchable).
      const dodge = Math.max(1, Number(valueOf(env.world.mods?.(e) ?? [], 'control.dodge_cost', 2)) || 2);
      if (held >= 1 && !onceAction) options.push({ id: 'copy', label: 'Copy it (1 Control)' });
      if (held >= dodge) options.push({ id: 'dodge', label: `Dodge it (${dodge} Control)` });
      if (held >= 3) options.push({ id: 'parry', label: 'Parry it (3 Control)' });
      if (options.length === 1) continue;
      const ans = await ask(e, env.key, env.gen, env.tg, `${actor.name}: ${action.name}`)({ kind: 'choose', title: 'Control', text: `${actor.name} is about to perform ${action.name}.`, options, minimum: 1, maximum: 1 });
      const pick = Array.isArray(ans) ? ans[0] : ans;
      if (!pick || pick === 'none') continue;
      const cost = { copy: 1, dodge, parry: 3 }[pick];
      await env.world.discardTokens(e, ['control'], cost);
      frt.flags.controlUsed = true;
      // `controlledActor`: "the enemy whose Action you Controlled" (Control Form, Grave Freestyle).
      await emitEvent(env, 'self.control_tokens_spent', e, { amount: cost, action, controlledActor: actor });
      if (pick === 'parry') {
        out.parry = e;
        return out;
      }
      if (pick === 'copy') out.copiers.push(e);
      if (pick === 'dodge') {
        const who = env.world.alliesOf(e).filter((a) => a.id === e.id || (a.square && env.world.inRange(e, a, { mode: 'stance' })));
        const a2 = who.length > 1 ? await ask(e, env.key, env.gen, env.tg, `${action.name}`)({ kind: 'targets', title: 'Dodge', text: 'Who becomes immune to it?', options: who.map((a) => ({ id: String(a.id), label: a.name })), minimum: 1, maximum: 1 }) : [String(e.id)];
        const id = Number(Array.isArray(a2) ? a2[0] : a2) || e.id;
        out.dodged.push(id);
      }
    }
    return out;
  }

  // **Commit:** every uncommitted placement, in order, without stopping
  // (decided, revised: no reaction windows — whoever can interrupt has an
  // Interrupt button instead; server/fights.js `interrupt:offers`).
  async function commitBoard(rollId) {
    // The resolve stack (batch 5): every placed Action is a step, queued up front.
    const stepOf = new Map(); // placement key → step id
    let stackKey = null;
    const finish = () => {
      for (const id of stepOf.values()) kit.steps?.remove(stackKey, id, { silent: true });
    };
    for (let guard = 0; guard < 40; guard++) {
      const { row, fight } = await fightOfBoard(rollId);
      if (!row?.active || !fight) return finish();
      const data = readData(row);
      data.paused = false;
      stackKey = `${fight.scene_id}:${fight.mode}`;
      for (const p of (data.placements ?? []).filter((x) => !x.committed)) {
        if (!stepOf.has(p.key)) stepOf.set(p.key, kit.steps?.add(stackKey, patdContent().get(p.actionId)?.name ?? 'Action', 'queued', { silent: true }));
      }
      const next = (data.placements ?? []).find((p) => !p.committed);
      if (next) kit.steps?.set(stackKey, stepOf.get(next.key), 'now');
      const stepDone = (state) => {
        const id = stepOf.get(next.key);
        stepOf.delete(next.key);
        if (state) kit.steps?.set(stackKey, id, state);
        else kit.steps?.remove(stackKey, id);
      };
      if (!next) {
        data.committing = false;
        await saveQ(rollId, data);
        // A reaction board is done after its one Reactive Action.
        if (data.reaction && (data.placements ?? []).some((p) => p.committed)) await kit.reactionDone?.(fight, row);
        return;
      }
      data.committing = true;
      await saveQ(rollId, data);
      // Snapshot first, with the board's pool as it was (added numbers come back too).
      const snap = await takeSnapshot(fight.id);
      const ins = await queued(() =>
        run('INSERT INTO fight_snapshots (fight_id, roll_id, placement_key, data) VALUES (?, ?, ?, ?)', [fight.id, rollId, next.key, JSON.stringify({ ...snap, board: { extra: data.extra ?? [], results: data.results ?? [] } })])
      );
      const result = await perform(fight, row, data, next);
      const after = readData(await one('SELECT * FROM dice_marks WHERE roll_id = ?', [rollId]));
      const p = (after.placements ?? []).find((x) => x.key === next.key);
      if (!result.ok && result.cancelled) {
        // Declined at "no valid targets": off the board, its dice free again; the rest go on.
        await queued(() => run('DELETE FROM fight_snapshots WHERE id = ?', [Number(ins?.lastInsertRowid)]));
        after.placements = (after.placements ?? []).filter((x) => x.key !== next.key);
        after.committing = after.placements.some((x) => !x.committed);
        await saveQ(rollId, after);
        stepDone(null);
        continue;
      }
      if (!result.ok) {
        // Not performed (could not pay): stays placed; the batch stops.
        await queued(() => run('DELETE FROM fight_snapshots WHERE id = ?', [Number(ins?.lastInsertRowid)]));
        after.committing = false;
        await saveQ(rollId, after);
        await postCard('reminder', { title: result.action?.name ?? 'Action', text: `Not performed: ${result.error}.`, fighters: [], automatic: 'action' });
        return finish();
      }
      if (p) {
        p.committed = true;
        p.snapshot = Number(ins?.lastInsertRowid);
        p.summary = [...result.lines].join('; ');
      }
      const remaining = (after.placements ?? []).some((x) => !x.committed);
      after.committing = remaining;
      const gate = result.gateRating ? ` · ${result.gateRating}` : '';
      const text = [result.lines.length ? `${result.lines.join('; ')}.` : 'Done.', result.manual.length ? `By hand: ${result.manual.join('; ')}.` : ''].filter(Boolean).join(' ');
      await postCard('reminder', {
        title: `${result.action.name}${gate}`,
        text,
        fighters: [{ name: result.actor.name }],
        automatic: result.manual.length ? 'action_manual' : 'action',
        notice: !result.manual.length,
      });
      await saveQ(rollId, after);
      await emitStageUpdated();
      stepDone('done');
    }
    finish();
  }

  // **Retrieve (GM):** back to just before that placement's Action.
  async function retrieve(rollId, key) {
    const { row, fight } = await fightOfBoard(rollId);
    if (!row || !fight) return;
    const data = readData(row);
    const i = (data.placements ?? []).findIndex((p) => p.key === key);
    const p = data.placements?.[i];
    if (!p?.committed || p.snapshot == null) return;
    const snapRow = await one('SELECT * FROM fight_snapshots WHERE id = ?', [p.snapshot]);
    if (!snapRow) return;
    const snap = JSON.parse(snapRow.data);
    await queued(() => restoreSnapshot(snap));
    // That placement and every later committed one go back to placed (grey).
    const later = data.placements.slice(i).filter((x) => x.committed);
    for (const x of data.placements.slice(i)) {
      x.committed = false;
      x.snapshot = null;
      x.summary = null;
    }
    data.extra = snap.board?.extra ?? data.extra ?? [];
    // Rerolled, changed or taken-out numbers come back too (phase H).
    if (snap.board?.results) data.results = snap.board.results;
    data.paused = false;
    data.committing = false;
    await queued(() => run('DELETE FROM fight_snapshots WHERE fight_id = ? AND id >= ?', [fight.id, p.snapshot]));
    await saveQ(rollId, data);
    await postCard('reminder', {
      title: 'Retrieved',
      text: `The GM retrieved ${later.length} Action${later.length === 1 ? '' : 's'} (${later.map((x) => patdContent().get(x.actionId)?.name ?? x.actionId).join(', ')}): everything they did is undone.`,
      fighters: [],
      automatic: 'retrieve',
    });
    await emitStageUpdated();
  }

  // A number added to a fighter's Action Pool (add_pool_number): onto their active board.
  async function addPoolNumber(combatantId, value, source) {
    const r = await one('SELECT * FROM dice_marks WHERE combatant_id = ? AND active = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1', [combatantId]);
    if (!r) return false;
    const data = readData(r);
    data.extra = [...(data.extra ?? []), { value: Number(value) || 0, source }];
    await queued(() => saveBoard(r.roll_id, data, emit));
    return true;
  }

  // **The Action Pool changed by an Ability (phase H):** `change(data)` on the
  // fighter's active board, read and saved in one queued step. → the new data.
  async function changePool(combatantId, change) {
    let out = null;
    await queued(async () => {
      const r = await one('SELECT * FROM dice_marks WHERE combatant_id = ? AND active = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1', [combatantId]);
      if (!r) return;
      const data = readData(r);
      change(data);
      await saveBoard(r.roll_id, data, emit);
      out = data;
    });
    return out;
  }

  return { commitBoard, retrieve, addPoolNumber, changePool, performFree, fightOfBoard };
}

