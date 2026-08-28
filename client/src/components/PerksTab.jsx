import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getPerkTags } from '../lib/api.js';
import DropButton from './DropButton.jsx';
import PerkCard from './PerkCard.jsx';

// Tab 4: a grid (2 columns, infinite rows) of granted Perks.
//
// Read-only apart from one control: a Player may **Drop** a Perk from their own
// sheet, the other half of being able to take one in the Compendium. Nothing
// else here is editable — a Perk's picture, name and description are the GM's.
export default function PerksTab({ data }) {
  const { role, characterId } = useRole();
  const { character, perks } = data;
  // A Player can reach somebody else's sheet by typing the URL, so the question
  // is whose sheet this is, not what role is looking at it.
  const isOwnSheet = role === 'player' && characterId === character.id;
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
          actions={
            isOwnSheet ? (
              // "Drop", matching the Compendium's Take/Drop pair for a Perk.
              // Revoking runs the Perk's own onRevoke and clears anything it
              // granted (see perk:revoke), so this is a real removal rather
              // than just losing the row.
              <DropButton
                label="Drop"
                title={`Remove ${perk.name} from your sheet`}
                onClick={() =>
                  socket.emit('perk:revoke', { characterId: character.id, perkId: perk.id })
                }
              />
            ) : null
          }
        />
      ))}
    </div>
  );
}
