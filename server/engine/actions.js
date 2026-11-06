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
import { describe, runRule } from '../../client/src/lib/patd/interpreter.js';
import { poolOf } from '../../client/src/lib/patd/diceBoard.js';
import { planPayment } from '../../client/src/lib/patd/tokenCost.js';
import { expireTemps, fighterRt } from '../../client/src/lib/patd/engine/runtime.js';
import { hpOf, saveHp, shapeFightState } from '../combatState.js';
import { patdContent } from '../patdContent.js';
import { actingOn, readData, saveBoard, fighterState } from '../diceMarks.js';
import { restoreSnapshot, takeSnapshot } from './snapshots.js';
import { recordUse } from '../../client/src/lib/patd/engine/turn.js';

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
  async function payTokens(row, action, placement) {
    const actorId = actingOn(row).combatantId;
    const state = await fighterState(actorId);
    if (!state) return { error: 'no fighter' };
    const plan = planPayment(action, placement.option, placement.answers, state);
    if (plan.error) return plan;
    await queued(async () => {
      const cur = await one('SELECT * FROM combatants WHERE id = ?', [actorId]);
      const tokens = { ...shapeFightState(cur).tokens };
      for (const [k, n] of Object.entries(plan.tokens)) tokens[k] = (tokens[k] ?? 0) - n;
      if (plan.shield) tokens.shield = (tokens.shield ?? 0) - plan.shield;
      for (const k of Object.keys(tokens)) if (!(tokens[k] > 0)) delete tokens[k];
      await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(tokens), actorId]);
      if (plan.hp) await saveHp(actorId, applyHpDelta(hpOf(cur), -plan.hp).state);
      if (plan.holderId != null) await run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [plan.holderId, actorId]);
    });
    return {
      rating: plan.rating,
      tokens: plan.tokens,
      hp: plan.hp,
      destroyedShieldValue: plan.shield,
      challengeHolder: plan.holderId,
      isToken: true,
    };
  }

  // One placed Action, resolved. → { ok, lines, manual, error }
  // `envIn`: run inside a job's own env (an Action performed by a rule —
  // phase H); that job saves the runtime, not this.
  async function perform(fightRow, row, data, placement, envIn = null) {
    const idx = patdContent();
    const action = idx.get(placement.actionId);
    const { env, byId } = envIn ? { env: envIn, byId: (id) => envIn.world.fighters().find((f) => f.id === id) } : await envFor(fightRow);
    const save = () => (envIn ? null : env.save());
    const actor = byId(actingOn(row).combatantId);
    if (!action || !actor) return { ok: false, error: 'the fighter or the Action is gone' };
    let payment;
    if (placement.kind === 'die') {
      const n = poolOf(data).find((p) => p.index === placement.die);
      payment = { rating: n?.value ?? 0, poolNumbers: [n?.value ?? 0], isDice: true };
      // A Chaos token spent "as if you had spent a 4" (once per turn — phase F).
      if (n?.source === 'chaos') {
        if (fighterRt(env.rt, actor.id).flags.chaosUsed || !((actor.tokens.chaos ?? 0) > 0)) return { ok: false, error: 'no Chaos token to spend (once per turn)', action };
        await env.world.discardTokens(actor, ['chaos'], 1);
        fighterRt(env.rt, actor.id).flags.chaosUsed = true;
      }
    } else {
      payment = await payTokens(row, action, placement);
      if (payment.error) return { ok: false, error: payment.error };
      await emitEvent(env, 'self.token_action.pay_cost', actor, { action });
    }
    if (payment.hp) await emitEvent(env, 'self.hp_paid', actor, { amount: payment.hp });
    await emitEvent(env, 'self.action.cost_paid', actor, { action, rating: payment.rating });
    const gateRating = placement.stop ?? payment.rating;
    // **Acting from a Copy (phase E, book p.71):** with Copies on the board the
    // Original picks where the Action is performed from; its ranges count from there.
    let originSquare = null;
    const own = (env.world.copies?.() ?? []).filter((c) => c.ownerId === actor.id && c.square);
    if (own.length && actor.square) {
      const options = [actor, ...own].map((o) => ({ id: `${o.square.col},${o.square.row}`, label: o === actor ? `Here (${actor.name})` : o.name, col: o.square.col, row: o.square.row }));
      const ans = await ask(actor, env.key, env.gen, env.tg, `${action.name}`)({ kind: 'square', mode: env.world.mode, title: `${action.name}: act from`, text: 'Perform it from where you stand, or from one of your Copies.', options, minimum: 1, maximum: 1 });
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
    // A Reactive Action (a reaction board — phase F): "before each Reactive Action" (Swift Style).
    if (data.reaction) await emitEvent(env, 'self.reactive_action.before', actor, { action });
    await emitEvent(env, 'self.action.before', actor, { action });
    await emitEvent(env, 'enemy_in_range.action.cost_paid_before_resolution', actor, { action, actor });
    const damaging = hasDamage(action.effect);
    // **Control tokens (phase F, book p.117):** after the cost is paid and
    // before the Action is performed, each enemy whose range it is in may spend
    // Control (once per turn): 1 to Copy it, 2 to Dodge it, 3 to Parry it.
    const control = await controlChances(env, actor, action);
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
      ask: ask(actor, env.key, env.gen, env.tg, `${action.name}${gateRating ? ` (${gateRating})` : ''}`),
      notify: (text) => postCard('reminder', { title: action.name, text, fighters: [{ name: actor.name }], automatic: 'ability_text' }),
      emit: (ev, f, payload, filter) => emitEvent(env, ev, f, payload, 1, filter),
      resolution: { gateRating },
      payment,
      history,
      // Its hits are an Action's; the board's Power toggle stands in for "Ask"
      // on your own Actions (decided): on = Enhance each hit as far as allowed.
      source: 'action',
      power: data.power ? 'max' : 'none',
      originSquare,
      // Dodged (Control): they're immune to this Action.
      immuneIds: control.dodged,
      mustTarget: damaging && actor.challengeId != null ? actor.challengeId : null,
      onUnsupported: (node) => {
        manual.push(describe(node) || node.op);
      },
    };
    try {
      await runRule({ id: action.id, effect: action.effect }, ctx);
    } catch (err) {
      manual.push(`the rest (${err.message})`);
    }
    frt.flags.actions = (frt.flags.actions ?? 0) + 1;
    // Its limits count it (once per turn …).
    recordUse(env.rt.usage, action, actor.id);
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
    };
    await emitEvent(env, 'self.action.resolved', actor, did);
    if (placement.kind === 'die') await emitEvent(env, 'self.dice_action.resolved', actor, did);
    if (history.damageDealt > 0 || damaging) await emitEvent(env, 'self.damage_dealing_action.resolved', actor, did);
    const enemyCount = new Set(history.enemyDamagedIds ?? []).size;
    if (enemyCount) await emitEvent(env, 'self.action.damage_dealt_to_enemy', actor, { action, history, enemyCount });
    if (firstAction && fightRow.turn_order && env.rt.turn?.activeId === actor.id) await emitEvent(env, 'self.first_action_on_own_turn.resolved', actor, { action });
    await emitEvent(env, 'ally.action.resolved', actor, { action, history });
    await emitEvent(env, 'any_action.fully_resolved', actor, { action, history });
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
      if (held >= 1 && !onceAction) options.push({ id: 'copy', label: 'Copy it (1 Control)' });
      if (held >= 2) options.push({ id: 'dodge', label: 'Dodge it (2 Control)' });
      if (held >= 3) options.push({ id: 'parry', label: 'Parry it (3 Control)' });
      if (options.length === 1) continue;
      const ans = await ask(e, env.key, env.gen, env.tg, `${actor.name}: ${action.name}`)({ kind: 'choose', title: 'Control', text: `${actor.name} is about to perform ${action.name}.`, options, minimum: 1, maximum: 1 });
      const pick = Array.isArray(ans) ? ans[0] : ans;
      if (!pick || pick === 'none') continue;
      const cost = { copy: 1, dodge: 2, parry: 3 }[pick];
      await env.world.discardTokens(e, ['control'], cost);
      frt.flags.controlUsed = true;
      await emitEvent(env, 'self.control_tokens_spent', e, { amount: cost, action });
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

  // **Commit:** every uncommitted placement, in order; pauses for reactions
  // between Actions (decided) when someone could react.
  async function commitBoard(rollId) {
    // The active fighter acting again (or Continue) closes the last reaction window.
    {
      const { row, fight } = await fightOfBoard(rollId);
      if (row && fight && !readData(row).reaction) await kit.closeReactions?.(fight);
    }
    for (let guard = 0; guard < 40; guard++) {
      const { row, fight } = await fightOfBoard(rollId);
      if (!row?.active || !fight) return;
      const data = readData(row);
      data.paused = false;
      const next = (data.placements ?? []).find((p) => !p.committed);
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
      if (!result.ok) {
        // Not performed (could not pay): stays placed; the batch stops.
        await queued(() => run('DELETE FROM fight_snapshots WHERE id = ?', [Number(ins?.lastInsertRowid)]));
        after.committing = false;
        await saveQ(rollId, after);
        await postCard('reminder', { title: result.action?.name ?? 'Action', text: `Not performed: ${result.error}.`, fighters: [], automatic: 'action' });
        return;
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
      // After each of the active fighter's Actions, everyone else may react
      // (book p.67); between Actions the batch pauses until Continue (decided),
      // but only when someone actually can.
      const canReact = !after.reaction && (await kit.openReactions?.(fight, actingOn(row).combatantId));
      if (remaining && canReact) {
        after.paused = true;
        after.committing = false;
        await saveQ(rollId, after);
        await emitStageUpdated();
        return;
      }
      await saveQ(rollId, after);
      await emitStageUpdated();
    }
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

