import { Target, Zap } from 'lucide-react';
import {
  TRIGGER_LABELS,
  automationLabel,
  carriesBlockTag,
  carriesNoDamageTag,
  staminaModifierLabel,
} from '../lib/moveDisplay.js';
import { iconFor } from '../lib/styleIcons.js';
import { dieFormula } from '../lib/dice.js';
import { ROLL_SLOT_LABELS, describeRollSlots } from '../lib/diceSlots.js';
import FrameBar from './FrameBar.jsx';
import Thumb from './Thumb.jsx';

const DIRECTION_GLYPHS = { up: '↑', down: '↓', left: '←', right: '→' };

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
  style, // attribute row for the move's style gate, or null
  combatStyle, // attribute row for the move's Combat Style, or null
  tags = [], // tag rows for move.tag_ids
  badge,
  dimmed = false,
  dimReason,
  folderLabel = 'Without Discipline', // the martial-arts discipline (compendium folder) this move belongs to
  // The whole move library, so a Grappling move's four directions can be
  // rendered by name. Every caller that shows a grappling move must pass it;
  // an empty list simply degrades the arrows to "unknown move".
  allMoves = [],
  perkModified = false, // this character's frame/tags include Perk deltas
  rollBonus = 0, // per-character bonus on rolls with this move, from a Perk
  onRollClick, // present on the character sheet's Moves tab only; (side) => void
  actions,
}) {
  const StyleIcon = style ? iconFor(style.icon) : null;
  const CombatStyleIcon = combatStyle ? iconFor(combatStyle.icon) : null;
  // Block Tag (the first Tag automation — see moveDisplay.js). `tags` is
  // already the resolved rows for this move's tag_ids, including whatever a
  // Perk added or removed for this character, so a Perk that grants the Block
  // Tag correctly makes the card read as a Block.
  const isBlock = carriesBlockTag(tags.map((t) => t.id), tags);
  const isNoDamage = carriesNoDamageTag(tags.map((t) => t.id), tags);
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
              {Boolean(move.is_grappling) && (
                <span className="ml-1.5 panel-cut-sm bg-amber-900/50 px-1.5 text-xs font-semibold uppercase text-amber-300">
                  Grappling
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
            {/* Block Tag (the first Tag automation): a Block has no up-front
                Stamina Cost to show at all — what it will cost isn't knowable
                until it actually absorbs something — so the badge shows its
                Stamina Modifier instead. Same slot, same shape, different
                question answered. */}
            {isBlock ? (
              <span
                title="Stamina Modifier — a Block spends Stamina at resolution for as much of the attack as it absorbed, times this"
                className="flex items-center gap-0.5 panel-cut-sm bg-zinc-800 px-1.5 py-0.5 text-xs font-semibold text-sky-300"
              >
                <Zap size={12} />
                {staminaModifierLabel(move.stamina_modifier)}
              </span>
            ) : (
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
            )}
            {/* No Damage Tag (the second Tag automation): the move deals none,
                so the number that decides its outcome is the Threshold. Shown
                beside the cost rather than replacing it — a No Damage move
                still costs Stamina to throw. */}
            {isNoDamage && (
              <span
                title="Success Threshold — a No Damage move succeeds at this roll or better, and fails below it"
                className="flex items-center gap-0.5 panel-cut-sm bg-zinc-800 px-1.5 py-0.5 text-xs font-semibold text-amber-300"
              >
                <Target size={12} />
                {move.success_threshold ?? 5}+
              </span>
            )}
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
                {describeRollSlots(move.roll_slots).join(' + ')}
                {move.roll_modifier ? ` (${move.roll_modifier > 0 ? '+' : ''}${move.roll_modifier})` : ''}
              </span>
            )}
          </div>
        )}

        {hasRoll && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold uppercase text-zinc-500">Attack Target:</span>
            <span className={move.attack_targets?.length ? 'text-zinc-400' : 'text-zinc-600'}>
              {move.attack_targets?.length
                ? move.attack_targets.map((s) => ROLL_SLOT_LABELS[s] ?? s).join(' + ')
                : 'None'}
            </span>
          </div>
        )}

        {/* Grappling's own two rows. The Resist Roll is what the TARGET
            throws to fight the grab off, so it is labelled as theirs rather
            than sitting unlabelled beside the move's own Roll. */}
        {Boolean(move.is_grappling) && move.resist_roll_slots?.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold uppercase text-zinc-500">Resist Roll:</span>
            <span className="text-zinc-400">
              {describeRollSlots(move.resist_roll_slots).join(' + ')}
            </span>
          </div>
        )}
        {Boolean(move.is_grappling) && move.grapple_directions?.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold uppercase text-zinc-500">Directions:</span>
            {move.grapple_directions.map((d) => {
              const target = allMoves.find((m) => m.id === d.target_move_id);
              return (
                <span key={d.direction} className="text-amber-300">
                  {DIRECTION_GLYPHS[d.direction] ?? d.direction} {target?.name ?? 'unknown move'}
                </span>
              );
            })}
          </div>
        )}

        {/* Requirement — resolved against the same library the grapple
            directions above resolve against. Shown on every move that has
            one, grappling or not: "you cannot throw this cold" is the single
            most important thing to know about such a move. */}
        {move.requirement_move_id != null && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="font-semibold uppercase text-zinc-500">Only after:</span>
            <span className="text-amber-300">
              {/* Server-resolved (attachInteractions), because a Requirement
                  can point at a move outside whatever list this card was
                  handed — a character's own move may require one they were
                  never granted. allMoves is only a fallback. */}
              {move.requirement_move_name ??
                allMoves.find((m) => m.id === move.requirement_move_id)?.name ??
                'unknown move'}
            </span>
          </div>
        )}

        {(style || combatStyle || tags.length > 0) && (
          <div className="flex flex-wrap items-center gap-1">
            {style && (
              <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2 py-0.5 text-xs font-semibold text-zinc-300">
                <StyleIcon size={11} />
                {style.name}
              </span>
            )}
            {/* Combat Style reads as a modifier, not a category, so it is
                deliberately not the same chip as the Style gate beside it —
                one says who may throw this move, the other changes what it
                is worth in the matchup. */}
            {combatStyle && (
              <span
                title="Combat Style — added to the user's stance when this move's roll is scored against the opponent"
                className="inline-flex items-center gap-1 rounded-full bg-amber-900/40 px-2 py-0.5 text-xs font-semibold text-amber-300"
              >
                <CombatStyleIcon size={11} />
                {combatStyle.name}
                <span className="text-amber-500/80">matchup</span>
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
