// Character builds (builder phase 1 — vttprojectplan.md, "Character builder &
// turn automation"): one row per character holding the player's choices as
// JSON (ids only, see client/src/lib/patd/build.js). Everything else — Stances,
// dice, abilities, warnings — is derived from it on demand.
//
// Who may save: whoever controls the character (their player, an assigned
// player, the GM) — the same rule as every other character write.
import { one, run } from './db.js';
import { normalizeBuild } from '../client/src/lib/patd/build.js';
import { patdContent } from './patdContent.js';

export async function loadBuild(characterId) {
  const row = await one('SELECT data FROM character_builds WHERE character_id = ?', [Number(characterId)]);
  if (!row) return null;
  try {
    return normalizeBuild(JSON.parse(row.data), patdContent());
  } catch {
    return null;
  }
}

export async function deleteBuild(characterId) {
  await run('DELETE FROM character_builds WHERE character_id = ?', [Number(characterId)]);
}

// deps: on, socket, io, mayWrite(viewer, ownerType, ownerId), emitStageUpdated
export function registerBuildHandlers({ on, socket, io, mayWrite, emitStageUpdated = async () => {} }) {
  on('build:save', async ({ characterId, build }) => {
    const id = Number(characterId);
    if (!Number.isInteger(id) || !mayWrite(socket.data.identity, 'character', id)) return;
    if (!(await one('SELECT id FROM characters WHERE id = ?', [id]))) return;
    const clean = normalizeBuild(build, patdContent());
    await run(
      `INSERT INTO character_builds (character_id, data, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(character_id) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP`,
      [id, JSON.stringify(clean)]
    );
    io.emit('build:updated', { characterId: id, build: clean });
    await emitStageUpdated();
  });

  on('build:clear', async ({ characterId }) => {
    const id = Number(characterId);
    if (!Number.isInteger(id) || !mayWrite(socket.data.identity, 'character', id)) return;
    await deleteBuild(id);
    io.emit('build:updated', { characterId: id, build: null });
    await emitStageUpdated();
  });
}
