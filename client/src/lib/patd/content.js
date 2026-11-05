// The Panic at the Dojo character content (client/src/data/patd/content.json,
// the user's export of the 2e / PATCH'D UP Beta rules, CC-BY-SA 4.0): indexing
// and lookups. Pure — no imports — so the server and the client share it.
//
// Every catalog entity has a globally unique, stable string `id`; saved
// characters store ids, never names (import-guide.md). This index covers
// every array of objects with an `id` at the top level of the content.

export function indexContent(content) {
  const byId = new Map();
  for (const value of Object.values(content ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string') continue;
      if (byId.has(row.id)) throw new Error(`Duplicate content id: ${row.id}`);
      byId.set(row.id, row);
    }
  }
  const get = (id) => byId.get(id) ?? null;
  const resolve = (id) => {
    const row = byId.get(id);
    if (!row) throw new Error(`Unresolved content id: ${id}`);
    return row;
  };
  return { content, byId, get, resolve };
}

// Every catalog reference inside a value: fields ending in `Id` / `Ids`
// (except local option ids), plus `abilityVariants.<variant>` lists.
// Returns [{ path, id }].
const LOCAL_ID_FIELDS = new Set(['id']);
export function collectReferences(value, path = '') {
  const out = [];
  const walk = (v, p, key) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`, key));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const q = p ? `${p}.${k}` : k;
        if (k === 'abilityVariants' && x && typeof x === 'object') {
          for (const [variant, ids] of Object.entries(x)) for (const id of ids ?? []) out.push({ path: `${q}.${variant}`, id });
          continue;
        }
        if (!LOCAL_ID_FIELDS.has(k) && /Ids?$/.test(k)) {
          if (typeof x === 'string') out.push({ path: q, id: x });
          else if (Array.isArray(x)) for (const id of x) if (typeof id === 'string') out.push({ path: q, id });
          continue;
        }
        walk(x, q, k);
      }
    }
  };
  walk(value, path, null);
  return out;
}
