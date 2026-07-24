import { tellIconFor } from '../lib/tellIcons.js';
import { TRIGGER_LABELS, automationLabel } from '../lib/moveDisplay.js';
import FrameBar from './FrameBar.jsx';

// The Move card per spec: a special header showing ONLY the Tell (icon +
// name), then name + frame data, description, and the On Hit/Block/Miss
// interaction rows with automation chips.
export default function MoveCard({ move, tell, badge, actions }) {
  const TellIcon = tellIconFor(tell?.icon);
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-800/60 px-3 py-1.5">
        <TellIcon size={14} className="text-zinc-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          {tell?.name ?? '—'}
        </span>
      </div>

      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <span className="font-bold text-zinc-100">
            {move.name}
            {badge}
          </span>
          <FrameBar
            startup={move.startup_tics}
            active={move.active_tics}
            recovery={move.recovery_tics}
          />
        </div>

        {move.description && (
          <p className="text-sm text-zinc-400">{move.description}</p>
        )}

        {move.interactions?.length > 0 && (
          <div className="space-y-1 border-t border-zinc-800 pt-2">
            {move.interactions.map((row) => (
              <div key={row.trigger} className="text-sm">
                <span className="font-semibold text-zinc-300">
                  {TRIGGER_LABELS[row.trigger]}:
                </span>{' '}
                {row.text && <span className="text-zinc-400">{row.text}</span>}
                {row.automations.length > 0 && (
                  <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
                    {row.automations.map((a, i) => (
                      <span
                        key={i}
                        className="rounded bg-indigo-900/50 px-1.5 py-0.5 text-xs font-semibold text-indigo-300"
                      >
                        {automationLabel(a)}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {actions && <div className="flex justify-end gap-1 border-t border-zinc-800 pt-2">{actions}</div>}
      </div>
    </div>
  );
}
