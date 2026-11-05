// A fighter's Combat tab: the round token picture, which Unique tokens they
// use, and their Reminders (Panic at the Dojo — see vttprojectplan.md, "Game
// system — Panic at the Dojo combat assistant").
//
// One owner is exactly one of a Character or a Temp NPC, the same split
// scene_pictures uses. Write access is the Scene Pictures rule
// (`mayWrite`): the GM always, a Player only for their own character, and a
// Temp NPC is GM-only because nobody plays one.
//
// Kept out of index.js on purpose: it is a self-contained feature with its own
// tables, and index.js is already the size that makes a file hard to read.
import { all, one, run } from './db.js';
import { imageUrl, sanitizeImageMime } from './images.js';
import { normalizeArmorSources, normalizeUniqueKeys } from '../client/src/lib/panicTokens.js';
import { normalizeDice } from '../client/src/lib/stanceDice.js';

export const OWNER_TYPES = new Set(['character', 'temp_npc']);
export const REMINDER_SCOPES = new Set(['self', 'others', 'round']);
export const REMINDER_TIMINGS = new Set(['start', 'end']);
export const REMINDER_TARGETS = new Set(['any', 'allies', 'enemies', 'one']);
export const REMINDER_TEXT_MAX = 500;
// Generous: three columns of reminders is a page, not a database.
export const REMINDERS_PER_OWNER_MAX = 60;

const ownerColumn = (ownerType) => (ownerType === 'character' ? 'character_id' : 'temp_npc_id');
const ownerTable = (ownerType) => (ownerType === 'character' ? 'characters' : 'temp_npcs');

// `{ ownerType, ownerId }` from the wire, or null if it does not name a
// possible owner. Existence is checked separately (`ownerExists`).
export function parseOwner(ownerType, ownerId) {
  const id = Number(ownerId);
  if (!OWNER_TYPES.has(ownerType) || !Number.isInteger(id) || id <= 0) return null;
  return { ownerType, ownerId: id };
}

async function ownerExists({ ownerType, ownerId }) {
  return Boolean(await one(`SELECT id FROM ${ownerTable(ownerType)} WHERE id = ?`, [ownerId]));
}

// ---------------------------------------------------------------- shaping

// A profile as clients receive it: the token picture as a URL (never bytes),
// the crop, and the Unique token keys as an array. A fighter with no row yet
// gets the same shape with nothing in it.
export function shapeProfile(row, owner) {
  const base = {
    owner_type: owner.ownerType,
    owner_id: owner.ownerId,
    image_url: null,
    crop_x: null,
    crop_y: null,
    crop_w: null,
    crop_h: null,
    unique_tokens: [],
    armor_sources: [],
  };
  if (!row) return base;
  let armor = [];
  try {
    armor = normalizeArmorSources(JSON.parse(row.armor_sources || '[]'));
  } catch {
    armor = [];
  }
  let unique = [];
  try {
    unique = normalizeUniqueKeys(JSON.parse(row.unique_tokens || '[]'));
  } catch {
    unique = [];
  }
  return {
    ...base,
    image_url: imageUrl('combat-token', row.id, { present: row.has_image, hash: row.image_hash }),
    crop_x: row.crop_x,
    crop_y: row.crop_y,
    crop_w: row.crop_w,
    crop_h: row.crop_h,
    unique_tokens: unique,
    armor_sources: armor,
  };
}

export function shapeReminder(row) {
  return {
    id: row.id,
    scope: row.scope,
    timing: row.timing,
    target: row.target,
    target_type: row.target_character_id != null ? 'character' : row.target_temp_npc_id != null ? 'temp_npc' : null,
    target_id: row.target_character_id ?? row.target_temp_npc_id ?? null,
    stance_id: row.stance_id ?? null,
    text: row.text,
  };
}

export function shapeStance(row) {
  let dice = null;
  try {
    dice = normalizeDice(JSON.parse(row.dice));
  } catch {
    dice = null;
  }
  return { id: row.id, name: row.name, dice: dice ?? [{ die: 6 }] };
}

export async function loadStances(owner) {
  const rows = await all(
    `SELECT * FROM combat_stances WHERE ${ownerColumn(owner.ownerType)} = ? ORDER BY id`,
    [owner.ownerId]
  );
  return rows.map(shapeStance);
}

// Every Stance of every fighter, keyed like loadAllProfiles — what a fight
// needs to roll a turn or show a picker.
export async function loadAllStances() {
  const rows = await all('SELECT * FROM combat_stances ORDER BY id');
  const out = {};
  for (const row of rows) {
    const key = row.character_id != null ? `character:${row.character_id}` : `temp_npc:${row.temp_npc_id}`;
    (out[key] ??= []).push(shapeStance(row));
  }
  return out;
}

// Never selects the picture bytes — `has_image` says whether there is one.
const PROFILE_COLUMNS =
  'id, image_hash, crop_x, crop_y, crop_w, crop_h, unique_tokens, armor_sources, (image_data IS NOT NULL) AS has_image';

export async function loadProfile(owner) {
  const row = await one(
    `SELECT ${PROFILE_COLUMNS} FROM combat_profiles WHERE ${ownerColumn(owner.ownerType)} = ?`,
    [owner.ownerId]
  );
  return shapeProfile(row, owner);
}

export async function loadReminders(owner) {
  const rows = await all(
    `SELECT * FROM combat_reminders WHERE ${ownerColumn(owner.ownerType)} = ? ORDER BY id`,
    [owner.ownerId]
  );
  return rows.map(shapeReminder);
}

// Every profile at once, keyed `character:<id>` / `temp_npc:<id>` — what the
// Scene's combat views need to draw any fighter's token and token row.
export async function loadAllProfiles() {
  const rows = await all(`SELECT character_id, temp_npc_id, ${PROFILE_COLUMNS} FROM combat_profiles`);
  const out = {};
  for (const row of rows) {
    const owner =
      row.character_id != null
        ? { ownerType: 'character', ownerId: row.character_id }
        : { ownerType: 'temp_npc', ownerId: row.temp_npc_id };
    out[`${owner.ownerType}:${owner.ownerId}`] = shapeProfile(row, owner);
  }
  return out;
}

// ---------------------------------------------------------------- handlers

// `deps`: index.js's own helpers, passed in rather than imported so this file
// does not reach back into index.js.
//   on(event, handler)  — the socket's wrapped listener
//   socket, io
//   mayWrite(viewer, ownerType, ownerId)
//   cropValues(payload) → [x, y, w, h]
//   stampImageHash(kind, id)
export function registerCombatSetupHandlers({ on, socket, io, mayWrite, cropValues, stampImageHash, emitStageUpdated = async () => {} }) {
  // Characters only: Temp NPCs take no part in combat (decided).
  const allowed = (owner) => owner && owner.ownerType === 'character' && mayWrite(socket.data.identity, owner.ownerType, owner.ownerId);

  // Also refreshes the Scene, whose token rows read the profile.
  const emitProfile = async (owner) => {
    io.emit('combat_profile:updated', { ownerType: owner.ownerType, ownerId: owner.ownerId, profile: await loadProfile(owner) });
    await emitStageUpdated();
  };
  // Saves whichever parts are present: a new token picture (with its crop), or
  // `clearImage` to remove it. Absent fields are left alone. (Unique token
  // picks and Armor sources were removed with the builder's phase 0 purge.)
  on('combat_profile:update', async ({ ownerType, ownerId, imageData, imageMimeType, clearImage, ...crop }) => {
    const owner = parseOwner(ownerType, ownerId);
    if (!allowed(owner) || !(await ownerExists(owner))) return;
    const col = ownerColumn(owner.ownerType);
    await run(`INSERT OR IGNORE INTO combat_profiles (${col}) VALUES (?)`, [owner.ownerId]);
    const row = await one(`SELECT id FROM combat_profiles WHERE ${col} = ?`, [owner.ownerId]);
    if (imageData) {
      await run(
        'UPDATE combat_profiles SET image_data = ?, image_mime_type = ?, crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ? WHERE id = ?',
        [String(imageData), sanitizeImageMime(imageMimeType, 'image/png'), ...cropValues(crop), row.id]
      );
      await stampImageHash('combat-token', row.id);
    } else if (clearImage) {
      await run(
        'UPDATE combat_profiles SET image_data = NULL, image_mime_type = NULL, image_hash = NULL, crop_x = NULL, crop_y = NULL, crop_w = NULL, crop_h = NULL WHERE id = ?',
        [row.id]
      );
    }
    await emitProfile(owner);
  });

}

// The cascade for a deleted owner, spelled out like every other delete in
// index.js rather than trusted to the DDL. Reminders that NAME the deleted
// fighter as their target fall back to "anyone" rather than vanishing, so a
// player's written text is never lost to someone else's deletion.
// **Temp NPCs take no part in combat (decided).** Run at every boot: removes
// any combat data a Temp NPC still holds from before that decision — their
// tokens and miniatures' fight state, Combat setup, and Reminders naming them.
// Idempotent; nothing creates such rows any more.
// **Builder phase 0 (decided): the hand-made Combat setup is purged.** Run at
// every boot until the builder's phase 2 replaces these sources: deletes every
// hand-made Stance and Reminder, clears Unique token picks and Armor sources,
// and every token's chosen Stance. Nothing can create them any more (their
// events are gone), so this is idempotent. Only the token picture stays.
export async function purgeHandmadeCombatSetup() {
  await run('DELETE FROM combat_reminders');
  await run('DELETE FROM combat_stances');
  await run("UPDATE combat_profiles SET unique_tokens = '[]', armor_sources = '[]' WHERE unique_tokens != '[]' OR armor_sources != '[]'");
}

export async function purgeTempNpcCombat() {
  const rows = await all('SELECT id FROM combatants WHERE temp_npc_id IS NOT NULL');
  for (const r of rows) await run('UPDATE combatants SET challenge_id = NULL WHERE challenge_id = ?', [r.id]);
  await run('DELETE FROM combatants WHERE temp_npc_id IS NOT NULL');
  await run('DELETE FROM combat_reminders WHERE temp_npc_id IS NOT NULL');
  await run('DELETE FROM combat_stances WHERE temp_npc_id IS NOT NULL');
  await run('DELETE FROM combat_profiles WHERE temp_npc_id IS NOT NULL');
  await run("UPDATE combat_reminders SET target = 'any', target_temp_npc_id = NULL WHERE target_temp_npc_id IS NOT NULL");
  return rows.length;
}

export async function deleteCombatSetupFor(ownerType, ownerId) {
  const col = ownerColumn(ownerType);
  const targetCol = ownerType === 'character' ? 'target_character_id' : 'target_temp_npc_id';
  await run(`DELETE FROM combat_reminders WHERE ${col} = ?`, [ownerId]);
  await run(`DELETE FROM combat_stances WHERE ${col} = ?`, [ownerId]);
  await run(`UPDATE combat_reminders SET target = 'any', ${targetCol} = NULL WHERE ${targetCol} = ?`, [ownerId]);
  await run(`DELETE FROM combat_profiles WHERE ${col} = ?`, [ownerId]);
}
