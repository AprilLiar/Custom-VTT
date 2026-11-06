// Map tiles (decided, new): Fog, Pits, Traps, Rubble, Walls and the Battle
// Parameters' zones, placed on the active Scene's Combat map (a grid cell) or
// Simple Combat lane (a lane space: col = space index, row = 0). Each mode
// keeps its own tiles, like each mode keeps its own fight.
//
// Who may edit (decided): everyone — the GM and every Player — as the book's
// Free Placement has each player add obstacles. Clearing a whole mode is
// GM-only. The stacking rules live in client/src/lib/mapTiles.js.
import { all, one, run } from './db.js';
import { LANE_SLOTS, MAX_LANES } from '../client/src/lib/simpleLane.js';
import {
  DESTRUCTIBLE,
  destroyTile,
  isPaletteKind,
  mergeInto,
  placeTile,
  removeTile,
} from '../client/src/lib/mapTiles.js';
import { serialized } from './combatState.js';

const MODES = new Set(['simple', 'combat']);
const CELL_LIMIT = 2000;
const validSquare = (mode, col, row) => {
  if (!Number.isInteger(col) || !Number.isInteger(row)) return false;
  if (mode === 'simple') return row === 0 && col >= 0 && col < LANE_SLOTS * MAX_LANES;
  return Math.abs(col) <= CELL_LIMIT && Math.abs(row) <= CELL_LIMIT;
};

// Every tile of the active Scene, by mode: { simple: [{col,row,kind}], combat: [...] }.
export async function loadMapTiles(sceneId) {
  const out = { simple: [], combat: [] };
  if (sceneId == null) return out;
  const rows = await all('SELECT mode, col, row, kind, owner_id FROM map_tiles WHERE scene_id = ? ORDER BY id', [sceneId]);
  // A Copy (phase E) carries its Original's combatant id.
  for (const r of rows) out[r.mode]?.push(r.kind === 'copy' ? { col: r.col, row: r.row, kind: r.kind, owner_id: r.owner_id } : { col: r.col, row: r.row, kind: r.kind });
  return out;
}

// (Copies are fighters' replicas, not palette tiles: hand edits leave them be.)
const kindsAt = async (sceneId, mode, col, row) =>
  (await all("SELECT kind FROM map_tiles WHERE scene_id = ? AND mode = ? AND col = ? AND row = ? AND kind != 'copy'", [sceneId, mode, col, row])).map(
    (r) => r.kind
  );

async function writeSquare(sceneId, mode, col, row, kinds) {
  await run("DELETE FROM map_tiles WHERE scene_id = ? AND mode = ? AND col = ? AND row = ? AND kind != 'copy'", [sceneId, mode, col, row]);
  for (const kind of kinds) {
    await run('INSERT INTO map_tiles (scene_id, mode, col, row, kind) VALUES (?, ?, ?, ?, ?)', [sceneId, mode, col, row, kind]);
  }
}

// deps: on, socket, emitStageUpdated
export function registerMapTileHandlers({ on: onRaw, socket, emitStageUpdated }) {
  // One server-wide queue with the other fight writes: each is read-change-write.
  const on = (event, handler) => onRaw(event, serialized(handler));
  const activeScene = async () => (await one('SELECT active_scene_id FROM scene_state WHERE id = 1'))?.active_scene_id ?? null;
  // Resolves the common checks, or null.
  const target = async (mode, col, row) => {
    if (!socket.data.identity || !MODES.has(mode) || !validSquare(mode, col, row)) return null;
    const sceneId = await activeScene();
    return sceneId == null ? null : sceneId;
  };
  const change = async (sceneId, mode, col, row, fn) => {
    const before = await kindsAt(sceneId, mode, col, row);
    const after = fn(before);
    if ([...after].sort().join() === [...before].sort().join()) return false;
    await writeSquare(sceneId, mode, col, row, after);
    return true;
  };

  on('map_tile:place', async ({ mode, col, row, kind }) => {
    const sceneId = await target(mode, col, row);
    if (sceneId == null || !isPaletteKind(kind)) return;
    if (await change(sceneId, mode, col, row, (k) => placeTile(k, kind))) await emitStageUpdated();
  });

  on('map_tile:remove', async ({ mode, col, row, kind }) => {
    const sceneId = await target(mode, col, row);
    if (sceneId == null || !isPaletteKind(kind)) return;
    if (await change(sceneId, mode, col, row, (k) => removeTile(k, kind))) await emitStageUpdated();
  });

  on('map_tile:destroy', async ({ mode, col, row, kind }) => {
    const sceneId = await target(mode, col, row);
    if (sceneId == null || !DESTRUCTIBLE.has(kind)) return;
    if (await change(sceneId, mode, col, row, (k) => destroyTile(k, kind))) await emitStageUpdated();
  });

  // Moving a square's whole stack: `to` null (dragged off the map or lane)
  // removes it.
  on('map_tile:move', async ({ mode, from, to }) => {
    const sceneId = await target(mode, from?.col, from?.row);
    if (sceneId == null) return;
    if (to != null && !validSquare(mode, to.col, to.row)) return;
    if (to && to.col === from.col && to.row === from.row) return;
    const moving = await kindsAt(sceneId, mode, from.col, from.row);
    if (!moving.length) return;
    await writeSquare(sceneId, mode, from.col, from.row, []);
    if (to) await change(sceneId, mode, to.col, to.row, (k) => mergeInto(k, moving));
    await emitStageUpdated();
  });

  on('map_tile:clear', async ({ mode }) => {
    if (socket.data.identity?.role !== 'gm' || !MODES.has(mode)) return;
    const sceneId = await activeScene();
    if (sceneId == null) return;
    await run('DELETE FROM map_tiles WHERE scene_id = ? AND mode = ?', [sceneId, mode]);
    await emitStageUpdated();
  });
}
