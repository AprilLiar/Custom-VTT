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

export default function EmojiGrid({ onPick, onClose }) {
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      className="max-h-64 w-64 overflow-y-auto panel-cut border border-zinc-700 bg-zinc-950 p-2 shadow-2xl shadow-black/80"
    >
      {EMOJI_ROWS.map((row) => (
        <div key={row.label} className="mb-1.5">
          <div className="mb-0.5 text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-600">
            {row.label}
          </div>
          <div className="flex flex-wrap gap-0.5">
            {row.emoji.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => onPick(emoji)}
                className="h-7 w-7 rounded text-base leading-none hover:bg-zinc-800"
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={onClose}
        className="mt-1 w-full text-[10px] font-bold uppercase tracking-wide text-zinc-600 hover:text-zinc-300"
      >
        Close
      </button>
    </div>
  );
}
