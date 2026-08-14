import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import { getPerkTags } from '../lib/api.js';
import PerkCard from './PerkCard.jsx';

// Tab 4: read-only grid (2 columns, infinite rows) of granted Perks.
export default function PerksTab({ data }) {
  const { perks } = data;
  // The Perk Tag vocabulary isn't part of the character payload — it's a
  // world-level list, fetched once here and kept live, same shape as the
  // Compendium's own subscription.
  const [tags, setTags] = useState([]);

  useEffect(() => {
    const refresh = () => getPerkTags().then(setTags).catch(console.error);
    refresh();
    const events = ['perk_tag:created', 'perk_tag:updated', 'perk_tag:deleted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  if (perks.length === 0) {
    return <p className="text-sm text-zinc-600">No Perks granted yet.</p>;
  }

  const tagById = new Map(tags.map((t) => [t.id, t]));

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {perks.map((perk) => (
        <PerkCard
          key={perk.character_perk_id}
          perk={perk}
          tags={(perk.tag_ids ?? []).map((id) => tagById.get(id)).filter(Boolean)}
        />
      ))}
    </div>
  );
}
