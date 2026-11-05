// **Homebrew builder (vttprojectplan.md, "Homebrew builder").** The GM's own
// Forms, Styles and Archetypes. Each row of `homebrew` is one cleaned item
// (client/src/lib/patd/homebrew.js); the server merges them into the rules
// content (server/patdContent.js) so builds, fights and triggers use them.
//
// Only the GM saves, publishes or deletes. Everyone may read every item: a
// draft is simply not offered in a player's builder, but a character already
// using it keeps it.
import { all, one, run } from './db.js';
import { cleanHomebrew, isHomebrewId, newHomebrewId } from '../client/src/lib/patd/homebrew.js';
import { HOMEBREW_TOKEN_KEYS } from '../client/src/lib/patd/homebrew.js';
import { bookContent, setHomebrewItems } from './patdContent.js';

const parse = (row) => {
  try {
    return { ...JSON.parse(row.data), id: row.id, kind: row.kind, published: Boolean(row.published) };
  } catch {
    return null;
  }
};

export async function listHomebrew() {
  return (await all('SELECT * FROM homebrew ORDER BY kind, created_at, id')).map(parse).filter(Boolean);
}

// Reads every item into the server's content. Call at boot and after a change.
export async function loadHomebrew() {
  const items = await listHomebrew();
  setHomebrewItems(items);
  return items;
}

// deps: on, socket, io, emitStageUpdated
export function registerHomebrewHandlers({ on, socket, io, emitStageUpdated = async () => {} }) {
  const isGm = () => socket.data.identity?.role === 'gm';
  const changed = async () => {
    const items = await loadHomebrew();
    io.emit('homebrew:updated', { items });
    await emitStageUpdated();
  };

  // Create (no id) or update an item. Answers the saved id to the sender.
  on('homebrew:save', async ({ item }) => {
    if (!isGm()) return;
    const clean = cleanHomebrew(item, bookContent(), HOMEBREW_TOKEN_KEYS);
    if (!clean) return;
    let id = item?.id;
    if (id != null) {
      const row = await one('SELECT kind FROM homebrew WHERE id = ?', [id]);
      if (!row || row.kind !== clean.kind || !isHomebrewId(id)) return;
    } else {
      do id = newHomebrewId(clean.kind, clean.name);
      while (await one('SELECT id FROM homebrew WHERE id = ?', [id]));
    }
    const { published, kind, ...data } = clean;
    await run(
      `INSERT INTO homebrew (id, kind, data, published) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, published = excluded.published, updated_at = CURRENT_TIMESTAMP`,
      [id, kind, JSON.stringify(data), published ? 1 : 0]
    );
    socket.emit('homebrew:saved', { id, clientKey: item?.clientKey ?? null });
    await changed();
  });

  on('homebrew:publish', async ({ id, published }) => {
    if (!isGm() || !isHomebrewId(id)) return;
    await run('UPDATE homebrew SET published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [published ? 1 : 0, id]);
    await changed();
  });

  // Characters using a deleted item lose it from their build (unknown ids are dropped).
  on('homebrew:delete', async ({ id }) => {
    if (!isGm() || !isHomebrewId(id)) return;
    await run('DELETE FROM homebrew WHERE id = ?', [id]);
    await changed();
  });
}
