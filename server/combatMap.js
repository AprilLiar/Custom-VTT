// The Combat map (Panic at the Dojo, Phase 3): a Scene's Combat Background,
// its square grid, and the tokens standing on it.
//
// A token on the map is a `combatants` row with mode 'combat': one placed
// copy of a Character or Temp NPC at a grid cell (grid_col, grid_row). The
// same fighter can be placed many times and every copy is independent
// (decided). Phase 4 hangs HP, tokens and the Challenge off the same row.
//
// Who may do what (decided): the GM places, moves and removes anything; a
// Player places, moves and removes copies of their own character. Grid and
// background are GM-only. Dropping onto an occupied cell swaps the two
// tokens, like Simple Combat's lane; a new token can't swap, so an occupied
// cell refuses it.
import { all, one, run, writeMany } from './db.js';
import { imageUrl, sanitizeImageMime } from './images.js';
import { moveToken, normalizeGrid } from '../client/src/lib/combatGrid.js';
import { releaseChallengesOf, serialized, shapeFightState } from './combatState.js';

// Cells are integers in image-pixel grid space. The client never offers a
// cell outside the map's padding; this only bounds what a hand-sent event
// can store.
const CELL_LIMIT = 2000;
const validCell = (col, row) =>
  Number.isInteger(col) && Number.isInteger(row) && Math.abs(col) <= CELL_LIMIT && Math.abs(row) <= CELL_LIMIT;

export function sceneGrid(sceneRow) {
  return normalizeGrid({
    size: sceneRow?.grid_size,
    offsetX: sceneRow?.grid_offset_x,
    offsetY: sceneRow?.grid_offset_y,
    opacity: sceneRow?.grid_opacity,
  });
}

// Every token on a Scene's map, as the stage payload carries it: who it is,
// where it stands, and which pictures to draw it with — the combat token if
// the fighter has one, else their portrait. URLs only, never bytes.
export async function loadCombatTokens(sceneId) {
  const rows = await all(
    `SELECT cb.id, cb.character_id, cb.temp_npc_id, cb.grid_col, cb.grid_row,
            cb.tokens, cb.challenge_id, cb.hp_max, cb.hp_current, cb.hp_bars, cb.hp_broken, cb.dizzy, cb.active_stance_id, cb.level, cb.fighter_kind,
            COALESCE(c.name, tn.name) AS name,
            cp.id AS profile_id, cp.image_hash AS token_hash, (cp.image_data IS NOT NULL) AS has_token,
            cp.crop_x AS token_crop_x, cp.crop_y AS token_crop_y, cp.crop_w AS token_crop_w, cp.crop_h AS token_crop_h,
            COALESCE(c.image_hash, tn.image_hash) AS portrait_hash,
            (COALESCE(c.image_data, tn.image_data) IS NOT NULL) AS has_portrait,
            COALESCE(c.crop_x, tn.crop_x) AS crop_x, COALESCE(c.crop_y, tn.crop_y) AS crop_y,
            COALESCE(c.crop_w, tn.crop_w) AS crop_w, COALESCE(c.crop_h, tn.crop_h) AS crop_h
     FROM combatants cb
     LEFT JOIN characters c ON c.id = cb.character_id
     LEFT JOIN temp_npcs tn ON tn.id = cb.temp_npc_id
     LEFT JOIN combat_profiles cp
       ON (cb.character_id IS NOT NULL AND cp.character_id = cb.character_id)
       OR (cb.temp_npc_id IS NOT NULL AND cp.temp_npc_id = cb.temp_npc_id)
     WHERE cb.scene_id = ? AND cb.mode = 'combat' AND cb.character_id IS NOT NULL
     ORDER BY cb.id`,
    [sceneId]
  );
  return rows.map((r) => {
    const ownerType = r.character_id != null ? 'character' : 'temp_npc';
    const ownerId = r.character_id ?? r.temp_npc_id;
    const tokenUrl = r.has_token ? imageUrl('combat-token', r.profile_id, { present: true, hash: r.token_hash }) : null;
    const portraitUrl = r.has_portrait
      ? imageUrl(ownerType === 'character' ? 'character' : 'temp-npc', ownerId, { present: true, hash: r.portrait_hash })
      : null;
    return {
      id: r.id,
      owner_type: ownerType,
      owner_id: ownerId,
      character_id: r.character_id,
      temp_npc_id: r.temp_npc_id,
      name: r.name,
      col: r.grid_col,
      row: r.grid_row,
      image_url: tokenUrl ?? portraitUrl,
      crop: tokenUrl
        ? { x: r.token_crop_x, y: r.token_crop_y, w: r.token_crop_w, h: r.token_crop_h }
        : { x: r.crop_x, y: r.crop_y, w: r.crop_w, h: r.crop_h },
      // Phase 4: HP, tokens, Challenge, Dizzy, Stance.
      fight: shapeFightState(r),
    };
  });
}

// deps: on, socket, mayWrite(viewer, ownerType, ownerId), emitStageUpdated,
// stampImageHash(kind, id)
export function registerCombatMapHandlers({ on: onRaw, socket, mayWrite, emitStageUpdated, stampImageHash }) {
  // One at a time, through the same queue as the fighter writes: placing and
  // moving read the map, then write it.
  const on = (event, handler) => onRaw(event, serialized(handler));
  const viewer = () => socket.data.identity;
  const activeSceneId = async () =>
    (await one('SELECT active_scene_id FROM scene_state WHERE id = 1'))?.active_scene_id ?? null;
  const mayTouch = (row) =>
    mayWrite(viewer(), row.character_id != null ? 'character' : 'temp_npc', row.character_id ?? row.temp_npc_id);

  // Any of size / offsetX / offsetY / opacity; the rest are kept.
  on('scene:set_grid', async (patch) => {
    if (viewer()?.role !== 'gm') return;
    const sceneId = await activeSceneId();
    if (!sceneId) return;
    // **Only the fields this event names are written.** A read-modify-write of
    // all four would let two quick clicks (+1 on size, then on offset) race —
    // the second reading the row before the first had saved, and putting the
    // old size back. Each field clamps on its own, so no read is needed.
    const cleaned = normalizeGrid(patch);
    const columns = { size: 'grid_size', offsetX: 'grid_offset_x', offsetY: 'grid_offset_y', opacity: 'grid_opacity' };
    const sets = Object.keys(columns).filter((k) => patch[k] !== undefined && patch[k] !== null);
    if (!sets.length) return;
    await run(`UPDATE scenes SET ${sets.map((k) => `${columns[k]} = ?`).join(', ')} WHERE id = ?`, [
      ...sets.map((k) => cleaned[k]),
      sceneId,
    ]);
    await emitStageUpdated();
  });

  // The active Scene's Combat Background. `clear` removes it.
  on('scene:set_combat_image', async ({ imageData, imageMimeType, clear }) => {
    if (viewer()?.role !== 'gm') return;
    const sceneId = await activeSceneId();
    if (!sceneId) return;
    if (clear) {
      await run(
        'UPDATE scenes SET combat_image_data = NULL, combat_image_mime_type = NULL, combat_image_hash = NULL WHERE id = ?',
        [sceneId]
      );
    } else if (imageData) {
      await run('UPDATE scenes SET combat_image_data = ?, combat_image_mime_type = ? WHERE id = ?', [
        String(imageData),
        sanitizeImageMime(imageMimeType, 'image/jpeg'),
        sceneId,
      ]);
      await stampImageHash('scene-combat', sceneId);
    } else {
      return;
    }
    await emitStageUpdated();
  });

  // A new copy of a fighter on a free cell of the active Scene's map.
  on('combat_token:place', async ({ ownerType, ownerId, col, row }) => {
    const id = Number(ownerId);
    // Characters only: Temp NPCs take no part in combat (decided).
    if (ownerType !== 'character' || !Number.isInteger(id)) return;
    if (!mayWrite(viewer(), ownerType, id) || !validCell(col, row)) return;
    const sceneId = await activeSceneId();
    if (!sceneId) return;
    const table = ownerType === 'character' ? 'characters' : 'temp_npcs';
    if (!(await one(`SELECT id FROM ${table} WHERE id = ?`, [id]))) return;
    const taken = await one(
      "SELECT id FROM combatants WHERE scene_id = ? AND mode = 'combat' AND grid_col = ? AND grid_row = ?",
      [sceneId, col, row]
    );
    if (taken) return;
    const column = ownerType === 'character' ? 'character_id' : 'temp_npc_id';
    await run(`INSERT INTO combatants (scene_id, mode, ${column}, grid_col, grid_row) VALUES (?, 'combat', ?, ?, ?)`, [
      sceneId,
      id,
      col,
      row,
    ]);
    await emitStageUpdated();
  });

  // Move a placed token; onto another token swaps the two.
  on('combat_token:move', async ({ combatantId, col, row }) => {
    const token = await one("SELECT * FROM combatants WHERE id = ? AND mode = 'combat'", [Number(combatantId)]);
    if (!token || !mayTouch(token) || !validCell(col, row)) return;
    const tokens = (
      await all("SELECT id, grid_col, grid_row FROM combatants WHERE scene_id = ? AND mode = 'combat'", [token.scene_id])
    ).map((t) => ({ id: t.id, col: t.grid_col, row: t.grid_row }));
    const changes = moveToken(tokens, token.id, col, row);
    if (!changes?.length) return;
    await writeMany(
      changes.map((c) => ['UPDATE combatants SET grid_col = ?, grid_row = ? WHERE id = ?', [c.col, c.row, c.id]])
    );
    await emitStageUpdated();
  });

  on('combat_token:remove', async ({ combatantId }) => {
    const token = await one("SELECT * FROM combatants WHERE id = ? AND mode = 'combat'", [Number(combatantId)]);
    if (!token || !mayTouch(token)) return;
    await run('DELETE FROM combatants WHERE id = ?', [token.id]);
    await releaseChallengesOf([token.id]);
    await emitStageUpdated();
  });

  // Clear the active Scene's map of every token (GM).
  on('combat_token:clear', async () => {
    if (viewer()?.role !== 'gm') return;
    const sceneId = await activeSceneId();
    if (!sceneId) return;
    const ids = (await all("SELECT id FROM combatants WHERE scene_id = ? AND mode = 'combat'", [sceneId])).map((r) => r.id);
    await run("DELETE FROM combatants WHERE scene_id = ? AND mode = 'combat'", [sceneId]);
    await releaseChallengesOf(ids);
    await emitStageUpdated();
  });
}
