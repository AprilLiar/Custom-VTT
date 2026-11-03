async function json(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

const post = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
const put = { method: 'PUT', headers: { 'Content-Type': 'application/json' } };

export const getCharacters = () => fetch('/api/characters').then(json);
export const getCharacterFolders = () => fetch('/api/character-folders').then(json);
export const getCharacter = (id) => fetch(`/api/characters/${id}`).then(json);
export const createCharacter = (body) =>
  fetch('/api/characters', { ...post, body: JSON.stringify(body) }).then(json);
export const updateCharacter = (id, body) =>
  fetch(`/api/characters/${id}`, { ...put, body: JSON.stringify(body) }).then(json);
export const deleteCharacter = (id) =>
  fetch(`/api/characters/${id}`, { method: 'DELETE' }).then(json);
export const getChat = () => fetch('/api/chat').then(json);
export const search = (q) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then(json);
// ownerType is 'character' | 'temp_npc' — see scene_pictures' own CHECK.
export const getScenePictures = (ownerType, ownerId) =>
  fetch(`/api/scene-pictures?${new URLSearchParams({ ownerType, ownerId })}`).then(json);
export const getTempNpcs = () => fetch('/api/temp-npcs').then(json);
export const getTempNpcFolders = () => fetch('/api/temp-npc-folders').then(json);
// Carries identity so a GM gets each Scene's `timestamp_id` (which Timestamp it
// cues) and a Player does not — the Scene list itself is an open read, but the
// campaign's timeline is GM-secret. See publicScene in server/index.js.
export const getScenes = (identity) =>
  fetch(`/api/scenes${identity ? `?${new URLSearchParams(identity)}` : ''}`).then(json);
export const getSceneFolders = () => fetch('/api/scene-folders').then(json);
// The live stage everyone shares — { activeScene, summons, drawings }.
// `identity` ({ role: 'gm' } | { role: 'player', characterId }) rides as
// query params — REST has no socket to carry it the way identity:set does
// (see roleContext.jsx/server's viewerFromQuery). Not a 403 gate here
// (nothing about the endpoint itself is secret), but the server still
// redacts a Hidden summon out of the response per-viewer (stagePayloadFor),
// so this REST fetch needs to identify itself exactly like the socket does.
export const getStage = (identity) =>
  fetch(`/api/stage${identity ? `?${new URLSearchParams(identity)}` : ''}`).then(json);

// One character's Relationships board. Carries the identity as query params for
// the same reason getStage does — REST has no socket to carry it — and here it
// is a real gate rather than a filter: the server answers 403 to anyone who is
// neither the board's owner nor the GM.
export const getRelationshipBoard = (characterId, identity) =>
  fetch(
    `/api/characters/${characterId}/relationships${identity ? `?${new URLSearchParams(identity)}` : ''}`
  ).then(json);

// GM Notes — genuinely GM-secret (403 for anyone else), the same identity-
// as-query-params shape getRelationshipBoard uses above.
export const getSceneNotes = (sceneId, identity) =>
  fetch(`/api/scene-notes?${new URLSearchParams({ sceneId, ...identity })}`).then(json);
export const getMasterNote = (identity) =>
  fetch(`/api/master-note${identity ? `?${new URLSearchParams(identity)}` : ''}`).then(json);
export const getSceneTimestamps = (identity) =>
  fetch(`/api/scene-timestamps${identity ? `?${new URLSearchParams(identity)}` : ''}`).then(json);

// The GM's whole music library in one trip — playlists and tracks together,
// because the Audio Player panel always renders both and the library is small
// by construction (a name and an 11-character video id per row, never audio).
export const getAudioLibrary = (identity) =>
  fetch(`/api/audio-library?${new URLSearchParams({ ...identity })}`).then(json);

// Every stored picture's size, for the Re-encode Images tool. Sizes and ids
// only — a listing that carried the pictures would defeat its own purpose.
export const getImageInventory = (identity) =>
  fetch(`/api/image-inventory?${new URLSearchParams({ ...identity })}`).then(json);

// **The old system's archive (the pivot).** The Compendium as it stood when the
// old system was removed, kept in the database as JSON. GM-only (403 for anyone
// else). The listing carries counts, never the document; the download is a
// plain link to `compendiumArchiveUrl`, which the server sends back as a file.
export const getCompendiumArchives = (identity) =>
  fetch(`/api/compendium-archive?${new URLSearchParams({ ...identity })}`).then(json);
export const compendiumArchiveUrl = (id, identity) =>
  `/api/compendium-archive/${id}?${new URLSearchParams({ ...identity })}`;
// A fighter's Combat tab (Panic at the Dojo): { profile, reminders }.
// ownerType is 'character' | 'temp_npc'.
export const getCombatSetup = (ownerType, ownerId) =>
  fetch(`/api/combat-setup?${new URLSearchParams({ ownerType, ownerId })}`).then(json);
// Every fighter's combat profile, keyed `character:<id>` / `temp_npc:<id>`.
export const getCombatProfiles = () => fetch('/api/combat-profiles').then(json);
// Table-wide GM settings: { simpleLanes, laneY }.
export const getTableSettings = () => fetch('/api/table-settings').then(json);
