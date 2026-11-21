// **Snapshots of a fight (full automation, phase A).** Everything a committed
// Action can change — the fight's combatant rows, its map tiles, lane
// positions and the engine runtime — saved before the Action and restored when
// the GM retrieves its die (decided: undo fully).
import { all, one, run } from '../db.js';

const COLS = ['tokens', 'challenge_id', 'hp_max', 'hp_current', 'hp_bars', 'hp_broken', 'dizzy', 'active_stance_key', 'frantic_pick', 'grid_col', 'grid_row', 'bled_round', 'damage_taken', 'damage_max', 'felled', 'stooge_out'];

export async function takeSnapshot(fightId) {
  const fight = await one('SELECT * FROM fights WHERE id = ?', [fightId]);
  if (!fight) return null;
  const combatants = await all(`SELECT id, ${COLS.join(', ')} FROM combatants WHERE scene_id = ? AND mode = ?`, [fight.scene_id, fight.mode]);
  const tiles = await all('SELECT col, row, kind, owner_id, placed_by FROM map_tiles WHERE scene_id = ? AND mode = ?', [fight.scene_id, fight.mode]);
  const lane = fight.mode === 'simple' ? await all('SELECT id, lane_slot FROM scene_summons WHERE scene_id = ?', [fight.scene_id]) : [];
  return { fightId, sceneId: fight.scene_id, mode: fight.mode, combatants, tiles, lane, runtime: fight.runtime };
}

// Run inside the write queue.
export async function restoreSnapshot(snap) {
  if (!snap) return;
  for (const c of snap.combatants) {
    await run(`UPDATE combatants SET ${COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...COLS.map((k) => c[k] ?? null), c.id]);
  }
  await run('DELETE FROM map_tiles WHERE scene_id = ? AND mode = ?', [snap.sceneId, snap.mode]);
  // (owner_id: a Copy's Original — phase E.)
  for (const t of snap.tiles) await run('INSERT INTO map_tiles (scene_id, mode, col, row, kind, owner_id, placed_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [snap.sceneId, snap.mode, t.col, t.row, t.kind, t.owner_id ?? null, t.placed_by ?? null]);
  for (const l of snap.lane) await run('UPDATE scene_summons SET lane_slot = ? WHERE id = ?', [l.lane_slot, l.id]);
  await run('UPDATE fights SET runtime = ? WHERE id = ?', [snap.runtime, snap.fightId]);
}

// **A full snapshot (GM Rewind):** the above plus the fight's own turn state
// (round, order, whose turn, movement phase, sides), the Scene's Fight Setup
// state (Sabotage points, the Important Thing's holder, chains…) and every
// dice board of the fight's fighters — so a rewind can step back over a Next
// turn as well as an Action.
const FIGHT_COLS = ['allies', 'enemies', 'renegades', 'round', 'turn_order', 'turn_index', 'pending_stance_combatant', 'prev_turn_order', 'movement_phase', 'reaction_window', 'runtime'];
export async function takeFullSnapshot(fightId) {
  const base = await takeSnapshot(fightId);
  if (!base) return null;
  const fight = await one(`SELECT ${FIGHT_COLS.join(', ')} FROM fights WHERE id = ?`, [fightId]);
  const scene = await one('SELECT battle FROM scenes WHERE id = ?', [base.sceneId]);
  const boards = await all('SELECT dm.roll_id, dm.data, dm.active FROM dice_marks dm JOIN combatants cb ON cb.id = dm.combatant_id WHERE cb.scene_id = ? AND cb.mode = ?', [base.sceneId, base.mode]);
  return { ...base, full: true, fight, battle: scene?.battle ?? null, boards };
}

// Run inside the write queue. → the roll ids of every board it touched (to re-announce).
export async function restoreFullSnapshot(snap) {
  if (!snap?.full) return [];
  await restoreSnapshot(snap);
  await run(`UPDATE fights SET ${FIGHT_COLS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...FIGHT_COLS.map((k) => snap.fight?.[k] ?? null), snap.fightId]);
  if (snap.battle != null) await run('UPDATE scenes SET battle = ? WHERE id = ?', [snap.battle, snap.sceneId]);
  const kept = new Set(snap.boards.map((b) => b.roll_id));
  // Boards begun since (a later turn's roll, an Interrupt board): closed.
  const now = await all('SELECT dm.roll_id FROM dice_marks dm JOIN combatants cb ON cb.id = dm.combatant_id WHERE cb.scene_id = ? AND cb.mode = ?', [snap.sceneId, snap.mode]);
  for (const b of now) if (!kept.has(b.roll_id)) await run('UPDATE dice_marks SET active = 0 WHERE roll_id = ?', [b.roll_id]);
  // The rest as they were — with nothing left half-committed: dice placed on
  // an Action that had not resolved come back free (a full refund).
  for (const b of snap.boards) {
    let data = {};
    try {
      data = JSON.parse(b.data || '{}') ?? {};
    } catch {
      data = {};
    }
    data.placements = (data.placements ?? []).filter((p) => p.committed);
    data.committing = false;
    data.paused = false;
    delete data.interrupted;
    delete data.review;
    await run('UPDATE dice_marks SET data = ?, active = ? WHERE roll_id = ?', [JSON.stringify(data), b.active, b.roll_id]);
  }
  return [...now.map((b) => b.roll_id)];
}
