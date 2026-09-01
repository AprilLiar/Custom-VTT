import { QUIRK_KINDS, quirkStyle, splitQuirks } from '../lib/quirkStyles.js';

// **Two clear halves, split down the middle: Positive on the left, Negative on
// the right** (the ask, in those words). Both the Compendium's shelf and a
// character's own tab lay out this way, so the split lives here rather than
// twice — the halves have to be the same halves, or the same Quirk moves
// between pages.
//
// `grid-cols-2` with equal tracks, not a flex pair: equal is the whole point,
// and a flex row would let a long description on one side steal width from the
// other. On a phone they stack, positives first — a 44px-wide column of prose
// is not a column.
//
// Each half carries its own faint frame so an EMPTY side still reads as the
// positive one rather than as nothing at all, which is what a new character's
// sheet looks like and is exactly when the labels matter most.
export default function QuirkColumns({ quirks, renderQuirk, emptyText = 'None yet.', footer = null }) {
  const split = splitQuirks(quirks);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {QUIRK_KINDS.map((kind) => {
        const style = quirkStyle(kind);
        const list = split[kind];
        return (
          <section key={kind} className={`min-w-0 space-y-2 panel-cut border p-2 ${style.column}`}>
            <h3
              className={`font-display text-xs font-bold uppercase tracking-widest ${style.heading}`}
            >
              {style.label}
              <span className="ml-2 font-normal text-zinc-600">{list.length}</span>
            </h3>
            {list.length === 0 ? (
              <p className="px-1 py-2 text-sm italic text-zinc-600">{emptyText}</p>
            ) : (
              list.map((quirk) => renderQuirk(quirk))
            )}
            {footer?.(kind)}
          </section>
        );
      })}
    </div>
  );
}
