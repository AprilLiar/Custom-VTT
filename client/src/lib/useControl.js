import { useCallback, useMemo } from 'react';
import { useRole } from '../roleContext.jsx';
import { useRoster } from './useRoster.js';

// **Who this viewer controls (decided, new).** The GM controls everything. A
// Player controls their own PC plus every NPC the GM assigned to them
// (`characters.assigned_to` = their PC id). The server applies the same rule
// (server/control.js); this is the client's copy, for showing the controls.
//
// Returns { controlled, controls(characterId), assignedNpcs }:
//   controlled   — the Player's characters, own PC first ([] for the GM)
//   assignedNpcs — just the NPCs assigned to the Player
// Pass `roster` when the caller already holds one, to skip a second fetch.
export function useControl(roster) {
  const { role, characterId } = useRole();
  const fetched = useRoster();
  const characters = roster ?? fetched;
  const { controlled, ids } = useMemo(() => {
    if (role !== 'player' || characterId == null) return { controlled: [], ids: new Set() };
    const own = (characters ?? []).find((c) => c.id === characterId);
    const npcs = (characters ?? []).filter((c) => c.id !== characterId && c.assigned_to === characterId);
    const list = own ? [own, ...npcs] : npcs;
    return { controlled: list, ids: new Set([characterId, ...npcs.map((c) => c.id)]) };
  }, [role, characterId, characters]);
  const controls = useCallback(
    (id) => role === 'gm' || (role === 'player' && id != null && ids.has(Number(id))),
    [role, ids]
  );
  const assignedNpcs = useMemo(() => controlled.filter((c) => c.id !== characterId), [controlled, characterId]);
  return { controlled, controls, assignedNpcs };
}
