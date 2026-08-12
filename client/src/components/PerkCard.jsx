import Thumb from './Thumb.jsx';

// Perk display card: picture, name, description — automation is now manual
// per-Perk code (server/perkAutomations.js), not stored/displayed data.
// Used in both the Perks Compendium and the character sheet's read-only
// Perks tab.
export default function PerkCard({ perk, actions }) {
  return (
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-start gap-3">
        <Thumb record={perk} name={perk.name} size="h-12 w-12" cut="panel-cut" />
        <div className="min-w-0 flex-1">
          <div className="font-bold text-zinc-100">{perk.name}</div>
          {perk.description && <p className="mt-0.5 text-sm text-zinc-400">{perk.description}</p>}
        </div>
      </div>
      {actions && (
        <div className="mt-2 flex justify-end gap-1 border-t border-zinc-800 pt-2">{actions}</div>
      )}
    </div>
  );
}
