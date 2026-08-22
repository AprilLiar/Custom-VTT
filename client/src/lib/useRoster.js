import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getCharacters } from './api.js';

// The world's character roster, kept live — and kept **cheap**.
//
// Four separate components used to hold their own copy of this and all four
// wrote the same subtly wrong rule: refetch `/api/characters` on
// `character:created`, `character:updated` *and* `character:deleted`. The
// middle one is the problem. `character:updated` is not a rare administrative
// event — `adjustStamina` emits it every time a fighter's Stamina moves, which
// during a round is constantly, and ChatPanel is mounted on every page. So a
// single Stamina tick had every connected browser re-fetching the whole roster,
// and in the Compendium's case a great deal more besides.
//
// The payload already carries the whole updated character, so an update needs
// no request at all — it is merged into the row we are already holding.
// Merging rather than replacing matters: `/api/characters` attaches `stances`
// to each row and a `character:updated` payload does not carry them, so
// spreading the old row first is what keeps them.
//
// Stance events *are* refetched, because stances now ride on this payload and
// nothing else carries them — but a GM editing a stance is a rare, deliberate
// act, not something that happens several times a round.
//
// **Returns `null` until the first fetch lands**, so a caller can tell "not
// loaded yet" from "loaded, and the world has no characters" — several of them
// render a different thing for each.
export function useRoster() {
  const [characters, setCharacters] = useState(null);

  useEffect(() => {
    let alive = true;
    const refetch = () =>
      getCharacters()
        .then((list) => {
          if (alive) setCharacters(list);
        })
        .catch(console.error);

    refetch();

    const onUpdated = (character) =>
      setCharacters((prev) =>
        prev ? prev.map((c) => (c.id === character.id ? { ...c, ...character } : c)) : prev
      );
    const onDeleted = ({ id }) =>
      setCharacters((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));

    const refetchOn = ['character:created', 'stance:created', 'stance:updated', 'stance:deleted'];
    for (const ev of refetchOn) socket.on(ev, refetch);
    socket.on('character:updated', onUpdated);
    socket.on('character:deleted', onDeleted);
    return () => {
      alive = false;
      for (const ev of refetchOn) socket.off(ev, refetch);
      socket.off('character:updated', onUpdated);
      socket.off('character:deleted', onDeleted);
    };
  }, []);

  return characters;
}
