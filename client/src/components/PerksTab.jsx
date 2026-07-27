import PerkCard from './PerkCard.jsx';

// Tab 4: read-only grid (2 columns, infinite rows) of granted Perks.
export default function PerksTab({ data }) {
  const { perks } = data;

  if (perks.length === 0) {
    return <p className="text-sm text-zinc-600">No Perks granted yet.</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      {perks.map((perk) => (
        <PerkCard key={perk.character_perk_id} perk={perk} />
      ))}
    </div>
  );
}
