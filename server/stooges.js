// **Stooges (decided): one unit, many bodies.** Every body of a Stooges
// character on one board (a Scene's Combat map, or its Simple Combat lane)
// is tied to the others by `combatants.stooge_unit` (the character id), and
// the database copies HP, tokens, Challenge and the rest between them
// (db.js `stooges_share`). Tied the moment a body is placed — not only at
// Start Combat — so Fight Setup, the token panel and every edit see one unit.
import { all, one, run } from './db.js';
import { derivedFor } from './fighterStances.js';

export const isStoogesType = async (characterId) => characterId != null && (await derivedFor(characterId))?.type?.id === 'character-type.stooges';

// Ties every body of `characterId` on (sceneId, mode); a body new to the unit
// takes the unit's state from one already tied. `fresh`: every body starts in
// play again (Start Combat). → the tied ids (lowest first), or [] when not Stooges.
export async function tieStooges(sceneId, mode, characterId, { fresh = false } = {}) {
  if (!(await isStoogesType(characterId))) return [];
  const rows = await all('SELECT id, stooge_unit, stooge_out FROM combatants WHERE scene_id = ? AND mode = ? AND character_id = ? ORDER BY id', [sceneId, mode, characterId]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const source = rows.find((r) => r.stooge_unit != null && !r.stooge_out) ?? rows.find((r) => r.stooge_unit != null) ?? rows[0];
  await run(`UPDATE combatants SET stooge_unit = ?${fresh ? ', stooge_out = 0' : ''} WHERE id IN (${marks})`, [characterId, ...ids]);
  // Touch the source: the trigger copies its state onto every other body.
  await run('UPDATE combatants SET hp_current = hp_current WHERE id = ?', [source.id]);
  return ids;
}

// Every unit on a board: characterId → its body ids (Fight Setup groups them).
export async function stoogeUnitsOn(sceneId, mode) {
  const rows = await all('SELECT id, stooge_unit FROM combatants WHERE scene_id = ? AND mode = ? AND stooge_unit IS NOT NULL ORDER BY id', [sceneId, mode]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.stooge_unit)) out.set(r.stooge_unit, []);
    out.get(r.stooge_unit).push(r.id);
  }
  return out;
}
export const stoogeUnitOf = async (combatantId) => (await one('SELECT stooge_unit FROM combatants WHERE id = ?', [combatantId]))?.stooge_unit ?? null;
