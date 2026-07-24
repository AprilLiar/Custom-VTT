import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getMoves, getTags } from '../lib/api.js';
import PerkCard from './PerkCard.jsx';

// Tab 4: read-only grid (2 columns, infinite rows) of granted Perks.
export default function PerksTab({ data }) {
  const { perks } = data;
  const [moves, setMoves] = useState(null);
  const [tags, setTags] = useState(null);

  useEffect(() => {
    const refresh = () => {
      getMoves().then((d) => setMoves(d.moves)).catch(console.error);
      getTags().then(setTags).catch(console.error);
    };
    refresh();
    const events = ['move:created', 'move:updated', 'move:deleted', 'tag:created', 'tag:updated', 'tag:deleted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  if (!moves || !tags) return <p className="text-zinc-500">Loading…</p>;
  const moveById = new Map(moves.map((m) => [m.id, m]));
  const tagById = new Map(tags.map((t) => [t.id, t]));

  if (perks.length === 0) {
    return <p className="text-sm text-zinc-600">No Perks granted yet.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {perks.map((perk) => (
        <PerkCard key={perk.character_perk_id} perk={perk} moveById={moveById} tagById={tagById} />
      ))}
    </div>
  );
}
