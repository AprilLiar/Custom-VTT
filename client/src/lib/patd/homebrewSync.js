// **Homebrew → core pipeline (vttprojectplan.md, "Commit Homebrew").** Pure
// helpers shared by the server, the client and scripts/homebrew-automation.mjs.
//
//   - Commit Homebrew (a GM tool) writes every *published* item to its own file,
//     `homebrew/items/<id>.json`, straight to `main` — the "core".
//   - Claude's passes ("automate homebrew content") write
//     `homebrew/automation.json`: per item, per Ability/Action `uid`, the
//     automation (an Ability's `rules`, an Action's `effect`…) plus the text
//     fingerprint it was written for and `basedOn`, the commit it read. A later
//     pass diffs the item against that commit (`git show`), so no buffer copy
//     of the old text is ever kept.
//   - Only rules wording greys the wrench: an Ability's rules text and rule
//     steps, an Action's cost and rules text. Names, descriptions, dice and
//     range don't.
import { isHomebrewId } from './homebrew.js';

export const CORE_ITEMS_DIR = 'homebrew/items';
export const AUTOMATION_PATH = 'homebrew/automation.json';
export const coreFilePath = (id) => `${CORE_ITEMS_DIR}/${id}.json`;
export const emptyAutomation = () => ({ version: 1, items: {} });

// FNV-1a over UTF-16 units, twice with different offsets → 16 hex digits.
function fnv(str, seed) {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
export const hashText = (str) => fnv(str, 0x811c9dc5) + fnv(str, 0x050c5d1f);

// JSON with object keys sorted, so equal data always hashes the same.
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

// Whitespace runs don't count as a wording change.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const abilityFingerprint = (a) => hashText(`ability|${norm(a?.rulesText)}|${stableJson(a?.rules ?? [])}`);
export const actionFingerprint = (a) => hashText(`action|${norm(a?.cost)}|${norm(a?.rulesText)}`);

// The automatable parts of an item, in order.
export function partsOf(item) {
  return [
    ...(item?.abilities ?? []).map((a, i) => ({ uid: a.uid, part: 'ability', index: i, name: a.name, fingerprint: abilityFingerprint(a) })),
    ...(item?.actions ?? []).map((a, i) => ({ uid: a.uid, part: 'action', index: i, name: a.name, fingerprint: actionFingerprint(a) })),
  ];
}

// One part against its automation entry: 'automated' | 'stale' | 'new'.
export function partState(part, autoItem) {
  const e = part?.uid ? autoItem?.entries?.[part.uid] : null;
  if (!e) return 'new';
  return e.fingerprint === part.fingerprint ? 'automated' : 'stale';
}

// The wrench by an item (decided):
//   'automated' (blue)    — Claude automated it and every part's wording still matches;
//   'stale'     (grey)    — automated, but some part's wording changed (or a part was added) since;
//   'waiting'   (outline) — committed to the core, not automated yet;
//   'none'                — never committed.
export function wrenchState(item, { autoItem = null, inCore = false } = {}) {
  if (autoItem) return partsOf(item).every((p) => partState(p, autoItem) === 'automated') ? 'automated' : 'stale';
  return inCore ? 'waiting' : 'none';
}

export const WRENCH_LABEL = {
  automated: 'Automated by Claude',
  stale: 'Automated, but its wording changed since — commit and ask Claude for a pass',
  waiting: 'Committed — waiting for Claude to automate it',
  none: 'Not committed yet',
};

// The file a committed item is written as (deterministic, so an unchanged item
// is an unchanged file). Every committed item is published.
export function coreFileText(item) {
  // eslint-disable-next-line no-unused-vars
  const { id, kind, published, clientKey, ...data } = item;
  return `${JSON.stringify({ id, kind, ...data }, null, 2)}\n`;
}

// A core file back into an item (null when it isn't one).
export function parseCoreFile(text, fileId = null) {
  try {
    const item = JSON.parse(text);
    if (!item || !isHomebrewId(item.id) || (fileId && item.id !== fileId)) return null;
    if (!['form', 'style', 'archetype'].includes(item.kind)) return null;
    return { ...item, published: true };
  } catch {
    return null;
  }
}

// What a commit would change: { files: [{ path, text }], add, change, remove }
// against the core's current texts (Map path → text or blob sha via `same`).
export function planCommit(items, existing, same = (path, text) => existing.get(path) === text) {
  const files = items.filter((i) => i.published).map((i) => ({ path: coreFilePath(i.id), text: coreFileText(i), name: i.name }));
  const want = new Set(files.map((f) => f.path));
  const add = files.filter((f) => !existing.has(f.path));
  const change = files.filter((f) => existing.has(f.path) && !same(f.path, f.text));
  const remove = [...existing.keys()].filter((p) => !want.has(p));
  return { files, add, change, remove };
}

// Claude's to-do list for "automate homebrew content": per core item, its
// wrench and each part's state ('new' | 'stale' | 'automated'), plus the
// automation left over from deleted items or parts (removed in the same pass).
export function automationReport(items, automation) {
  const ids = new Set(items.map((i) => i.id));
  const report = { items: [], orphanItems: [], orphanEntries: [] };
  for (const item of items) {
    const autoItem = automation?.items?.[item.id] ?? null;
    const parts = partsOf(item).map((p) => ({ ...p, state: autoItem ? partState(p, autoItem) : 'new' }));
    report.items.push({ id: item.id, name: item.name, kind: item.kind, wrench: wrenchState(item, { autoItem, inCore: true }), parts });
    const uids = new Set(parts.map((p) => p.uid));
    for (const uid of Object.keys(autoItem?.entries ?? {})) if (!uids.has(uid)) report.orphanEntries.push({ itemId: item.id, uid });
  }
  for (const id of Object.keys(automation?.items ?? {})) if (!ids.has(id)) report.orphanItems.push(id);
  return report;
}
