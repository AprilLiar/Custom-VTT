import Thumb from './Thumb.jsx';

// Perk display card: picture, name, description, and its Tags — automation is
// now manual per-Perk code (server/perkAutomations.js), not stored/displayed
// data. Used in both the Perks Compendium and the character sheet's read-only
// Perks tab.
//
// `tags` is the resolved Perk Tag rows for perk.tag_ids. They are purely
// categorisation and carry no mechanics, so they render as quiet chips below
// the description rather than anywhere that would read as a rule. Their own
// colour (sky) keeps them from being mistaken at a glance for a Move tag,
// which lives in a different vocabulary and can carry real automation.
export default function PerkCard({ perk, tags = [], actions }) {
  return (
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-start gap-3">
        <Thumb record={perk} name={perk.name} size="h-12 w-12" cut="panel-cut" />
        <div className="min-w-0 flex-1">
          <div className="font-bold text-zinc-100">{perk.name}</div>
          {perk.description && <p className="mt-0.5 text-sm text-zinc-400">{perk.description}</p>}
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {tags.map((tag) => (
                <span
                  key={tag.id}
                  title={tag.description || undefined}
                  className="rounded-full bg-sky-900/40 px-2 py-0.5 text-xs font-semibold text-sky-300"
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {actions && (
        <div className="mt-2 flex justify-end gap-1 border-t border-zinc-800 pt-2">{actions}</div>
      )}
    </div>
  );
}
