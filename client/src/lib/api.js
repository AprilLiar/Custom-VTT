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
export const getRuleset = () => fetch('/api/ruleset').then(json);
// The rule book itself (game_rules.md at the repo root), rendered by the
// Rules page. Distinct from getRuleset above, which is the GM-editable
// per-table config — this one is authored text, the same for everyone.
export const getRules = () => fetch('/api/rules').then(json);
export const getTells = () => fetch('/api/tells').then(json);
export const getTags = () => fetch('/api/tags').then(json);
export const getMoves = () => fetch('/api/moves').then(json);
export const getPerks = () => fetch('/api/perks').then(json);
// Perk Tags are their own vocabulary, not the Move tag list above — see
// perk_tags in server/db.js for why.
export const getPerkTags = () => fetch('/api/perk-tags').then(json);
export const search = (q) => fetch(`/api/search?q=${encodeURIComponent(q)}`).then(json);
// `identity` ({ role: 'gm' } | { role: 'player', characterId }) rides as
// query params — REST has no socket to carry it the way identity:set does
// (see roleContext.jsx/server's viewerFromQuery) — so a viewer-tailored
// declaredMoves list comes back even on this initial/refresh fetch.
export const getCombat = (identity) =>
  fetch(`/api/combat${identity ? `?${new URLSearchParams(identity)}` : ''}`).then(json);

// Combat Automation overhaul §3 — a completed round's stored event log,
// behind the chat log's "Watch Round N" button. Takes no identity: a
// resolved round is public history, watchable by anyone (decision #11).
export const getRoundReplay = (resolutionId) =>
  fetch(`/api/combat/round-replay/${resolutionId}`).then(json);
