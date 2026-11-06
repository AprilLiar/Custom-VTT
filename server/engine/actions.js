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
import { readData, saveBoard, fighterState } from '../diceMarks.js';
import { restoreSnapshot, takeSnapshot } from './snapshots.js';

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
    const state = await fighterState(row.combatant_id);
    if (!state) return { error: 'no fighter' };
    const plan = planPayment(action, placement.option, placement.answers, state);
    if (plan.error) return plan;
    await queued(async () => {
      const cur = await one('SELECT * FROM combatants WHERE id = ?', [row.combatant_id]);
      const tokens = { ...shapeFightState(cur).tokens };
      for (const [k, n] of Object.entries(plan.tokens)) tokens[k] = (tokens[k] ?? 0) - n;
      if (plan.shield) tokens.shield = (tokens.shield ?? 0) - plan.shield;
      for (const k of Object.keys(tokens)) if (!(tokens[k] > 0)) delete tokens[k];
      await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(tokens), row.combatant_id]);
      if (plan.hp) await saveHp(row.combatant_id, applyHpDelta(hpOf(cur), -plan.hp).state);
      if (plan.holderId != null) await run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [plan.holderId, row.combatant_id]);
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
  async function perform(fightRow, row, data, placement) {
    const idx = patdContent();
    const action = idx.get(placement.actionId);
    const { env, byId } = await envFor(fightRow);
    const actor = byId(row.combatant_id);
    if (!action || !actor) return { ok: false, error: 'the fighter or the Action is gone' };
    let payment;
    if (placement.kind === 'die') {
      const n = poolOf(data).find((p) => p.index === placement.die);
      payment = { rating: n?.value ?? 0, poolNumbers: [n?.value ?? 0], isDice: true };
    } else {
      payment = await payTokens(row, action, placement);
      if (payment.error) return { ok: false, error: payment.error };
      await emitEvent(env, 'self.token_action.pay_cost', actor, { action });
    }
    if (payment.hp) await emitEvent(env, 'self.hp_paid', actor, { amount: payment.hp });
    await emitEvent(env, 'self.action.cost_paid', actor, { action, rating: payment.rating });
    const gateRating = placement.stop ?? payment.rating;
    const lines = [];
    const manual = [];
    const history = { damageDealt: 0, damagedIds: [], challengedIds: [] };
    const frt = fighterRt(env.rt, actor.id);
    const firstAction = !(frt.flags.actions > 0);
    await emitEvent(env, 'self.action.before', actor, { action });
    const damaging = hasDamage(action.effect);
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
      emit: (ev, f, payload) => emitEvent(env, ev, f, payload, 1),
      resolution: { gateRating },
      payment,
      history,
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
    if (actor.challengeId != null && history.damagedIds.includes(actor.challengeId)) frt.flags.damagedChallenger = true;
    // The Action events (engine/bus.js).
    await emitEvent(env, 'self.action.resolved', actor, { action, history });
    if (placement.kind === 'die') await emitEvent(env, 'self.dice_action.resolved', actor, { action, history });
    if (history.damageDealt > 0 || damaging) await emitEvent(env, 'self.damage_dealing_action.resolved', actor, { action, history });
    if (firstAction && fightRow.turn_order && env.rt.turn?.activeId === actor.id) await emitEvent(env, 'self.first_action_on_own_turn.resolved', actor, { action });
    await emitEvent(env, 'ally.action.resolved', actor, { action, history });
    await emitEvent(env, 'any_action.fully_resolved', actor, { action, history });
    expireTemps(env.rt, 'action', { actorId: actor.id });
    if (damaging) expireTemps(env.rt, 'damage_action', { actorId: actor.id });
    await env.save();
    return { ok: true, lines, manual, gateRating, action, actor };
  }

  // **Commit:** every uncommitted placement, in order; pauses for reactions
  // between Actions (decided) when someone could react.
  async function commitBoard(rollId) {
    for (let guard = 0; guard < 40; guard++) {
      const { row, fight } = await fightOfBoard(rollId);
      if (!row?.active || !fight) return;
      const data = readData(row);
      data.paused = false;
      const next = (data.placements ?? []).find((p) => !p.committed);
      if (!next) {
        data.committing = false;
        return saveQ(rollId, data);
      }
      data.committing = true;
      await saveQ(rollId, data);
      // Snapshot first, with the board's pool as it was (added numbers come back too).
      const snap = await takeSnapshot(fight.id);
      const ins = await queued(() =>
        run('INSERT INTO fight_snapshots (fight_id, roll_id, placement_key, data) VALUES (?, ?, ?, ?)', [fight.id, rollId, next.key, JSON.stringify({ ...snap, board: { extra: data.extra ?? [] } })])
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
      // A pause for reactions between Actions (decided: until Continue).
      if (remaining && (await kit.reactionsAvailable(fight, row.combatant_id))) {
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

  return { commitBoard, retrieve, addPoolNumber, fightOfBoard };
}

