// Perk resolution — the bridge between a granted Perk and the decisions the
// engine already makes.
//
// **The architecture and the rules for writing a Perk live in
// server/perks/index.js.** This file is only the machinery: it looks up which
// granted Perks have code behind them, folds their contributions to a given
// seam, and owns their per-grant scratch state.
//
// **Import-safe on purpose.** Only `db.js` and pure modules, never
// `server/index.js` — that module boots a real HTTP server at import time, so
// anything importing it (a test file above all) starts one. `io` is taken as an
// explicit parameter wherever a broadcast is needed, exactly as
// roundResolution.js and combatBonuses.js already do, and a Perk definition
// receives it through its ctx rather than importing it.

import { all, one, run } from './db.js';
import { perkDefinition } from './perks/index.js';

// A character's granted Perks that actually have code behind them, paired with
// their own `character_perks.id` — the key their private state hangs off.
//
// Granted Perks with no definition are simply absent: a Perk that is pure
// flavour is the normal case, not an error, and must never make a resolver
// throw. Ordered by grant so a fold is at least deterministic, even though
// every seam below is order-independent by design.
export async function perkDefinitionsFor(characterId) {
  if (characterId == null) return [];
  const rows = await all(
    `SELECT p.name AS name, cp.id AS characterPerkId
     FROM character_perks cp JOIN perks p ON p.id = cp.perk_id
     WHERE cp.character_id = ? ORDER BY cp.id`,
    [characterId]
  );
  const out = [];
  for (const row of rows) {
    const definition = perkDefinition(row.name);
    if (definition) out.push({ definition, name: row.name, characterPerkId: row.characterPerkId });
  }
  return out;
}

// The context every seam function receives. Built once per resolution rather
// than per Perk, so ten Perks on one roll is still one character read.
async function seamContext(characterId, extra = {}) {
  const character = await one('SELECT * FROM characters WHERE id = ?', [characterId]);
  return { characterId, character, ...extra };
}

// ---------------------------------------------------------------------------
// Seam resolvers
//
// Each one folds every granted Perk's contribution. **Additive or boolean-OR,
// never ordered** — see the doctrine in perks/index.js. That is what lets a
// character carry any number of Perks without anybody reasoning about which
// one "wins": none of them do, they all just count.
// ---------------------------------------------------------------------------

// Flat modifier on every roll this character makes, as ONE NAMED TERM PER PERK
// rather than a single lump — a Perk that moves a total has to be readable in
// the roll's own breakdown, or it is indistinguishable from the engine
// inventing numbers. Zero contributions are dropped, matching how
// getCombatRollBonusBreakdown drops its own zero terms.
export async function perkRollBonusTerms(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.rollBonus === 'function');
  if (!withSeam.length) return [];
  const ctx = await seamContext(characterId, extra);
  const terms = [];
  for (const { definition, name, characterPerkId } of withSeam) {
    const amount = Math.trunc(Number(await definition.rollBonus({ ...ctx, characterPerkId })) || 0);
    if (amount) terms.push({ key: `perk:${name}`, label: name, amount });
  }
  return terms;
}

// Whether this character may read a publicly revealed move in full (Genius
// Observer). OR-ed: any one Perk saying yes is a yes.
export async function perkAllowsRevealedDetail(characterId, extra = {}) {
  const granted = await perkDefinitionsFor(characterId);
  const withSeam = granted.filter((g) => typeof g.definition.canSeeRevealedDetail === 'function');
  if (!withSeam.length) return false;
  const ctx = await seamContext(characterId, extra);
  for (const { definition, characterPerkId } of withSeam) {
    if (await definition.canSeeRevealedDetail({ ...ctx, characterPerkId })) return true;
  }
  return false;
}

// How many qualifying idle Tics this character needs per point of Stamina
// regen — 1 unless a granted Perk says otherwise.
//
// **The one seam that is not additive**, and it is worth saying exactly what it
// does instead, because a rate runs the opposite way from a contribution: a
// HIGHER value is a stricter Perk, not a stronger one (the shape this seam was
// designed around is "regen 1 Stamina for every 2 Tics you spend blocking" — a
// restriction bundled with a benefit that lives elsewhere). Summing would be
// nonsense, so the strictest requirement wins. That keeps it order-independent
// like every other seam — the previous version took "the first granted Perk
// with an entry", which quietly depended on grant order — and means a
// restriction can never be dodged by picking up a second Perk.
//
// Pure, and takes names rather than reading the database, so it stays a drop-in
// for the idleStaminaRegenRate this replaces and its existing tests keep
// working unchanged.
export function idleStaminaRegenRate(perkNames) {
  let rate = 1;
  for (const name of perkNames ?? []) {
    const definition = perkDefinition(name);
    const value = Math.trunc(Number(definition?.idleStaminaRegen) || 0);
    if (value > 0) rate = Math.max(rate, value);
  }
  return rate;
}

// ---------------------------------------------------------------------------
// Per-grant state (character_perk_state)
// ---------------------------------------------------------------------------

export async function readPerkState(characterPerkId, key) {
  const row = await one(
    'SELECT value FROM character_perk_state WHERE character_perk_id = ? AND key = ?',
    [characterPerkId, key]
  );
  return row?.value ?? 0;
}

export async function writePerkState(characterPerkId, key, value, scope = 'round') {
  await run(
    `INSERT INTO character_perk_state (character_perk_id, key, value, scope)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(character_perk_id, key) DO UPDATE SET value = excluded.value, scope = excluded.scope`,
    [characterPerkId, key, Math.trunc(Number(value) || 0), scope]
  );
}

// "Has this Perk already fired this round/fight?" — asked and answered in one
// call, because every caller wants both halves and splitting them is how a
// once-per-round effect ends up firing twice.
//
// Returns true the first time and false afterwards, until the scope resets.
export async function consumeOnce(characterPerkId, key, scope = 'round') {
  if (await readPerkState(characterPerkId, key)) return false;
  await writePerkState(characterPerkId, key, 1, scope);
  return true;
}

// Wipe one scope's rows for a set of characters.
//
// **`characterIds` is not optional, and that is deliberate.** A round in this
// game belongs to a *pair*, not to the arena — each pair runs its own clock and
// advances on its own (see combat_pairs). Clearing round-scoped state globally
// would refresh a fighter's once-per-round charge because an unrelated fight
// somewhere else started its next round, which is the exact class of bug the
// per-pair redesign has already produced twice elsewhere. Callers pass the
// characters the reset actually applies to.
export async function clearPerkState(scope, characterIds) {
  const ids = (characterIds ?? []).filter((id) => Number.isInteger(Number(id)));
  if (!ids.length) return;
  await run(
    `DELETE FROM character_perk_state
     WHERE scope = ?
       AND character_perk_id IN (
         SELECT id FROM character_perks WHERE character_id IN (${ids.map(() => '?').join(',')})
       )`,
    [scope, ...ids]
  );
}

// The global wipe, for a scope that genuinely is global. A **fight** ending is
// one — combat:end and combat:clear both tear down every pair, every seat and
// every declaration at once — and a character who left the arena mid-fight
// still has to lose their fight-scoped state, which a seated-characters-only
// sweep would miss.
//
// Deliberately its own exported name rather than a null default on
// clearPerkState above: "clear everywhere" has to be something a caller asks
// for on purpose, so that a round-scoped reset can never reach it by leaving an
// argument off.
export async function clearAllPerkState(scope) {
  await run('DELETE FROM character_perk_state WHERE scope = ?', [scope]);
}
