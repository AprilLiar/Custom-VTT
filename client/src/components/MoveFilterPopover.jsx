import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Filter } from 'lucide-react';
import useAnchoredPosition from '../lib/useAnchoredPosition.js';

// **The move filter, folded into one button (decided, new).**
//
// The four filters used to sit open on the page as four columns of chips.
// That is right in the Arena — mid-round you are choosing a move against a
// clock, and a filter you have to open first is a filter you will not use — and
// wrong everywhere else: on the Compendium and on a character's Moves tab the
// same four columns ate the top of the page before a single move was visible,
// and the Tag column alone runs to twenty-odd chips.
//
// So the Arena keeps its columns and every other surface gets this: one button
// with a funnel on it, and the filters in a panel that opens from it. The
// button is **sticky**, so it stays reachable as you scroll a long library
// rather than scrolling away with the header it was part of.
//
// **Portalled to <body>, like every other floating panel in this codebase.**
// Both call sites sit inside `<main class="overflow-y-auto">`, which clips on
// both axes — a panel positioned inside it would be cut off at the container's
// edge — and the sticky wrapper itself creates a positioning context the panel
// would then be trapped in. `useAnchoredPosition` handles the viewport clamping
// and the flip-above-or-below, which is the same behaviour every other anchored
// panel here already has.
//
// `children` is whatever rows the caller wants inside — this component owns the
// button, the panel and the dismissal, not the filters themselves. That keeps
// the Compendium's icon-only Style row (the one control here that is not
// `MoveFilterChips`) working with no special case.
export default function MoveFilterPopover({ activeCount = 0, onClear, children, className = '' }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);
  const panelRef = useRef(null);
  // Wide, because the panel holds four rows of chips and a Tag list can run to
  // twenty of them — clamped to the viewport by the hook on a phone.
  const pos = useAnchoredPosition(anchorRef, open, { width: 640 });

  // Escape closes, and a pointer down anywhere outside closes — the panel is a
  // refinement you step away from, not a dialog you dismiss. Both are needed:
  // the panel is portalled, so a click on the page behind it is not a click on
  // any ancestor of it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e) => {
      if (panelRef.current?.contains(e.target)) return;
      if (anchorRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div className={`sticky top-0 z-30 -mx-1 flex items-center gap-2 bg-zinc-950/90 px-1 py-1.5 backdrop-blur ${className}`}>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        title={activeCount ? `${activeCount} filter${activeCount === 1 ? '' : 's'} active` : 'Filter these moves'}
        className={`flex min-h-11 items-center gap-2 panel-cut-sm border px-3 text-sm font-semibold md:min-h-0 md:py-1.5 ${
          activeCount || open
            ? 'border-brand-500 bg-brand-600/25 text-brand-200'
            : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
        }`}
      >
        <Filter size={15} aria-hidden />
        <span className="font-display uppercase tracking-wide">Filters</span>
        {/* The count is what makes a collapsed filter honest: a list showing
            eleven of ninety moves must say why on the button, or the missing
            moves read as a bug. */}
        {activeCount > 0 && (
          <span className="panel-cut-sm bg-brand-600 px-1.5 text-xs font-bold text-white">{activeCount}</span>
        )}
      </button>
      {/* Clearing everything without opening the panel: the one thing you want
          from a filter you can no longer see. */}
      {activeCount > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-zinc-500 underline hover:text-zinc-300"
        >
          clear all
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[80] max-h-[70vh] space-y-3 overflow-y-auto panel-cut border border-zinc-700 bg-zinc-950 p-3 shadow-[0_18px_40px_rgba(0,0,0,0.65)]"
            style={{ left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}
