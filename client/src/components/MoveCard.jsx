import { Zap } from 'lucide-react';
import { TRIGGER_LABELS, automationLabel } from '../lib/moveDisplay.js';
import { iconFor } from '../lib/styleIcons.js';
import { dieFormula } from '../lib/dice.js';
import { ROLL_SLOT_LABELS } from '../lib/diceSlots.js';
import FrameBar from './FrameBar.jsx';
import Thumb from './Thumb.jsx';

// The Move card per spec: a special header showing ONLY the Tell (art +
// name) — or, for a move with an ambiguous Left/Right Roll slot, BOTH
// possible Tells side by side, always, since nothing's chosen until the
// move is actually rolled — then move art + name + frame data, style/tags,
// discipline, description, and the On Hit/Block/Miss interaction rows.
export default function MoveCard({
  move,
  tell,
  rightTell, // set only when the move's Roll has a Left/Right appendage slot
  leftTell,
  style, // attribute row for the move's style, or null
  tags = [], // tag rows for move.tag_ids
  badge,
  dimmed = false,
  dimReason,
  folderLabel = 'Without Discipline', // the martial-arts discipline (compendium folder) this move belongs to
  perkModified = false, // this character's frame/tags include Perk deltas
  rollBonus = 0, // per-character bonus on rolls with this move, from a Perk
  onRollClick, // present on the character sheet's Moves tab only; (side) => void
  actions,
}) {
  const StyleIcon = style ? iconFor(style.icon) : null;
  // Custom Roll type (item 2, decided): a flat base die, not tied to any
  // character stat/die — always "live" (no incapacitation concept for it),
  // so it renders its own single button rather than going through the
  // roll_dice/roll_choice resolution the Stat type needs.
  const isCustomRoll = move.roll_type === 'custom' && move.custom_roll_size != null;
  const hasRoll = move.roll_slots?.length > 0 || isCustomRoll;
  const isLiveRoll = hasRoll && !isCustomRoll && Array.isArray(move.roll_dice);
  const ambiguousRoll = Boolean(move.roll_choice);
  // Never render an interaction category with nothing in it — covers both
  // the normal (server-side normalizeInteractions already drops empty rows)
  // and legacy-data cases (a pre-validation empty row that slipped in).
  const visibleInteractions = (move.interactions ?? []).filter(
    (row) => row.text || row.automations?.length > 0
  );
  const sideActive = (dice) => dice.some((d) => d.status === 'active');
  const formulaFor = (dice) =>
    dice
      .map(
        (d) =>
          `${d.slot_name} (${
            d.status === 'incapacitated' ? '—' : dieFormula(d.current_size, d.bonus, move.effective_roll_modifier ?? 0)
          })`
      )
      .join(' + ');
  return (
    <div
      title={dimmed ? dimReason : undefined}
      className={`overflow-hidden panel-cut-lg border border-zinc-800 bg-zinc-900 ${
        dimmed ? 'opacity-50 grayscale' : ''
      }`}
    >
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-800/60 px-3 py-1.5">
        {rightTell || leftTell ? (
          <>
            <span className="flex items-center gap-1">
              <Thumb record={rightTell} name={rightTell?.name} size="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {rightTell?.name ?? '—'}
              </span>
            </span>
            <span className="text-zinc-600">/</span>
            <span className="flex items-center gap-1">
              <Thumb record={leftTell} name={leftTell?.name} size="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                {leftTell?.name ?? '—'}
              </span>
            </span>
          </>
        ) : (
          <>
            <Thumb record={tell} name={tell?.name} size="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
              {tell?.name ?? '—'}
            </span>
          </>
        )}
        <span className="ml-auto panel-cut-sm bg-zinc-700/50 px-1.5 text-xs text-zinc-400">
          📁 {folderLabel}
        </span>
      </div>

      <div className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 items-center gap-2 font-bold text-zinc-100">
            <Thumb record={move} name={move.name} size="h-8 w-8" />
            <span className="min-w-0">
              {move.name}
              {badge}
              {Boolean(move.is_defensive) && (
                <span className="ml-1.5 panel-cut-sm bg-sky-900/50 px-1.5 text-xs font-semibold uppercase text-sky-300">
                  Defensive
                </span>
              )}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            {perkModified && (
              <span title="Includes bonuses from a granted Perk" className="text-amber-400">
                ⭐
              </span>
            )}
            <span
              title="Stamina Cost — subtracted once the declaring side finishes declaring"
              className={`flex items-center gap-0.5 panel-cut-sm bg-zinc-800 px-1.5 py-0.5 text-xs font-semibold ${
                move.stamina_cost > 0
                  ? 'text-red-400'
                  : move.stamina_cost < 0
                    ? 'text-emerald-400'
                    : 'text-zinc-500'
              }`}
            >
              <Zap size={12} />
              {move.stamina_cost > 0 ? `-${move.stamina_cost}` : move.stamina_cost < 0 ? `+${-move.stamina_cost}` : 0}
            </span>
            <FrameBar
              startup={move.startup_tics}
              active={move.active_tics}
              recovery={move.recovery_tics}
              defensePositions={move.defense_frame_positions}
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
            {isCustomRoll ? (
              <button
                type="button"
                onClick={() => onRollClick?.(null)}
                disabled={!onRollClick}
                title="Roll this move's base die"
                className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-zinc-200 hover:border-brand-500 hover:text-brand-300 disabled:opacity-40"
              >
                {dieFormula(move.custom_roll_size, 0, move.effective_roll_modifier ?? 0)}
              </button>
            ) : isLiveRoll ? (
              ambiguousRoll ? (
                ['right', 'left'].map((side) => {
                  const sideDice = [...move.roll_dice, ...move.roll_choice[side]];
                  const active = sideActive(sideDice);
                  return (
                    <button
                      key={side}
                      type="button"
                      onClick={() => onRollClick?.(side)}
                      disabled={!onRollClick || !active}
                      title={active ? `Roll as the ${side === 'right' ? 'Right' : 'Left'} appendage` : 'Every die on this side is incapacitated'}
                      className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-zinc-200 hover:border-brand-500 hover:text-brand-300 disabled:opacity-40"
                    >
                      {side === 'right' ? 'Right' : 'Left'}: {formulaFor(sideDice)}
                    </button>
                  );
                })
              ) : (
                <button
                  type="button"
                  onClick={() => onRollClick?.(null)}
                  disabled={!onRollClick || !sideActive(move.roll_dice)}
                  title={
                    sideActive(move.roll_dice)
                      ? 'Roll this move’s dice'
                      : 'Every die in this Roll is incapacitated'
                  }
                  className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 font-mono text-zinc-200 hover:border-brand-500 hover:text-brand-300 disabled:opacity-40"
                >
                  {formulaFor(move.roll_dice)}
                </button>
              )
            ) : (
              <span className="text-zinc-400">
                {move.roll_slots.map((s) => ROLL_SLOT_LABELS[s] ?? s).join(' + ')}
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

        {visibleInteractions.length > 0 && (
          <div className="space-y-1 border-t border-zinc-800 pt-2">
            {visibleInteractions.map((row) => (
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
                        className="panel-cut-sm bg-brand-900/50 px-1.5 py-0.5 text-xs font-semibold text-brand-300"
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
