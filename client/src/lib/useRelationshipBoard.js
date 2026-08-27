import { useCallback, useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getRelationshipBoard } from './api.js';

// One board, kept live.
//
// Fetched on its own rather than riding `GET /api/characters/:id` for the
// reason recorded on the server helper: that payload is refetched by roughly
// twenty unrelated socket events — every Stamina tick among them — and a board
// carries base64 pictures for its board-local people.
//
// Every write is fire-and-forget over the socket, and the server broadcasts the
// whole board back to whoever is entitled to it. That is the `roleplay:updated`
// shape, with one difference that matters: the server emits per-socket rather
// than `io.emit`, because a private board must never cross the wire to another
// player. So a rejected write (not yours) is simply silence, and the board on
// screen stays whatever the server last said it was.
//
// Returns `null` until the first fetch lands, so a caller can tell "not loaded
// yet" from "loaded, and this board is empty" — they render differently.
export function useRelationshipBoard(characterId, identity) {
  const [board, setBoard] = useState(null);

  const refetch = useCallback(() => {
    if (characterId == null || !identity) return;
    getRelationshipBoard(characterId, identity)
      .then(setBoard)
      .catch(() => setBoard({ people: [], nodes: [] }));
  }, [characterId, identity]);

  useEffect(() => {
    let alive = true;
    if (characterId == null || !identity) return undefined;
    getRelationshipBoard(characterId, identity)
      .then((data) => alive && setBoard(data))
      // A 403 is a real answer — you are looking at somebody else's board —
      // and renders as empty rather than as a spinner that never stops.
      .catch(() => alive && setBoard({ people: [], nodes: [] }));

    const onUpdated = (payload) => {
      if (!alive || Number(payload?.characterId) !== Number(characterId)) return;
      setBoard({ people: payload.people ?? [], nodes: payload.nodes ?? [] });
    };
    socket.on('relationships:updated', onUpdated);
    return () => {
      alive = false;
      socket.off('relationships:updated', onUpdated);
    };
  }, [characterId, identity]);

  return { board, refetch };
}
