// A fighter's Stances in a fight come from their character's build (builder
// phase 2 — vttprojectplan.md, "Character builder & turn automation"): the
// derived Stances (client/src/lib/patd/build.js), keyed "form.x+style.y".
// Everything a fight needs from a build is read here.
import { all } from './db.js';
import { armorSourcesOf, deriveBuild, deriveStance, hpTableOf, normalizeBuild, stanceOfBuild } from '../client/src/lib/patd/build.js';
import { rollStance } from '../client/src/lib/stanceDice.js';
import { contentVersion, patdContent } from './patdContent.js';

const cache = new Map(); // content version + raw JSON → derived
function derive(rawJson) {
  const key = `${contentVersion()}|${rawJson}`;
  if (cache.has(key)) return cache.get(key);
  let d = null;
  try {
    d = deriveBuild(normalizeBuild(JSON.parse(rawJson), patdContent()), patdContent());
  } catch {
    d = null;
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, d);
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

// The Stance a key names for this character's build ({ id, name, dice }), or
// null. Frantic Heroes may name any known Form + Style pair.
export async function stanceByKey(characterId, key) {
  const s = stanceOfBuild(await derivedFor(characterId), key, patdContent());
  return s ? { id: s.key, name: s.name, dice: s.dice } : null;
}

// A combatant's Frantic pick this turn, or null.
export function franticPickOf(row) {
  try {
    const v = JSON.parse(row?.frantic_pick || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// Whether this build assembles its Stance each turn (and can: it knows a Form and a Style).
export const assembles = (d) => Boolean(d?.type.assemble && d.formIds.length && d.styleIds.length);

// Rolls a derived Stance's dice. Each result keeps its colour, and the level's
// bonus die is marked `bonus` (its tile says so in the chat card).
export function rollDerived(dice) {
  const slots = dice.map((d) => (d.kind === 'fixed' ? { fixed: d.value } : { die: d.sides }));
  return rollStance(slots).map((r, i) => ({ ...r, ...(dice[i].color ? { color: dice[i].color } : {}), ...(dice[i].bonus ? { bonus: true } : {}) }));
}

// A lasting `armor.first_trigger_reduction` of the build's constant Abilities, or null.
function firstReduction(d, idx) {
  for (const id of d.constantAbilityIds ?? []) {
    for (const r of idx.get(id)?.rules ?? []) {
      if (!r.events?.includes('continuous')) continue;
      const nodes = r.effect?.op === 'sequence' ? r.effect.steps : [r.effect];
      const n = nodes.find((x) => x?.op === 'modify_rule' && x.rule === 'armor.first_trigger_reduction');
      if (n) return Number(n.value) || null;
    }
  }
  return null;
}

// What the Scene's token rows need per fighter (`fighterSetup`).
export function setupFromDerived(d) {
  const idx = patdContent();
  const first = firstReduction(d, idx);
  return {
    unique_tokens: d.tokens,
    armor_sources: armorSourcesOf(d, idx),
    // A Frantic Hero's every Form + Style pair, so whichever was picked has a name.
    stances: d.type.assemble
      ? d.formIds.flatMap((formId) => d.styleIds.map((styleId) => deriveStance({ formId, styleId }, idx, d.level.bonusDie))).map((s) => ({ id: s.key, name: s.name }))
      : d.stances.filter((s) => s.formId && s.styleId).map((s) => ({ id: s.key, name: s.name })),
    assembles: Boolean(d.type.assemble),
    level: d.level.level,
    kind: hpTableOf(d),
    health_bars: d.healthBars,
    // The Tank: their Armor blocks 10 the first time it triggers (its ring is
    // black). Only when set: this rides on every stage payload, per character.
    ...(first != null ? { armor_first_reduction: first } : {}),
  };
}
