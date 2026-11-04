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
import { normalizeUniqueKeys } from '../client/src/lib/panicTokens.js';
import { STANCES_PER_OWNER_MAX, STANCE_NAME_MAX, normalizeDice } from '../client/src/lib/stanceDice.js';

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
  };
  if (!row) return base;
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
  'id, image_hash, crop_x, crop_y, crop_w, crop_h, unique_tokens, (image_data IS NOT NULL) AS has_image';

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

// ---------------------------------------------------------------- validation

// A reminder's target, resolved against the database: only `others` reminders
// target anyone, and `one` must name a fighter who exists. Returns the column
// values, or null when the target is unusable.
async function resolveTarget(scope, target, targetType, targetId) {
  if (scope !== 'others') return { target: 'any', characterId: null, tempNpcId: null };
  const t = REMINDER_TARGETS.has(target) ? target : 'any';
  if (t !== 'one') return { target: t, characterId: null, tempNpcId: null };
  const named = parseOwner(targetType, targetId);
  if (!named || !(await ownerExists(named))) return null;
  return {
    target: 'one',
    characterId: named.ownerType === 'character' ? named.ownerId : null,
    tempNpcId: named.ownerType === 'temp_npc' ? named.ownerId : null,
  };
}

const cleanText = (text) => String(text ?? '').trim().slice(0, REMINDER_TEXT_MAX);
const cleanName = (name) => String(name ?? '').trim().slice(0, STANCE_NAME_MAX);

const ownerOfRow = (row) =>
  row.character_id != null
    ? { ownerType: 'character', ownerId: row.character_id }
    : { ownerType: 'temp_npc', ownerId: row.temp_npc_id };

// A reminder's stance binding: null (any stance) or one of the OWNER's own
// stances. `undefined` means "not given". Returns { ok, stanceId }.
async function resolveStance(owner, stanceId) {
  if (stanceId === undefined || stanceId === null || stanceId === '') return { ok: true, stanceId: null };
  const row = await one(
    `SELECT id FROM combat_stances WHERE id = ? AND ${ownerColumn(owner.ownerType)} = ?`,
    [Number(stanceId), owner.ownerId]
  );
  return row ? { ok: true, stanceId: row.id } : { ok: false, stanceId: null };
}

// ---------------------------------------------------------------- handlers

// `deps`: index.js's own helpers, passed in rather than imported so this file
// does not reach back into index.js.
//   on(event, handler)  — the socket's wrapped listener
//   socket, io
//   mayWrite(viewer, ownerType, ownerId)
//   cropValues(payload) → [x, y, w, h]
//   stampImageHash(kind, id)
export function registerCombatSetupHandlers({ on, socket, io, mayWrite, cropValues, stampImageHash }) {
  const allowed = (owner) => owner && mayWrite(socket.data.identity, owner.ownerType, owner.ownerId);

  const emitProfile = async (owner) =>
    io.emit('combat_profile:updated', { ownerType: owner.ownerType, ownerId: owner.ownerId, profile: await loadProfile(owner) });
  const emitStances = async (owner) =>
    io.emit('combat_stances:updated', {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      stances: await loadStances(owner),
    });
  const emitReminders = async (owner) =>
    io.emit('combat_reminders:updated', {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      reminders: await loadReminders(owner),
    });

  // Saves whichever parts are present: a new token picture (with its crop),
  // `clearImage` to remove it, and/or the Unique token selection. Absent
  // fields are left alone — the same contract temp_npc:update uses.
  on('combat_profile:update', async ({ ownerType, ownerId, imageData, imageMimeType, clearImage, uniqueTokens, ...crop }) => {
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
    if (uniqueTokens !== undefined) {
      await run('UPDATE combat_profiles SET unique_tokens = ? WHERE id = ?', [
        JSON.stringify(normalizeUniqueKeys(uniqueTokens)),
        row.id,
      ]);
    }
    await emitProfile(owner);
  });

  // ---- Stances
  on('combat_stance:create', async ({ ownerType, ownerId, name, dice }) => {
    const owner = parseOwner(ownerType, ownerId);
    if (!allowed(owner) || !(await ownerExists(owner))) return;
    const stanceName = cleanName(name);
    const pool = normalizeDice(dice);
    if (!stanceName || !pool) return;
    const count = await one(
      `SELECT COUNT(*) AS n FROM combat_stances WHERE ${ownerColumn(owner.ownerType)} = ?`,
      [owner.ownerId]
    );
    if (Number(count?.n) >= STANCES_PER_OWNER_MAX) return;
    await run(`INSERT INTO combat_stances (${ownerColumn(owner.ownerType)}, name, dice) VALUES (?, ?, ?)`, [
      owner.ownerId,
      stanceName,
      JSON.stringify(pool),
    ]);
    await emitStances(owner);
  });

  on('combat_stance:update', async ({ stanceId, name, dice }) => {
    const row = await one('SELECT * FROM combat_stances WHERE id = ?', [Number(stanceId)]);
    if (!row) return;
    const owner = ownerOfRow(row);
    if (!allowed(owner)) return;
    const stanceName = name === undefined ? row.name : cleanName(name);
    const pool = dice === undefined ? JSON.parse(row.dice) : normalizeDice(dice);
    if (!stanceName || !pool) return;
    await run('UPDATE combat_stances SET name = ?, dice = ? WHERE id = ?', [stanceName, JSON.stringify(pool), row.id]);
    await emitStances(owner);
  });

  // Reminders bound to it are unbound, not deleted — their text is kept.
  on('combat_stance:delete', async ({ stanceId }) => {
    const row = await one('SELECT * FROM combat_stances WHERE id = ?', [Number(stanceId)]);
    if (!row) return;
    const owner = ownerOfRow(row);
    if (!allowed(owner)) return;
    await run('UPDATE combat_reminders SET stance_id = NULL WHERE stance_id = ?', [row.id]);
    await run('DELETE FROM combat_stances WHERE id = ?', [row.id]);
    await emitStances(owner);
    await emitReminders(owner);
  });

  // ---- Reminders
  on('combat_reminder:create', async ({ ownerType, ownerId, scope, timing, target, targetType, targetId, text, stanceId }) => {
    const owner = parseOwner(ownerType, ownerId);
    if (!allowed(owner) || !(await ownerExists(owner))) return;
    if (!REMINDER_SCOPES.has(scope) || !REMINDER_TIMINGS.has(timing)) return;
    const body = cleanText(text);
    if (!body) return;
    const count = await one(
      `SELECT COUNT(*) AS n FROM combat_reminders WHERE ${ownerColumn(owner.ownerType)} = ?`,
      [owner.ownerId]
    );
    if (Number(count?.n) >= REMINDERS_PER_OWNER_MAX) return;
    const resolved = await resolveTarget(scope, target, targetType, targetId);
    if (!resolved) return;
    const stance = await resolveStance(owner, stanceId);
    if (!stance.ok) return;
    await run(
      `INSERT INTO combat_reminders (${ownerColumn(owner.ownerType)}, scope, timing, target, target_character_id, target_temp_npc_id, text, stance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner.ownerId, scope, timing, resolved.target, resolved.characterId, resolved.tempNpcId, body, stance.stanceId]
    );
    await emitReminders(owner);
  });

  // The scope (column) never changes; timing, target and text may.
  on('combat_reminder:update', async ({ reminderId, timing, target, targetType, targetId, text, stanceId }) => {
    const row = await one('SELECT * FROM combat_reminders WHERE id = ?', [Number(reminderId)]);
    if (!row) return;
    const owner =
      row.character_id != null
        ? { ownerType: 'character', ownerId: row.character_id }
        : { ownerType: 'temp_npc', ownerId: row.temp_npc_id };
    if (!allowed(owner)) return;
    const nextTiming = REMINDER_TIMINGS.has(timing) ? timing : row.timing;
    const body = text === undefined ? row.text : cleanText(text);
    if (!body) return;
    let resolved = {
      target: row.target,
      characterId: row.target_character_id,
      tempNpcId: row.target_temp_npc_id,
    };
    if (target !== undefined) {
      resolved = await resolveTarget(row.scope, target, targetType, targetId);
      if (!resolved) return;
    }
    let boundStance = row.stance_id ?? null;
    if (stanceId !== undefined) {
      const stance = await resolveStance(owner, stanceId);
      if (!stance.ok) return;
      boundStance = stance.stanceId;
    }
    await run(
      'UPDATE combat_reminders SET timing = ?, target = ?, target_character_id = ?, target_temp_npc_id = ?, text = ?, stance_id = ? WHERE id = ?',
      [nextTiming, resolved.target, resolved.characterId, resolved.tempNpcId, body, boundStance, row.id]
    );
    await emitReminders(owner);
  });

  on('combat_reminder:delete', async ({ reminderId }) => {
    const row = await one('SELECT * FROM combat_reminders WHERE id = ?', [Number(reminderId)]);
    if (!row) return;
    const owner =
      row.character_id != null
        ? { ownerType: 'character', ownerId: row.character_id }
        : { ownerType: 'temp_npc', ownerId: row.temp_npc_id };
    if (!allowed(owner)) return;
    await run('DELETE FROM combat_reminders WHERE id = ?', [row.id]);
    await emitReminders(owner);
  });
}

// The cascade for a deleted owner, spelled out like every other delete in
// index.js rather than trusted to the DDL. Reminders that NAME the deleted
// fighter as their target fall back to "anyone" rather than vanishing, so a
// player's written text is never lost to someone else's deletion.
export async function deleteCombatSetupFor(ownerType, ownerId) {
  const col = ownerColumn(ownerType);
  const targetCol = ownerType === 'character' ? 'target_character_id' : 'target_temp_npc_id';
  await run(`DELETE FROM combat_reminders WHERE ${col} = ?`, [ownerId]);
  await run(`DELETE FROM combat_stances WHERE ${col} = ?`, [ownerId]);
  await run(`UPDATE combat_reminders SET target = 'any', ${targetCol} = NULL WHERE ${targetCol} = ?`, [ownerId]);
  await run(`DELETE FROM combat_profiles WHERE ${col} = ?`, [ownerId]);
}
