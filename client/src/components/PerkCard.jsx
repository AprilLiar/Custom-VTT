import Thumb from './Thumb.jsx';

// Perk display card: picture, name, description, and its Tags. Used in both the
// Perks Compendium and the character sheet's read-only Perks tab.
//
// **The ⚙ badge is the one piece of mechanical information here**, and it earns
// its place: a Perk's rules are code bound to its exact name
// (server/perks/index.js), which is completely invisible from the outside.
// Without the badge there is no way to tell a Perk that does something from one
// that is pure description — they render identically. `automated` rides every
// Perk payload the server sends for exactly this.
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
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-zinc-100">{perk.name}</span>
            {perk.automated && (
              <span
                title="This Perk has automated rules — the engine applies it on its own."
                className="shrink-0 rounded-full bg-emerald-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300"
              >
                ⚙ Auto
              </span>
            )}
          </div>
          {perk.description && (
            // Same as a Move's description: authored in a textarea, so the
            // line breaks the GM typed have to render.
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-zinc-400">{perk.description}</p>
          )}
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
