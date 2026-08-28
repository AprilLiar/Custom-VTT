import { useState } from 'react';
import { Star } from 'lucide-react';
import {
  MAX_FAVOURITES,
  loadFavourites,
  saveFavourites,
  toggleFavourite,
} from '../lib/emojiFavourites.js';

// A curated emoji picker, hand-rolled.
//
// **No dependency, deliberately.** This client's entire runtime is seven
// packages — react, react-dom, react-router-dom, framer-motion, gsap,
// lucide-react, socket.io-client — and an emoji picker library would be the
// largest of them, for a control used on one field of one tab.
//
// The rows are chosen for what a relationship actually is, not alphabetically:
// the things you reach for when naming how two people stand to each other. A
// complete set would be worse here, not better — scrolling a thousand emoji to
// find the dagger is slower than seeing it in the second row.
//
// Anything not here is still typeable: the picker inserts into a normal text
// field, it does not own it.

export const EMOJI_ROWS = [
  { label: 'Bonds', emoji: ['❤️', '💛', '💚', '💙', '💜', '🤝', '🫂', '🤞', '🥂', '🕊️'] },
  { label: 'Trouble', emoji: ['💔', '⚔️', '🗡️', '🔥', '💢', '🩸', '☠️', '⚡', '🧨', '🚫'] },
  { label: 'Standing', emoji: ['👑', '⭐', '🛡️', '⛓️', '🎖️', '🗿', '⚖️', '🏛️', '📜', '🎭'] },
  { label: 'Dealings', emoji: ['💰', '🪙', '💎', '📈', '🤲', '🎁', '🧾', '🍺', '🔧', '🗝️'] },
  { label: 'Secrets', emoji: ['🤫', '👁️', '🕯️', '🌑', '🎯', '🪞', '❓', '🧩', '🐍', '🦂'] },
  { label: 'Kin', emoji: ['👨‍👩‍👧', '🧑‍🎓', '🧓', '👶', '🏠', '⚰️', '🌱', '🐕', '⛩️', '🌍'] },
];

// **Right-click to favourite (decided, new).** Six labelled rows are quick to
// scan once and slow to scan every time, and everyone reaches for the same
// three or four. Favourites ride at the top, newest first, so the emoji you
// just decided you liked is the first one you see next time.
//
// Right-click rather than a long-press or a mode toggle: it is the one gesture
// on a desktop pointer that is not already spoken for here — left-click inserts
// — and it costs no chrome at all. The browser's own menu is suppressed on the
// buttons only, so right-clicking anywhere else in the popover still behaves
// normally.
export default function EmojiGrid({ onPick, onClose }) {
  const [favourites, setFavourites] = useState(loadFavourites);

  const toggle = (emoji) => {
    const next = toggleFavourite(favourites, emoji);
    setFavourites(next);
    saveFavourites(next);
  };

  const full = favourites.length >= MAX_FAVOURITES;

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="max-h-72 w-64 overflow-y-auto panel-cut border border-zinc-700 bg-zinc-950 p-2 shadow-2xl shadow-black/80"
    >
      {favourites.length > 0 && (
        <div className="mb-1.5 border-b border-zinc-800 pb-1.5">
          <div className="mb-0.5 flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.2em] text-amber-500/80">
            <Star size={9} className="fill-amber-500/80" />
            Favourites
          </div>
          <div className="flex flex-wrap gap-0.5">
            {favourites.map((emoji) => (
              <EmojiButton
                key={`fav-${emoji}`}
                emoji={emoji}
                favourite
                title={`${emoji} — right-click to remove from favourites`}
                onPick={onPick}
                onToggle={toggle}
              />
            ))}
          </div>
        </div>
      )}

      {EMOJI_ROWS.map((row) => (
        <div key={row.label} className="mb-1.5">
          <div className="mb-0.5 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600">
            {row.label}
          </div>
          <div className="flex flex-wrap gap-0.5">
            {row.emoji.map((emoji) => {
              const fav = favourites.includes(emoji);
              return (
                <EmojiButton
                  key={emoji}
                  emoji={emoji}
                  favourite={fav}
                  title={
                    fav
                      ? `${emoji} — right-click to remove from favourites`
                      : full
                        ? `${emoji} — favourites are full (${MAX_FAVOURITES})`
                        : `${emoji} — right-click to favourite`
                  }
                  onPick={onPick}
                  onToggle={toggle}
                />
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-1">
        <span className="text-[9px] leading-tight text-zinc-600">Right-click to favourite</span>
        <button
          type="button"
          onClick={onClose}
          className="text-[10px] font-bold uppercase tracking-wide text-zinc-600 hover:text-zinc-300"
        >
          Close
        </button>
      </div>
    </div>
  );
}

// A favourited emoji carries a small corner dot rather than a star overlay: at
// 28px a star large enough to read would cover the emoji it is marking, and the
// point of the grid is seeing the emoji.
function EmojiButton({ emoji, favourite, title, onPick, onToggle }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => onPick(emoji)}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggle(emoji);
      }}
      className="relative h-7 w-7 rounded text-base leading-none hover:bg-zinc-800"
    >
      {emoji}
      {favourite && (
        <span className="absolute right-0.5 top-0.5 block h-1.5 w-1.5 rounded-full bg-amber-400" />
      )}
    </button>
  );
}
