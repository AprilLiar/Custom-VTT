// **Homebrew builder (vttprojectplan.md, "Homebrew builder").** The GM's own
// Forms, Styles and Archetypes. Each row of `homebrew` is one cleaned item
// (client/src/lib/patd/homebrew.js); the server merges them into the rules
// content (server/patdContent.js) so builds, fights and triggers use them.
//
// Only the GM saves, publishes or deletes. Everyone may read every item: a
// draft is simply not offered in a player's builder, but a character already
// using it keeps it.
//
// **Commit Homebrew (GM tool):** `homebrew:commit` writes every published item
// to the repo (server/githubCommit.js); the committed core and Claude's
// automation map live in server/homebrewCore.js and ride along with the items
// to every client (`{ items, automation, coreIds }`), which draws the wrenches.
import { all, one, run } from './db.js';
import { cleanHomebrew, ensureUids, isHomebrewId, newHomebrewId } from '../client/src/lib/patd/homebrew.js';
import { HOMEBREW_TOKEN_KEYS } from '../client/src/lib/patd/homebrew.js';
import { bookContent, setHomebrewItems } from './patdContent.js';
import { coreIds, coreItemList, homebrewAutomation, setCoreItems } from './homebrewCore.js';
import { commitHomebrew, githubConfig } from './githubCommit.js';

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

const save = (item) => {
  const { id, kind, published, ...data } = item;
  return run(
    `INSERT INTO homebrew (id, kind, data, published) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, published = excluded.published, updated_at = CURRENT_TIMESTAMP`,
    [id, kind, JSON.stringify(data), published ? 1 : 0]
  );
};

// At boot: an empty table gets the committed core back (the backup), and older
// items get their Abilities' and Actions' uids (the automation map's keys).
export async function restoreAndMigrateHomebrew() {
  let items = await listHomebrew();
  if (!items.length && coreItemList().length) {
    let restored = 0;
    for (const item of coreItemList()) {
      const clean = cleanHomebrew(item, bookContent(), HOMEBREW_TOKEN_KEYS);
      if (clean && item.id.startsWith(`${clean.kind}.`)) (await save({ ...clean, id: item.id }), restored++);
    }
    console.log(`Homebrew: restored ${restored} item(s) from the committed core`);
    items = await listHomebrew();
  }
  for (const item of items) {
    const { item: fixed, changed } = ensureUids(item);
    if (changed) await save(fixed);
  }
}

// Reads every item into the server's content. Call at boot and after a change.
export async function loadHomebrew() {
  const items = await listHomebrew();
  setHomebrewItems(items);
  return items;
}

// What every client gets: the items, Claude's automation map, and which items
// are in the committed core (for the wrenches).
export async function homebrewPayload(items = null) {
  return { items: items ?? (await listHomebrew()), automation: homebrewAutomation(), coreIds: coreIds() };
}

let committing = false;

// deps: on, socket, io, emitStageUpdated; `commit`/`config` for tests.
export function registerHomebrewHandlers({ on, socket, io, emitStageUpdated = async () => {}, commit = commitHomebrew, config = githubConfig }) {
  const isGm = () => socket.data.identity?.role === 'gm';
  const changed = async () => {
    const items = await loadHomebrew();
    io.emit('homebrew:updated', await homebrewPayload(items));
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
    await save({ ...clean, id });
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

  // **Commit Homebrew** (GM): every published item → the repo's `main`, one
  // commit (which redeploys the app). Answers { ok, sha, url, added, changed,
  // removed, files } | { ok, unchanged } | { error: 'no-token' | 'busy' | 'github', message }.
  socket.on('homebrew:commit', async (_payload, ack) => {
    if (typeof ack !== 'function') return;
    if (!isGm()) return ack({ error: 'gm-only' });
    const cfg = config();
    if (!cfg.token) return ack({ error: 'no-token', repo: cfg.repo });
    if (committing) return ack({ error: 'busy' });
    committing = true;
    try {
      const items = (await listHomebrew()).filter((i) => i.published);
      const res = await commit(items, cfg);
      setCoreItems(items);
      io.emit('homebrew:updated', await homebrewPayload());
      ack({ ok: true, ...res });
    } catch (err) {
      console.error('homebrew:commit failed:', err);
      ack({ error: 'github', message: String(err?.message ?? err) });
    } finally {
      committing = false;
    }
  });
}
