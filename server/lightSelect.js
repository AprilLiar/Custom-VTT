// **Lists without picture bytes (play feedback 8 — the slow Scenes list).**
// A list row only needs to know a picture exists (and its hash, for the URL);
// `SELECT *` dragged every Scene's backdrop and Combat Background, every
// character's portrait … over the wire from Turso just to throw them away.
// `lightColumns(table)` is the table's columns with each `*image_data`
// column replaced by `has_<column>` (0/1), read once per table (after boot,
// so columns added by `ensureColumn` are in it). withImageUrl / shapeScene
// read the flags.
import { all } from './db.js';

const TABLES = new Set(['scenes', 'characters', 'temp_npcs', 'scene_pictures']);
const cache = new Map();
const isData = (name) => /(^|_)image_data$/.test(name);

export async function lightColumns(table) {
  if (!TABLES.has(table)) throw new Error(`lightColumns: ${table} is not a known table`);
  if (!cache.has(table)) {
    const cols = (await all(`PRAGMA table_info(${table})`)).map((c) => c.name);
    cache.set(table, cols.map((c) => (isData(c) ? `(${c} IS NOT NULL AND ${c} != '') AS has_${c}` : c)).join(', '));
  }
  return cache.get(table);
}

// `SELECT <light columns> FROM table <rest>`.
export async function lightAll(table, rest = '', args = []) {
  return all(`SELECT ${await lightColumns(table)} FROM ${table} ${rest}`, args);
}

// Tests.
export const _resetLightColumns = () => cache.clear();
