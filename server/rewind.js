// **GM Rewind (decided):** an always-there GM button that steps the fight
// back to just before its last Action (with every Ability it set off), Free
// Movement or Next turn — HP, tokens, positions, tiles, dice, the turn itself,
// everything — up to 5 times in a row. One full snapshot per step
// (engine/snapshots.js `takeFullSnapshot`), newest last, in `rewind_points`.
import { all, one, run } from './db.js';
import { serialized } from './combatState.js';
import { restoreFullSnapshot, takeFullSnapshot } from './engine/snapshots.js';

export const REWIND_LIMIT = 5;

// Remember the fight as it is now, before `label` happens.
// `inQueue`: called from inside the server-wide write queue (a serialized
// handler) — writing straight away, never queueing behind itself.
export async function pushRewindPoint(fightId, label, { inQueue = false } = {}) {
  if (fightId == null) return;
  const snap = await takeFullSnapshot(fightId);
  if (!snap) return;
  const write = async () => {
    await run('INSERT INTO rewind_points (fight_id, label, data) VALUES (?, ?, ?)', [fightId, String(label).slice(0, 120), JSON.stringify(snap)]);
    // Only the newest few are kept.
    await run('DELETE FROM rewind_points WHERE fight_id = ? AND id NOT IN (SELECT id FROM rewind_points WHERE fight_id = ? ORDER BY id DESC LIMIT ?)', [fightId, fightId, REWIND_LIMIT]);
  };
  if (inQueue) await write();
  else await serialized(write)();
}

// Two halves of the same, for a step that may come to nothing (a Free
// Movement out of reach, an Action declined): the snapshot first, then — only
// once it really happened — kept as a rewind point. (Outside the write queue.)
export const rewindMark = (fightId) => (fightId == null ? null : takeFullSnapshot(fightId));
export async function keepRewindMark(fightId, label, snap) {
  if (fightId == null || !snap) return;
  await serialized(async () => {
    await run('INSERT INTO rewind_points (fight_id, label, data) VALUES (?, ?, ?)', [fightId, String(label).slice(0, 120), JSON.stringify(snap)]);
    await run('DELETE FROM rewind_points WHERE fight_id = ? AND id NOT IN (SELECT id FROM rewind_points WHERE fight_id = ? ORDER BY id DESC LIMIT ?)', [fightId, fightId, REWIND_LIMIT]);
  })();
}

// What can be rewound now, newest first: [{ id, label }].
export async function rewindList(fightId) {
  if (fightId == null) return [];
  return all('SELECT id, label FROM rewind_points WHERE fight_id = ? ORDER BY id DESC', [fightId]);
}

// Step back once. → { label, rollIds } or null (nothing to rewind).
// Run inside the write queue (the GM's serialized handler).
export async function rewindOnce(fightId) {
  const row = await one('SELECT * FROM rewind_points WHERE fight_id = ? ORDER BY id DESC LIMIT 1', [fightId]);
  if (!row) return null;
  const rollIds = await restoreFullSnapshot(JSON.parse(row.data));
  await run('DELETE FROM rewind_points WHERE id = ?', [row.id]);
  // The Retrieve snapshots of what was just undone are meaningless now.
  await run('DELETE FROM fight_snapshots WHERE fight_id = ? AND created_at >= ?', [fightId, row.created_at]);
  return { label: row.label, rollIds };
}

// A fight began or ended: its history goes.
// (Inside the write queue.)
export const clearRewind = (fightId) => run('DELETE FROM rewind_points WHERE fight_id = ?', [fightId]);
