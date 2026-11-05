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
import { controlsCharacter } from './control.js';

const KEEP = 300;
const shape = (r) => {
  let d = {};
  try {
    d = JSON.parse(r.data || '{}');
  } catch {
    d = {};
  }
  return { rollId: r.roll_id, used: d.used ?? [], assign: d.assign ?? {}, active: Boolean(r.active) };
};

// A new Stance roll: its (empty) marks, the only active ones for that fighter.
export async function startRoll({ rollId, combatantId, characterId, dice }, emit) {
  await endTurnDice([combatantId], emit);
  await run('INSERT INTO dice_marks (roll_id, combatant_id, character_id, dice, data, active) VALUES (?, ?, ?, ?, ?, 1)', [
    rollId,
    combatantId,
    characterId,
    dice,
    JSON.stringify({ used: [], assign: {} }),
  ]);
  await run(`DELETE FROM dice_marks WHERE roll_id NOT IN (SELECT roll_id FROM dice_marks ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP})`);
  emit?.('dice:marks', { rollId, used: [], assign: {}, active: true });
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

// { rollId → { used, assign, active } } for the recent rolls.
export async function listMarks() {
  const rows = await all(`SELECT * FROM dice_marks ORDER BY created_at DESC, rowid DESC LIMIT ${KEEP}`);
  return Object.fromEntries(rows.map((r) => [r.roll_id, shape(r)]));
}

// deps: on, socket, io
export function registerDiceMarkHandlers({ on, socket, io }) {
  // The board's whole state for one roll, from whoever controls the fighter (or the GM).
  on('dice:mark', async ({ rollId, used, assign }) => {
    const row = await one('SELECT * FROM dice_marks WHERE roll_id = ?', [String(rollId ?? '')]);
    if (!row?.active) return;
    const v = socket.data.identity;
    if (v?.role !== 'gm' && !controlsCharacter(v, row.character_id)) return;
    const clean = cleanMarks({ used, assign }, row.dice);
    await run('UPDATE dice_marks SET data = ? WHERE roll_id = ?', [JSON.stringify(clean), row.roll_id]);
    io.emit('dice:marks', { rollId: row.roll_id, ...clean, active: true });
  });
}
