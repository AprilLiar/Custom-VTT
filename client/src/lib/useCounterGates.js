import { useCallback, useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { useRole } from '../roleContext.jsx';

// Every Gate on every Counter, as this viewer is allowed to know it.
//
// **Its own fetch and its own channel**, deliberately. A Counter is public —
// `counter:updated` is an `io.emit` and everybody's Arena shows everybody's
// clocks — but a Gate can carry something only the GM may read, and the payload
// a Player receives simply does not contain it. Folding Gates into the Counter
// rows would have meant making five broadcasts and two REST payloads
// viewer-aware; a second channel that already knows who is asking is smaller and
// harder to get wrong.
//
// Keyed by counter id, because that is how every renderer asks.
export function useCounterGates() {
  const { role, characterId } = useRole();
  const [byCounter, setByCounter] = useState(() => new Map());

  const take = useCallback((gates) => {
    const next = new Map();
    for (const gate of gates ?? []) {
      const list = next.get(gate.counter_id) ?? [];
      list.push(gate);
      next.set(gate.counter_id, list);
    }
    setByCounter(next);
  }, []);

  useEffect(() => {
    let alive = true;
    // The identity goes in the query for the same reason the board's does: the
    // server decides what to send, and it can only decide if it knows who is
    // asking. An unidentified caller gets the closed answer.
    const params = new URLSearchParams(
      role === 'gm' ? { role: 'gm' } : role === 'player' && characterId != null
        ? { role: 'player', characterId: String(characterId) }
        : {}
    );
    fetch(`/api/counter-gates?${params}`)
      .then((r) => r.json())
      .then((data) => alive && take(data?.gates))
      // A failed fetch renders as "no Gates" rather than as a spinner that never
      // stops: the pips are the point of the strip, and a Gate is an annotation.
      .catch(() => alive && take([]));

    const onUpdated = (payload) => alive && take(payload?.gates);
    socket.on('counter_gates:updated', onUpdated);
    return () => {
      alive = false;
      socket.off('counter_gates:updated', onUpdated);
    };
  }, [role, characterId, take]);

  return byCounter;
}

// The Gates on one Counter, indexed by the pip they sit on. Pips are 1-based on
// the server, so this hands back a lookup the renderer can ask with the same
// number it is drawing.
export function gatesByPip(gates) {
  const map = new Map();
  for (const gate of gates ?? []) map.set(Number(gate.pip_index), gate);
  return map;
}
