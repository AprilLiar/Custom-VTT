import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getTells } from '../lib/api.js';
import MoveCard from './MoveCard.jsx';

// Tab 3: read-only list of the character's available moves — all Default
// moves plus Unique moves granted by the GM (who can revoke from here).
export default function MovesTab({ data }) {
  const { role } = useRole();
  const { character, moves } = data;
  const [tells, setTells] = useState(null);

  useEffect(() => {
    getTells().then(setTells).catch(console.error);
    const refresh = () => getTells().then(setTells).catch(console.error);
    socket.on('tell:created', refresh);
    socket.on('tell:updated', refresh);
    socket.on('tell:deleted', refresh);
    return () => {
      socket.off('tell:created', refresh);
      socket.off('tell:updated', refresh);
      socket.off('tell:deleted', refresh);
    };
  }, []);

  if (!tells) return <p className="text-zinc-500">Loading…</p>;
  const tellById = new Map(tells.map((t) => [t.id, t]));

  if (moves.length === 0) {
    return (
      <p className="text-sm text-zinc-600">
        No moves yet — Default moves appear here automatically once the GM creates them in
        the Compendium.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {moves.map((move) => (
        <MoveCard
          key={move.id}
          move={move}
          tell={tellById.get(move.tell_id)}
          badge={
            move.is_default ? (
              <span className="ml-2 rounded bg-zinc-700/60 px-1.5 text-xs font-semibold uppercase text-zinc-400">
                Default
              </span>
            ) : (
              <span className="ml-2 rounded bg-purple-600/30 px-1.5 text-xs font-semibold uppercase text-purple-300">
                Unique
              </span>
            )
          }
          actions={
            role === 'gm' && !move.is_default ? (
              <button
                onClick={() =>
                  window.confirm(`Revoke ${move.name} from ${character.name}?`) &&
                  socket.emit('move:revoke', { characterId: character.id, moveId: move.id })
                }
                className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-400"
              >
                Revoke
              </button>
            ) : null
          }
        />
      ))}
    </div>
  );
}
