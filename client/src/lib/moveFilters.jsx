import { useMemo, useState } from 'react';

// **The Tell/Tag move filter, in one place (decided, new).**
//
// This control already existed twice — the Compendium's Style+Tag row and the
// sheet's Tell+Tag row — and the Arena's declare picker makes three. A third
// ad-hoc copy is worse than consolidating, which is the same call this codebase
// already made for the frame palette (see framePhaseColors.js): three
// implementations of one question is how two of them quietly stop agreeing
// about what "OR'd within, AND'd between" means.
//
// The rules, unchanged from the sheet's own version:
//   - picks *within* one filter are OR'd — "a Jab or a Hook"
//   - the two filters are AND'd with each other — "...and Fast"
//   - an empty filter is not applied at all
//
// Both sides of an ambiguous move's Left/Right Tell pair count, because a move
// that can open with either is findable by either.
export const moveTellIds = (move) =>
  [move.tell_id, move.left_tell_id, move.right_tell_id].filter((id) => id != null);

// `effective_tag_ids` first: a Perk may add or strip a Tag for one character,
// and the filter has to match what that fighter's card actually shows.
export const moveTagIds = (move) => move.effective_tag_ids ?? move.tag_ids ?? [];

// `moves` is the pile being filtered — not the world. Offering a filter that
// can only ever return nothing is a worse answer than not offering it, so the
// chips are built from what is actually in front of you: on a sheet that is the
// character's list, and in the Arena's picker it is the current tab's.
export function useMoveFilters(moves) {
  const [tellFilter, setTellFilter] = useState(new Set());
  const [tagFilter, setTagFilter] = useState(new Set());

  const toggleIn = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const list = moves ?? [];
  const presentTellIds = useMemo(() => {
    const ids = new Set();
    for (const m of list) for (const id of moveTellIds(m)) ids.add(id);
    return ids;
  }, [list]);
  const presentTagIds = useMemo(() => {
    const ids = new Set();
    for (const m of list) for (const id of moveTagIds(m)) ids.add(id);
    return ids;
  }, [list]);

  const matches = (move) => {
    if (tellFilter.size > 0 && !moveTellIds(move).some((id) => tellFilter.has(id))) return false;
    if (tagFilter.size > 0 && !moveTagIds(move).some((id) => tagFilter.has(id))) return false;
    return true;
  };

  return {
    tellFilter,
    tagFilter,
    toggleTell: toggleIn(setTellFilter),
    toggleTag: toggleIn(setTagFilter),
    clearTell: () => setTellFilter(new Set()),
    clearTag: () => setTagFilter(new Set()),
    presentTellIds,
    presentTagIds,
    anyActive: tellFilter.size > 0 || tagFilter.size > 0,
    matches,
  };
}

// One row of filter chips. Renders nothing at all when there is nothing to
// filter by — a lone "Filter by tag:" label above an empty row is a control
// that only advertises its own uselessness.
export function MoveFilterChips({
  label,
  items,
  selected,
  onToggle,
  onClear,
  labelFor,
  titleFor,
  className = '',
  compact = false,
}) {
  if (!items?.length) return null;
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`}>
      <span className={`mr-1 font-semibold uppercase text-zinc-500 ${compact ? 'text-[10px]' : 'text-xs'}`}>
        {label}
      </span>
      {items.map((item) => {
        const active = selected.has(item.id);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onToggle(item.id)}
            title={titleFor?.(item) || `Filter by ${labelFor(item)}`}
            className={`panel-cut-sm border ${
              // The Arena's picker is a dense panel beside a Tic strip, so its
              // chips drop the sheet's 44px touch floor. Everywhere else keeps
              // it: on a phone the sheet's filters are a primary control, and
              // these are a refinement on a screen you are already aiming at.
              compact ? 'px-1.5 py-0.5 text-[10px]' : 'min-h-11 px-2 py-1 text-xs md:min-h-0'
            } ${
              active
                ? 'border-brand-500 bg-brand-600/30 text-brand-300'
                : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
            }`}
          >
            {labelFor(item)}
          </button>
        );
      })}
      {selected.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          className={`ml-1 text-zinc-500 underline hover:text-zinc-300 ${compact ? 'text-[10px]' : 'text-xs'}`}
        >
          clear
        </button>
      )}
    </div>
  );
}

// **The desktop declare-picker variant: a column beside the move list.**
//
// The picker is a narrow centred panel with a great deal of empty screen either
// side of it on a desktop, and filter chips squeezed inside it were both cramped
// and too small to read at a glance — which is the one thing a filter has to be
// mid-round. Out here they get room, and a font size somebody can actually use.
//
// **Deliberately desktop-only** (`hidden md:flex` at the call site). A phone has
// no side space to give, so the compact in-panel row stays exactly as it is
// there rather than being reflowed into something worse.
//
// Chips stack full-width rather than wrapping: a column of left-aligned labels
// is scannable top-to-bottom, and a ragged two-per-line wrap in a 200px column
// is not.
export function MoveFilterColumn({
  label,
  items,
  selected,
  onToggle,
  onClear,
  labelFor,
  titleFor,
  align = 'left',
}) {
  if (!items?.length) return null;
  return (
    <div className={`flex w-44 shrink-0 flex-col gap-1 lg:w-52 ${align === 'right' ? 'items-end' : 'items-start'}`}>
      <div className="flex w-full items-baseline justify-between gap-2">
        <span className="font-display text-sm font-semibold uppercase tracking-wide text-zinc-400">
          {label}
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-zinc-500 underline hover:text-zinc-300"
          >
            clear
          </button>
        )}
      </div>
      {items.map((item) => {
        const active = selected.has(item.id);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onToggle(item.id)}
            title={titleFor?.(item) || `Filter by ${labelFor(item)}`}
            className={`w-full panel-cut-sm border px-2 py-1 text-sm ${
              align === 'right' ? 'text-right' : 'text-left'
            } ${
              active
                ? 'border-brand-500 bg-brand-600/30 text-brand-200'
                : 'border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
          >
            {labelFor(item)}
          </button>
        );
      })}
    </div>
  );
}
