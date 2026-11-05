// A fighter's Stances in a fight come from their character's build (builder
// phase 2 — vttprojectplan.md, "Character builder & turn automation"): the
// derived Stances (client/src/lib/patd/build.js), keyed "form.x+style.y".
// Everything a fight needs from a build is read here.
import { all } from './db.js';
import { armorSourcesOf, deriveBuild, hpTableOf, normalizeBuild } from '../client/src/lib/patd/build.js';
import { rollStance } from '../client/src/lib/stanceDice.js';
import { patdContent } from './patdContent.js';

const cache = new Map(); // raw JSON → derived
function derive(rawJson) {
  if (cache.has(rawJson)) return cache.get(rawJson);
  let d = null;
  try {
    d = deriveBuild(normalizeBuild(JSON.parse(rawJson), patdContent()), patdContent());
  } catch {
    d = null;
  }
  if (cache.size > 500) cache.clear();
  cache.set(rawJson, d);
  return d;
}

// Map(characterId → derived build) for every character with a build.
export async function loadAllDerived() {
  const rows = await all('SELECT character_id, data FROM character_builds');
  return new Map(rows.map((r) => [r.character_id, derive(r.data)]).filter(([, d]) => d));
}

export async function derivedFor(characterId) {
  if (characterId == null) return null;
  const rows = await all('SELECT data FROM character_builds WHERE character_id = ?', [Number(characterId)]);
  return rows[0] ? derive(rows[0].data) : null;
}

// [{ id, name, dice }] — empty for a Temp NPC, a character without a build,
// or a Frantic Hero (they assemble a Stance each turn; builder phase 4).
export async function stancesOf(characterId) {
  const d = await derivedFor(characterId);
  return (d?.stances ?? []).filter((s) => s.formId && s.styleId).map((s) => ({ id: s.key, name: s.name, dice: s.dice }));
}

// Rolls a derived Stance's dice. Each result keeps its colour, and the level's
// bonus die is marked `bonus` (its tile says so in the chat card).
export function rollDerived(dice) {
  const slots = dice.map((d) => (d.kind === 'fixed' ? { fixed: d.value } : { die: d.sides }));
  return rollStance(slots).map((r, i) => ({ ...r, ...(dice[i].color ? { color: dice[i].color } : {}), ...(dice[i].bonus ? { bonus: true } : {}) }));
}

// What the Scene's token rows need per fighter (`fighterSetup`).
export function setupFromDerived(d) {
  const idx = patdContent();
  return {
    unique_tokens: d.tokens,
    armor_sources: armorSourcesOf(d, idx),
    stances: d.stances.filter((s) => s.formId && s.styleId).map((s) => ({ id: s.key, name: s.name })),
    level: d.level.level,
    kind: hpTableOf(d),
    health_bars: d.healthBars,
  };
}
