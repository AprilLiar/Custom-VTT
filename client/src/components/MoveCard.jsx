import { TRIGGER_LABELS, automationLabel } from '../lib/moveDisplay.js';
import { iconFor } from '../lib/styleIcons.js';
import { dieFormula } from '../lib/dice.js';
import FrameBar from './FrameBar.jsx';
import Thumb from './Thumb.jsx';

// The Move card per spec: a special header showing ONLY the Tell (art +
// name), then move art + name + frame data, style/tags, description, and the
// On Hit/Block/Miss interaction rows with automation chips.
export default function MoveCard({
  move,
  tell,
  style, // attribute row for the move's style, or null
  tags = [], // tag rows for move.tag_ids
  badge,
  dimmed = false,
  dimReason,
  folderLabel,
  perkModified = false, // this character's frame/tags include Perk deltas
  rollBonus = 0, // per-character bonus on rolls with this move, from a Perk
  onRollClick, // present on the character sheet's Moves tab only
  actions,
}) {
  const StyleIcon = style ? iconFor(style.icon) : null;
  const hasRoll = move.roll_slots?.length > 0;
  const isLiveRoll = hasRoll && Array.isArray(move.roll_dice);
  const activeRollDice = isLiveRoll ? move.roll_dice.filter((d) => d.status === 'active') : [];
  return (
    <div
      title={dimmed ? dimReason : undefined}
      className={`overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900 ${
        dimmed ? 'opacity-50 grayscale' : ''
      }`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-800/60 px-3 py-1.5">
        <Thumb record={tell} name={tell?.name} size="h-5 w-5" />
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          {tell?.name ?? '—'}
        </span>
        {folderLabel && (
          <span className="ml-auto rounded bg-zinc-700/50 px-1.5 text-xs text-zinc-400">
            📁 {folderLabel}
          </span>
        )}
      </div>

      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 font-bold text-zinc-100">
            <Thumb record={move} name={move.name} size="h-8 w-8" />
            <span className="min-w-0">
              {move.name}
              {badge}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            {perkModified && (
              <span title="Includes bonuses from a granted Perk" className="text-amber-400">
                ⭐
              </span>
            )}
            <FrameBar
              startup={move.startup_tics}
              active={move.active_tics}
              recovery={move.recovery_tics}
            />
          </span>
        </div>

        {rollBonus !== 0 && (
          <div
            className="text-xs text-amber-400"
            title={
              hasRoll
                ? 'Included in this move’s Roll bonus below'
                : 'Stored now — applies once this move has a Roll to attach it to'
            }
          >
            {rollBonus > 0 ? '+' : ''}
            {rollBonus} on rolls with this move (Perk{hasRoll ? '' : ', not yet active'})
          </div>
        )}

        {hasRoll && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold uppercase text-zinc-500">Roll:</span>
            {isLiveRoll ? (
              <button
                type="button"
                onClick={onRollClick}
                disabled={!onRollClick || activeRollDice.length === 0}
                title={
                  activeRollDice.length === 0
                    ? 'Every die in this Roll is incapacitated'
                    : 'Roll this move’s dice'
                }
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-zinc-200 hover:border-indigo-500 hover:text-indigo-300 disabled:opacity-40"
              >
                {move.roll_dice
                  .map(
                    (d) =>
                      `${d.slot_name} (${
                        d.status === 'incapacitated'
                          ? '—'
                          : dieFormula(d.current_size, d.bonus, move.effective_roll_modifier ?? 0)
                      })`
                  )
                  .join(' + ')}
              </button>
            ) : (
              <span className="text-zinc-400">
                {move.roll_slots.join(' + ')}
                {move.roll_modifier ? ` (${move.roll_modifier > 0 ? '+' : ''}${move.roll_modifier})` : ''}
              </span>
            )}
          </div>
        )}

        {(style || tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1">
            {style && (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-zinc-300">
                <StyleIcon size={11} />
                {style.name}
              </span>
            )}
            {tags.map((tag) => (
              <span
                key={tag.id}
                title={tag.description || undefined}
                className="rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs font-semibold text-emerald-300"
              >
                {tag.name}
              </span>
            ))}
          </div>
        )}

        {move.description && <p className="text-sm text-zinc-400">{move.description}</p>}

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

        {actions && (
          <div className="flex justify-end gap-1 border-t border-zinc-800 pt-2">{actions}</div>
        )}
      </div>
    </div>
  );
}
