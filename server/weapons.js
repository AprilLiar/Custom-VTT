// The weapon a character is carrying — one, or none, which is the default.
//
// Kept in its own module for the same import-safety reason as combatBonuses.js:
// nothing here closes over a socket, so both server/index.js (the socket
// handlers) and server/roundResolution.js (the engine, which must never import
// index.js) can use it. `io` is passed in where a broadcast is wanted.
//
// **Written to be granted programmatically.** `grantWeapon` is the whole
// creation path — the socket handler calls it, and a Perk that arms its holder
// under some condition will call the same function with the same shape. There
// is deliberately no second way in.

import { one, run } from './db.js';
import { DIE_SIZES } from './gameLogic.js';

// The name the Weapon occupies in the Roll-slot and Attack-Target vocabularies
// (see moveLogic.js). Exported so nothing has to spell it as a string literal
// twice — it is matched exactly, like every other slot name.
export const WEAPON_SLOT = 'Weapon';

export async function getWeapon(characterId) {
  if (!Number.isInteger(Number(characterId))) return null;
  return (await one('SELECT * FROM weapons WHERE character_id = ?', [characterId])) ?? null;
}

// The one creation path. Replaces whatever the character was carrying — a
// character has one weapon, so arming them with a second is swapping, not
// stacking, and saying so here keeps the UNIQUE constraint from ever being the
// thing that reports it.
//
// Returns the stored row, or null when the request doesn't describe a weapon.
// Refusing rather than clamping: a d7 or a Durability of 0 is a mistake at the
// point it was typed, and a silently-corrected weapon is worse than a rejected
// one.
// A weapon changing hands changes what the Arena may offer: a Move whose Roll
// names the Weapon is closed to anyone carrying nothing. `io.emitCombatUpdated`
// is the same seam roundResolution.js uses to broadcast without importing
// index.js — absent in a unit test, and optional for exactly that reason.
function announceWeapon(io, characterId, weapon) {
  io?.emit?.('weapon:updated', { characterId, weapon });
  io?.emitCombatUpdated?.();
}

export async function grantWeapon(io, characterId, { name, dieSize, bonus = 0, durability } = {}) {
  const id = Number(characterId);
  const size = Number(dieSize);
  const dur = Math.trunc(Number(durability));
  const mod = Math.trunc(Number(bonus) || 0);
  const label = String(name ?? '').trim();
  if (!Number.isInteger(id) || !label || !DIE_SIZES.includes(size)) return null;
  if (!Number.isInteger(dur) || dur < 1) return null;

  await run('DELETE FROM weapons WHERE character_id = ?', [id]);
  await run(
    'INSERT INTO weapons (character_id, name, die_size, bonus, durability) VALUES (?, ?, ?, ?, ?)',
    [id, label, size, mod, dur]
  );
  const weapon = await getWeapon(id);
  announceWeapon(io, id, weapon);
  return weapon;
}

export async function removeWeapon(io, characterId) {
  const id = Number(characterId);
  if (!Number.isInteger(id)) return false;
  const existing = await getWeapon(id);
  if (!existing) return false;
  await run('DELETE FROM weapons WHERE character_id = ?', [id]);
  announceWeapon(io, id, null);
  return true;
}

// **What Durability is for (decided).** Rolling a weapon on its own — a check, a
// flourish, anything outside a Move — costs nothing. Using it in a **Move** costs
// 1, and at 0 the weapon is gone.
//
// Returns `{ weapon, destroyed }` describing the state AFTER the spend, so a
// caller can announce the right one of two very different sentences without
// re-reading the row.
export async function spendWeaponDurability(io, characterId, amount = 1) {
  const weapon = await getWeapon(characterId);
  if (!weapon) return { weapon: null, destroyed: false };
  const spend = Math.max(0, Math.trunc(Number(amount) || 0));
  const left = weapon.durability - spend;
  if (left <= 0) {
    await removeWeapon(io, characterId);
    return { weapon: { ...weapon, durability: 0 }, destroyed: true };
  }
  await run('UPDATE weapons SET durability = ? WHERE character_id = ?', [left, weapon.character_id]);
  const updated = await getWeapon(characterId);
  announceWeapon(io, weapon.character_id, updated);
  return { weapon: updated, destroyed: false };
}

// A weapon shaped like the die rows every roll path already speaks, so a Move
// whose Roll names the Weapon slot can hand it straight to `rollTotal` with the
// character's own Stat dice. `current_size`/`bonus`/`status` are the three
// fields those paths read; nothing else about a weapon is a die's business.
export function weaponDie(weapon) {
  if (!weapon) return null;
  return {
    slot_name: WEAPON_SLOT,
    current_size: weapon.die_size,
    bonus: weapon.bonus,
    status: 'active',
  };
}

// **Does an attack aimed at a weapon break it? (decided, pure.)** The attacker's
// own already-made roll against the weapon's own — one number each, no
// threshold, no damage.
//
// A tie holds. The defensive outcome wins ambiguity here for the same reason it
// does everywhere else in this game: destroying a thing outright is the bigger
// consequence, and it should need to be earned outright.
export function weaponBreaks({ attackerTotal, weaponTotal }) {
  return Number(attackerTotal) > Number(weaponTotal);
}
