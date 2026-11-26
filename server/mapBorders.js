// **Map borders (decided, new):** red and purple lines the GM draws on the
// active Scene's Combat map, along square edges, one edge at a time (rules in
// client/src/lib/patd/engine/borders.js). GM-only (decided): borders are the
// arena's design. Each edge holds at most one border; setting one where
// another stands replaces it.
import { all, run } from './db.js';
import { BORDER_COLORS, BORDER_SIDES } from '../client/src/lib/patd/engine/borders.js';
import { serialized } from './combatState.js';

const CELL_LIMIT = 2000;
const validEdge = ({ side, col, row } = {}) =>
  BORDER_SIDES.includes(side) && Number.isInteger(col) && Number.isInteger(row) && Math.abs(col) <= CELL_LIMIT && Math.abs(row) <= CELL_LIMIT;

// The active Scene's borders: [{ side, col, row, color, blocksRange }].
export async function loadMapBorders(sceneId) {
  if (sceneId == null) return [];
  const rows = await all('SELECT side, col, row, color, blocks_range FROM map_borders WHERE scene_id = ? ORDER BY id', [sceneId]);
  return rows.map((r) => ({ side: r.side, col: r.col, row: r.row, color: r.color, blocksRange: Boolean(r.blocks_range) }));
}

// deps: on, socket, emitStageUpdated
export function registerMapBorderHandlers({ on: onRaw, socket, emitStageUpdated }) {
  // On the one write queue with the other fight writes.
  const on = (event, handler) => onRaw(event, serialized(handler));
  const gmScene = async () => {
    if (socket.data.identity?.role !== 'gm') return null;
    const r = await all('SELECT active_scene_id FROM scene_state WHERE id = 1');
    return r[0]?.active_scene_id ?? null;
  };

  // Several edges at once (a drag paints a run of them): [{ side, col, row }].
  on('map_border:set', async ({ edges, color, blocksRange = true }) => {
    const sceneId = await gmScene();
    if (sceneId == null || !BORDER_COLORS.includes(color) || !Array.isArray(edges)) return;
    const list = edges.filter(validEdge).slice(0, 200);
    if (!list.length) return;
    for (const e of list) {
      await run(
        `INSERT INTO map_borders (scene_id, side, col, row, color, blocks_range) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scene_id, side, col, row) DO UPDATE SET color = excluded.color, blocks_range = excluded.blocks_range`,
        [sceneId, e.side, e.col, e.row, color, blocksRange ? 1 : 0]
      );
    }
    await emitStageUpdated();
  });

  on('map_border:remove', async ({ edges }) => {
    const sceneId = await gmScene();
    if (sceneId == null || !Array.isArray(edges)) return;
    const list = edges.filter(validEdge).slice(0, 200);
    if (!list.length) return;
    for (const e of list) await run('DELETE FROM map_borders WHERE scene_id = ? AND side = ? AND col = ? AND row = ?', [sceneId, e.side, e.col, e.row]);
    await emitStageUpdated();
  });

  on('map_border:clear', async () => {
    const sceneId = await gmScene();
    if (sceneId == null) return;
    await run('DELETE FROM map_borders WHERE scene_id = ?', [sceneId]);
    await emitStageUpdated();
  });
}
