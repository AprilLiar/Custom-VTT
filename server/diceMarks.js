// **The turn board (full automation, phase B — vttprojectplan.md, "Full
// automation").** One row per Stance roll (`dice_marks`): the roll's results,
// numbers added to the pool, and the **placements** — dice and token payments
// laid on Actions, in the order they were placed (client/src/lib/patd/diceBoard.js).
//
// Placing is free to change until **Commit**: the engine (server/engine/
// actions.js) then performs the placed Actions in order, each after a
// snapshot; committed placements are locked, and only the GM can retrieve
// one — which undoes it and every later one (decided).
//
// A roll's board is editable only while it is `active`: from the roll until
// that fighter's turn ends (Next / Previous turn, End Combat).
import { all, one, run } from './db.js';
import { gateFor, minusReserved, poolOf, publicBoard, reservedBy, stopChoices, turnActions } from '../client/src/lib/patd/diceBoard.js';
import { hasDiceCost, paymentText, planPayment, tokenOptions } from '../client/src/lib/patd/tokenCost.js';
import { controlsCharacter } from './control.js';
import { serialized, shapeFightState } from './combatState.js';
import { patdContent } from './patdContent.js';
import { derivedFor } from './fighterStances.js';
import { stanceOfBuild } from '../client/src/lib/patd/build.js';
import { spendPrefs } from '../client/src/lib/patd/engine/damage.js';

const KEEP = 300;
export const readData = (r) => {
  try {
    const d = JSON.parse(r?.data || '{}');
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
};
const shape = (r) => publicBoard(r.roll_id, readData(r), r.active);

// Saves a board and tells everyone.
export async function saveBoard(rollId, data, emit) {
  await run('UPDATE dice_marks SET data = ? WHERE roll_id = ?', [JSON.stringify(data), rollId]);
  const row = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [rollId]);
  if (row) emit?.('dice:marks', shape(row));
}

// A new Stance roll: its (empty) board, the only active one for that fighter.
// The Power toggle starts on when the character's Power setting is Auto
// (decided: NPCs by default), off for Ask and Never.
export async function startRoll({ rollId, combatantId, characterId, results = [], stanceKey = null }, emit) {
  await endTurnDice([combatantId], emit);
  const ch = characterId != null ? await one('SELECT character_type FROM characters WHERE id = ?', [characterId]) : null;
  const d = characterId != null ? await derivedFor(characterId) : null;
  const power = spendPrefs(d?.build?.prefs, ch?.character_type === 'npc').power === 'auto';
  const data = { stanceKey, results, extra: [], placements: [], power, paused: false, committing: false };
  await run('INSERT INTO dice_marks (roll_id, combatant_id, character_id, dice, data, active) VALUES (?, ?, ?, ?, ?, 1)', [
    rollId,
    combatantId,
    characterId,
    results.length,
    JSON.stringify(data),
  ]);
  await run(`DELETE FROM dice_marks WHERE roll_id NOT IN (SELECT roll_id FROM dice_marks ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP})`);
  emit?.('dice:marks', publicBoard(rollId, data, true));
}

// Those fighters' turns ended: their boards freeze.
export async function endTurnDice(combatantIds, emit) {
  for (const id of combatantIds) {
    const rows = await all('SELECT * FROM dice_marks WHERE combatant_id = ? AND active = 1', [id]);
    if (!rows.length) continue;
    await run('UPDATE dice_marks SET active = 0 WHERE combatant_id = ? AND active = 1', [id]);
    for (const r of rows) emit?.('dice:marks', { ...shape(r), active: false });
  }
}

// Previous turn stepped back onto this fighter: their latest board is live again.
export async function resumeRoll(combatantId, emit) {
  const r = await one('SELECT * FROM dice_marks WHERE combatant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [combatantId]);
  if (!r || r.active) return;
  await run('UPDATE dice_marks SET active = 1 WHERE roll_id = ?', [r.roll_id]);
  emit?.('dice:marks', { ...shape(r), active: true });
}

// The fighter's active board, if any (numbers added to the pool land there).
export const activeBoardOf = (combatantId) => one('SELECT * FROM dice_marks WHERE combatant_id = ? AND active = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1', [combatantId]);

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

// The fighter's state minus what uncommitted token placements already promise.
export async function availableState(row, data) {
  const state = await fighterState(row.combatant_id);
  if (!state) return null;
  const idx = patdContent();
  const reserved = reservedBy(data.placements ?? [], (p) => planPayment(idx.get(p.actionId), p.option, p.answers, state));
  return minusReserved(state, reserved);
}

// The Actions this roll's turn can use (Basic, the rolled Stance's, always available).
export async function turnActionIds(row, data) {
  const idx = patdContent();
  const d = await derivedFor(row.character_id);
  const t = turnActions(d, stanceOfBuild(d, data.stanceKey, idx), idx);
  return new Set([...t.basic, ...t.personal.flatMap((g) => g.ids)]);
}

// { rollId → public board } for the recent rolls.
export async function listMarks() {
  const rows = await all(`SELECT * FROM dice_marks ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP}`);
  return Object.fromEntries(rows.map((r) => [r.roll_id, shape(r)]));
}

// deps: on, socket, io, triggers (the engine: commit / continue / retrieve)
export function registerDiceMarkHandlers({ on: onRaw, socket, io, triggers = null }) {
  const on = (event, handler) => onRaw(event, serialized(handler));
  const emit = (ev, payload) => io.emit(ev, payload);
  const isGm = () => socket.data.identity?.role === 'gm';
  const editableRoll = async (rollId) => {
    const row = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [String(rollId ?? '')]);
    if (!row?.active) return null;
    const v = socket.data.identity;
    return v?.role === 'gm' || controlsCharacter(v, row.character_id) ? row : null;
  };
  const refuse = (rollId, error) => socket.emit('dice:pay_failed', { rollId, error });

  // **Place** a die (`die`: pool index) or a token payment (`option`, `answers`)
  // on an Action. Nothing happens until Commit.
  on('board:place', async ({ rollId, die = null, actionId, option = null, answers = {} }) => {
    const row = await editableRoll(rollId);
    if (!row) return;
    const data = readData(row);
    if (data.committing) return refuse(row.roll_id, 'Actions are being performed');
    const idx = patdContent();
    const action = idx.get(String(actionId));
    if (!action || !(await turnActionIds(row, data)).has(action.id)) return refuse(row.roll_id, 'not an Action this turn can use');
    data.placements ??= [];
    if (die != null) {
      const pool = poolOf(data);
      const n = pool.find((p) => p.index === Number(die));
      if (!n) return;
      if (data.placements.some((p) => p.kind === 'die' && p.die === n.index)) return;
      if (!hasDiceCost(action)) return refuse(row.roll_id, `${action.name} is not paid with dice`);
      data.placements.push({ key: `d${n.index}`, kind: 'die', die: n.index, actionId: action.id, threshold: gateFor(action, n.value), stop: null, committed: false });
    } else {
      const opt = Number(option);
      if (!tokenOptions(action).some((o) => o.index === opt)) return refuse(row.roll_id, 'no such cost');
      const state = await availableState(row, data);
      const plan = state ? planPayment(action, opt, answers, state) : { error: 'no fighter' };
      if (plan.error) return refuse(row.roll_id, plan.error);
      const n = data.placements.filter((p) => p.kind === 'token').length;
      data.placements.push({ key: `a${n + 1}:${action.id}`, kind: 'token', actionId: action.id, option: opt, answers, threshold: gateFor(action, plan.rating), stop: null, text: paymentText(plan), committed: false });
    }
    await saveBoard(row.roll_id, data, emit);
  });

  on('board:unplace', async ({ rollId, key }) => {
    const row = await editableRoll(rollId);
    if (!row) return;
    const data = readData(row);
    if (data.committing) return;
    const p = (data.placements ?? []).find((x) => x.key === key);
    if (!p || p.committed) return;
    data.placements = data.placements.filter((x) => x.key !== key);
    await saveBoard(row.roll_id, data, emit);
  });

  // Stop at an earlier Gate (decided: tap a lower lit Gate); null: the highest.
  on('board:stop', async ({ rollId, key, stop = null }) => {
    const row = await editableRoll(rollId);
    if (!row) return;
    const data = readData(row);
    const p = (data.placements ?? []).find((x) => x.key === key);
    if (!p || p.committed) return;
    const action = patdContent().get(p.actionId);
    if (stop != null && !stopChoices(action, p.threshold).includes(Number(stop))) return;
    p.stop = stop == null || Number(stop) === p.threshold ? null : Number(stop);
    await saveBoard(row.roll_id, data, emit);
  });

  // The footer's Power toggle: Enhance the placed Actions' hits (phase C).
  on('board:power', async ({ rollId, on: value }) => {
    const row = await editableRoll(rollId);
    if (!row) return;
    const data = readData(row);
    data.power = Boolean(value);
    await saveBoard(row.roll_id, data, emit);
  });

  // **Commit** (and Continue after a pause): the engine performs the placed
  // Actions in order, on the fight's own chain.
  on('board:commit', async ({ rollId }) => {
    const row = await editableRoll(rollId);
    if (!row || !triggers) return;
    triggers.commitBoard(row.roll_id);
  });

  // **Retrieve (GM only, decided):** undo a committed Action and every later one.
  on('board:retrieve', async ({ rollId, key }) => {
    if (!isGm() || !triggers) return;
    const row = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [String(rollId ?? '')]);
    if (!row) return;
    triggers.retrieve(row.roll_id, String(key));
  });
}
