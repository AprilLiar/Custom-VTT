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
export const getCharacter = (id) => fetch(`/api/characters/${id}`).then(json);
export const createCharacter = (body) =>
  fetch('/api/characters', { ...post, body: JSON.stringify(body) }).then(json);
export const updateCharacter = (id, body) =>
  fetch(`/api/characters/${id}`, { ...put, body: JSON.stringify(body) }).then(json);
export const deleteCharacter = (id) =>
  fetch(`/api/characters/${id}`, { method: 'DELETE' }).then(json);
export const getChat = () => fetch('/api/chat').then(json);
export const getRuleset = () => fetch('/api/ruleset').then(json);
export const getTells = () => fetch('/api/tells').then(json);
export const getMoves = () => fetch('/api/moves').then(json);
