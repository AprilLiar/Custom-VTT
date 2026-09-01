import { ArrowUp } from 'lucide-react';
import { quirkStyle } from '../lib/quirkStyles.js';

// One Quirk, wherever it is drawn — the Compendium's shelf, a character sheet,
// the Creator's step, and the card the Chat Log shows when somebody shares one.
// A name, a description, and whatever buttons the surface wants after them.
//
// Deliberately not `PerkCard` with a colour prop: a Perk card carries a
// picture, Perk Tags and an ⚙ automated badge, and a Quirk has none of those
// and never will. Two small components that look alike beat one that has to be
// told which half of itself to render.
//
// `onShare` puts a small ↑ in the bottom-right corner: **show this to the
// table**, which posts the same card into the Chat Log in the same colours.
// Bottom-right and small on purpose — it is an occasional flourish, not
// something to reach for while reading, and it must not compete with the Edit
// and Remove that sit on the title line.
export default function QuirkCard({ quirk, actions = null, onShare = null, byline = null }) {
  const style = quirkStyle(quirk.kind);
  return (
    <div className={`relative panel-cut-sm border p-3 ${style.card}`}>
      <div className="flex items-start gap-2">
        <h3 className="min-w-0 flex-1 font-display text-sm font-semibold uppercase tracking-wide text-zinc-100 md:text-base">
          {quirk.name}
        </h3>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {byline && (
        <p className={`mt-0.5 font-display text-[11px] uppercase tracking-widest ${style.heading}`}>
          {byline}
        </p>
      )}
      {/* `whitespace-pre-wrap`: a Quirk is prose the table wrote, and a player
          who typed two paragraphs meant two paragraphs. `pr-7` on the last line
          keeps the share button off the text — the button is absolute, so
          without it a long final line runs underneath. */}
      {quirk.description ? (
        <p className={`mt-1.5 whitespace-pre-wrap text-sm leading-snug text-zinc-300 ${onShare ? 'pr-7' : ''}`}>
          {quirk.description}
        </p>
      ) : (
        <p className={`mt-1.5 text-sm italic text-zinc-600 ${onShare ? 'pr-7' : ''}`}>No description.</p>
      )}
      {onShare && (
        <button
          type="button"
          onClick={onShare}
          title={`Show "${quirk.name}" to the table`}
          aria-label={`Show ${quirk.name} to the table`}
          className={`absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center panel-cut-sm border opacity-60 transition hover:opacity-100 ${style.chip}`}
        >
          <ArrowUp size={14} aria-hidden />
        </button>
      )}
    </div>
  );
}
