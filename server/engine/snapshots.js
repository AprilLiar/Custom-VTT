// **Snapshots of a fight (full automation, phase A).** Everything a committed
// Action can change — the fight's combatant rows, its map tiles, lane
// positions and the engine runtime — saved before the Action and restored when
// the GM retrieves its die (decided: undo fully).
import { all, one, run } from '../db.js';

const COLS = ['tokens', 'challenge_id', 'hp_max', 'hp_current', 'hp_bars', 'hp_broken', 'dizzy', 'active_stance_key', 'frantic_pick', 'grid_col', 'grid_row', 'bled_round'];

export async function takeSnapshot(fightId) {
  const fight = await one('SELECT * FROM fights WHERE id = ?', [fightId]);
  if (!fight) return null;
  const combatants = await all(`SELECT id, ${COLS.join(', ')} FROM combatants WHERE scene_id = ? AND mode = ?`, [fight.scene_id, fight.mode]);
  const tiles = await all('SELECT col, row, kind FROM map_tiles WHERE scene_id = ? AND mode = ?', [fight.scene_id, fight.mode]);
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
  for (const t of snap.tiles) await run('INSERT INTO map_tiles (scene_id, mode, col, row, kind) VALUES (?, ?, ?, ?, ?)', [snap.sceneId, snap.mode, t.col, t.row, t.kind]);
  for (const l of snap.lane) await run('UPDATE scene_summons SET lane_slot = ? WHERE id = ?', [l.lane_slot, l.id]);
  await run('UPDATE fights SET runtime = ? WHERE id = ?', [snap.runtime, snap.fightId]);
}
