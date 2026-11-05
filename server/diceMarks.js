// **The turn's dice board marks (vttprojectplan.md, "Action cards and the
// dice board").** Which of a Stance roll's dice are crossed out, and which
// Action each one was laid on — purely visual, shared with everyone (the chat
// card shows the crossed dice) and kept for the turn (closing and reopening
// the board shows the same state). One row per Stance roll.
//
// A roll's marks are editable only while it is `active`: from the roll until
// that fighter's turn ends (Next / Previous turn, End Combat). After that
// they stay as they were, read-only, on the old chat card.
import { all, one, run } from './db.js';
import { cleanMarks } from '../client/src/lib/patd/diceBoard.js';
import { paymentText, planPayment } from '../client/src/lib/patd/tokenCost.js';
import { capOf } from '../client/src/lib/panicTokens.js';
import { applyHpDelta } from '../client/src/lib/hpBars.js';
import { controlsCharacter } from './control.js';
import { hpOf, saveHp, serialized, shapeFightState } from './combatState.js';
import { patdContent } from './patdContent.js';
import { derivedFor } from './fighterStances.js';
import { turnActions } from '../client/src/lib/patd/diceBoard.js';
import { stanceOfBuild } from '../client/src/lib/patd/build.js';

const KEEP = 300;
const shape = (r) => {
  let d = {};
  try {
    d = JSON.parse(r.data || '{}');
  } catch {
    d = {};
  }
  return { rollId: r.roll_id, used: d.used ?? [], assign: d.assign ?? {}, pay: publicPay(d.pay), active: Boolean(r.active) };
};
const readData = (r) => {
  try {
    return JSON.parse(r.data || '{}');
  } catch {
    return {};
  }
};
// What everyone sees of a payment (the HP snapshots stay on the server).
// `amount`: how many tokens / HP / Shield it took (lights "5 Iron: …" Gates).
const publicPay = (pay) =>
  Object.fromEntries(
    Object.entries(pay ?? {}).map(([id, p]) => [
      id,
      { option: p.option, rating: p.rating, text: p.text, amount: Object.values(p.tokens ?? {}).reduce((a, b) => a + b, 0) + (p.hp ?? 0) + (p.shield ?? 0) },
    ])
  );

// A new Stance roll: its (empty) marks, the only active ones for that fighter.
export async function startRoll({ rollId, combatantId, characterId, dice, stanceKey = null }, emit) {
  await endTurnDice([combatantId], emit);
  await run('INSERT INTO dice_marks (roll_id, combatant_id, character_id, dice, data, active) VALUES (?, ?, ?, ?, ?, 1)', [
    rollId,
    combatantId,
    characterId,
    dice,
    JSON.stringify({ used: [], assign: {}, stanceKey }),
  ]);
  await run(`DELETE FROM dice_marks WHERE roll_id NOT IN (SELECT roll_id FROM dice_marks ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP})`);
  emit?.('dice:marks', { rollId, used: [], assign: {}, pay: {}, active: true });
}

// Those fighters' turns ended: their rolls' marks freeze.
export async function endTurnDice(combatantIds, emit) {
  for (const id of combatantIds) {
    const rows = await all('SELECT * FROM dice_marks WHERE combatant_id = ? AND active = 1', [id]);
    if (!rows.length) continue;
    await run('UPDATE dice_marks SET active = 0 WHERE combatant_id = ? AND active = 1', [id]);
    for (const r of rows) emit?.('dice:marks', { ...shape(r), active: false });
  }
}

// Previous turn stepped back onto this fighter: their latest roll is live again.
export async function resumeRoll(combatantId, emit) {
  const r = await one('SELECT * FROM dice_marks WHERE combatant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [combatantId]);
  if (!r || r.active) return;
  await run('UPDATE dice_marks SET active = 1 WHERE roll_id = ?', [r.roll_id]);
  emit?.('dice:marks', { ...shape(r), active: true });
}

// **A fighter's payable state** (tokenCost.js): tokens, current HP, Shield,
// and the enemies in their fight holding their Challenge.
export async function fighterState(combatantId) {
  const row = await one('SELECT * FROM combatants WHERE id = ?', [Number(combatantId)]);
  if (!row) return null;
  const st = shapeFightState(row);
  const fight = await one('SELECT allies, enemies FROM fights WHERE scene_id = ? AND mode = ?', [row.scene_id, row.mode]);
  let foes = [];
  if (fight) {
    const allies = JSON.parse(fight.allies || '[]');
    const enemies = JSON.parse(fight.enemies || '[]');
    foes = allies.includes(row.id) ? enemies : enemies.includes(row.id) ? allies : [];
  }
  const holders = foes.length
    ? await all(
        `SELECT cb.id, COALESCE(c.name, 'Fighter') AS name FROM combatants cb LEFT JOIN characters c ON c.id = cb.character_id
         WHERE cb.challenge_id = ? AND cb.id IN (${foes.map(() => '?').join(',')})`,
        [row.id, ...foes]
      )
    : [];
  return { row, tokens: { ...st.tokens }, hp: st.hp.current ?? 0, shield: st.tokens.shield ?? 0, challengeHolders: holders.map((h) => ({ id: h.id, name: h.name })) };
}

// { rollId → { used, assign, pay, active } } for the recent rolls.
export async function listMarks() {
  const rows = await all(`SELECT * FROM dice_marks ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP}`);
  return Object.fromEntries(rows.map((r) => [r.roll_id, shape(r)]));
}

// deps: on, socket, io, emitStageUpdated, postCard
export function registerDiceMarkHandlers({ on: onRaw, socket, io, emitStageUpdated = async () => {}, postCard = async () => {} }) {
  // Payments write tokens and HP, so they go through the server-wide queue.
  const on = (event, handler) => onRaw(event, serialized(handler));
  const editableRoll = async (rollId) => {
    const row = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [String(rollId ?? '')]);
    if (!row?.active) return null;
    const v = socket.data.identity;
    return v?.role === 'gm' || controlsCharacter(v, row.character_id) ? row : null;
  };
  const save = async (row, data) => {
    await run('UPDATE dice_marks SET data = ? WHERE roll_id = ?', [JSON.stringify(data), row.roll_id]);
    io.emit('dice:marks', { rollId: row.roll_id, used: data.used ?? [], assign: data.assign ?? {}, pay: publicPay(data.pay), active: true });
  };

  // **Pay an Action's token cost (decided).** Checked against the fighter's
  // live state, applied, and recorded so tapping the Action again undoes it.
  on('dice:pay', async ({ rollId, actionId, option, answers }) => {
    const row = await editableRoll(rollId);
    if (!row) return;
    const data = readData(row);
    if (data.pay?.[actionId]) return;
    const action = patdContent().get(String(actionId));
    const state = await fighterState(row.combatant_id);
    if (!action || !state) return;
    // Only an Action this turn can use (Basic, the rolled Stance's, always available).
    const idx = patdContent();
    const d = await derivedFor(row.character_id);
    const t = turnActions(d, stanceOfBuild(d, data.stanceKey, idx), idx);
    if (![...t.basic, ...t.personal.flatMap((g) => g.ids)].includes(action.id)) return;
    const plan = planPayment(action, Number(option), answers, state);
    if (plan.error) return socket.emit('dice:pay_failed', { rollId: row.roll_id, actionId, error: plan.error });
    const tokens = { ...state.tokens };
    for (const [k, n] of Object.entries(plan.tokens)) tokens[k] = (tokens[k] ?? 0) - n;
    if (plan.shield) tokens.shield = (tokens.shield ?? 0) - plan.shield;
    for (const k of Object.keys(tokens)) if (!(tokens[k] > 0)) delete tokens[k];
    await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(tokens), row.combatant_id]);
    let hpBefore = null;
    let hpAfter = null;
    if (plan.hp) {
      hpBefore = hpOf(state.row);
      hpAfter = applyHpDelta(hpBefore, -plan.hp).state;
      await saveHp(row.combatant_id, hpAfter);
    }
    if (plan.holderId != null) await run('UPDATE combatants SET challenge_id = NULL WHERE id = ? AND challenge_id = ?', [plan.holderId, row.combatant_id]);
    const text = paymentText(plan);
    data.pay = { ...(data.pay ?? {}), [action.id]: { option: Number(option), ...plan, text, hpBefore, hpAfter } };
    await save(row, data);
    await postCard('reminder', { title: action.name, text: `Paid ${text}.`, fighters: [], automatic: 'payment', notice: true });
    await emitStageUpdated();
  });

  // Tapping a paid Action again: the payment is undone in full.
  on('dice:unpay', async ({ rollId, actionId }) => {
    const row = await editableRoll(rollId);
    if (!row) return;
    const data = readData(row);
    const p = data.pay?.[actionId];
    if (!p) return;
    const cur = await one('SELECT * FROM combatants WHERE id = ?', [row.combatant_id]);
    if (cur) {
      const tokens = { ...shapeFightState(cur).tokens };
      for (const [k, n] of Object.entries(p.tokens ?? {})) tokens[k] = Math.min(capOf(k), (tokens[k] ?? 0) + n);
      if (p.shield) tokens.shield = Math.min(capOf('shield'), (tokens.shield ?? 0) + p.shield);
      await run('UPDATE combatants SET tokens = ? WHERE id = ?', [JSON.stringify(tokens), cur.id]);
      if (p.hp) {
        // Untouched since: back exactly as it was (a bar broken by the cost
        // comes back too); otherwise give the HP back.
        const now = hpOf(cur);
        const same = p.hpAfter && JSON.stringify(now) === JSON.stringify(p.hpAfter);
        await saveHp(cur.id, same ? p.hpBefore : applyHpDelta(now, p.hp).state);
      }
      if (p.holderId != null) await run('UPDATE combatants SET challenge_id = ? WHERE id = ? AND challenge_id IS NULL', [cur.id, p.holderId]);
    }
    const { [actionId]: _drop, ...rest } = data.pay;
    data.pay = rest;
    await save(row, data);
    await emitStageUpdated();
  });

  // The board's whole state for one roll, from whoever controls the fighter (or the GM).
  on('dice:mark', async ({ rollId, used, assign }) => {
    const row = await editableRoll(rollId);
    if (!row) return;
    const clean = cleanMarks({ used, assign }, row.dice);
    // The dice only — payments are kept as they are.
    await save(row, { ...readData(row), ...clean });
  });
}
