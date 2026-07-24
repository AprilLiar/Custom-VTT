import { AUTOMATION_TYPE_LABELS, automationSummary } from '../lib/perkDisplay.js';
import Thumb from './Thumb.jsx';

// Perk display card: picture, name, description, automation chips, per the
// spec (just those four things). Used in both the Perks Compendium and the
// character sheet's read-only Perks tab.
export default function PerkCard({ perk, moveById, tagById, actions }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-start gap-3">
        <Thumb record={perk} name={perk.name} size="h-12 w-12" rounded="rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="font-bold text-zinc-100">{perk.name}</div>
          {perk.description && <p className="mt-0.5 text-sm text-zinc-400">{perk.description}</p>}
        </div>
      </div>
      {perk.automations?.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-zinc-800 pt-2">
          {perk.automations.map((a, i) => (
            <li key={a.id ?? i} className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="rounded bg-indigo-900/50 px-1.5 py-0.5 font-semibold text-indigo-300">
                {AUTOMATION_TYPE_LABELS[a.type] ?? a.type}
              </span>
              <span className="text-zinc-400">
                {automationSummary(a.type, a.payload, { moveById, tagById })}
              </span>
              {a.type === 'move_roll_bonus' && (
                <span
                  className="text-amber-500"
                  title="Stored now — applies once Moves get their own rolls in Combat Timing (Phase 7)"
                >
                  (not yet active)
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {actions && (
        <div className="mt-2 flex justify-end gap-1 border-t border-zinc-800 pt-2">{actions}</div>
      )}
    </div>
  );
}
