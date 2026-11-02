import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { MessageCircle, X } from 'lucide-react';
import { socket } from '../socket.js';
import { useRoster } from '../lib/useRoster.js';
import ChatPanel, { Entry } from './ChatPanel.jsx';

// Chat on the Scene page (decided, mobile follow-up). The Scene route is
// chrome-free, so the app's Chat panel isn't mounted there; this brings two
// things back:
//
//   - **Floating cards.** Any new chat entry — a message, a roll, a fight
//     card — appears bottom-right as a card, newer ones pushing older ones up
//     like a chat list. One shared countdown restarts with every new card;
//     6 seconds after the LAST one, they all go. Not shown while the full
//     chat is open.
//   - **A turn-start Stance roll is pinned (decided):** it ignores the timer
//     and stays until THAT fighter's turn ends (`fight:turn_ended`) or the
//     fight ends — the player needs those numbers for the whole turn. Every
//     other card, before or after it, fades as usual.
//   - **A round chat button** that opens the full Chat as an overlay over the
//     Scene and closes it on a second press. It stays visible with the
//     interface hidden.

const HIDE_AFTER_MS = 6000;
const MAX_CARDS = 4;
const EVENTS = ['roll:result', 'chat:message', 'chat:card'];

// `cardsRight`: how far from the right edge the cards sit (the initiative
// rail lives top-left, so nothing shares this corner by default).
export default function SceneChat({ cardsRight = 12 }) {
  const roster = useRoster();
  const characters = useMemo(() => new Map((roster ?? []).map((c) => [c.id, c])), [roster]);
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState([]); // [{ key, entry, pin: combatantId | null }]
  const openRef = useRef(open);
  openRef.current = open;
  const timerRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const pinnedFor = (entry) => (entry.kind === 'stance_roll' ? (entry.payload?.combatant_id ?? null) : null);
    const onEntry = (entry) => {
      seq.current += 1;
      const key = seq.current;
      const pin = pinnedFor(entry);
      // With the full chat open nothing floats — except a pinned roll, which
      // must still be there when the chat is closed again.
      if (openRef.current && pin == null) return;
      setCards((prev) => {
        const next = [...prev, { key, entry, pin }];
        const loose = next.filter((c) => c.pin == null).slice(-MAX_CARDS);
        return next.filter((c) => c.pin != null || loose.includes(c));
      });
      if (pin == null) {
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCards((prev) => prev.filter((c) => c.pin != null)), HIDE_AFTER_MS);
      }
    };
    const onTurnEnded = ({ combatantId }) => setCards((prev) => prev.filter((c) => c.pin !== combatantId));
    const onFightEnded = () => setCards((prev) => prev.filter((c) => c.pin == null));
    for (const ev of EVENTS) socket.on(ev, onEntry);
    socket.on('fight:turn_ended', onTurnEnded);
    socket.on('fight:ended', onFightEnded);
    return () => {
      for (const ev of EVENTS) socket.off(ev, onEntry);
      socket.off('fight:turn_ended', onTurnEnded);
      socket.off('fight:ended', onFightEnded);
      clearTimeout(timerRef.current);
    };
  }, []);

  // Opening the chat clears the floating cards, but not a pinned roll.
  const toggle = () => {
    setOpen((o) => !o);
    setCards((prev) => prev.filter((c) => c.pin != null));
  };

  return (
    <>
      {!open && (
        <div
          className="pointer-events-none fixed flex w-72 max-w-[calc(100vw-24px)] flex-col items-stretch justify-end gap-2 overflow-hidden"
          // Clipped at the top on a short screen: the newest stay, the oldest go first.
          style={{ right: cardsRight, bottom: 196, maxHeight: 'calc(100dvh - 204px)', zIndex: 1050, marginRight: 'var(--safe-right)' }}
          aria-live="polite"
        >
          <AnimatePresence initial={false}>
            {cards.map(({ key, entry }) => (
              <motion.div
                key={key}
                layout
                initial={{ opacity: 0, y: 16, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.35 } }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                className="shrink-0 overflow-hidden panel-cut-sm border border-zinc-700 bg-zinc-900/95 shadow-xl shadow-black/50"
              >
                <Entry entry={entry} character={characters.get(entry.characterId)} compact />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {open && (
        <div className="fixed inset-y-0 right-0 flex w-full sm:w-80" style={{ zIndex: 1040 }}>
          <ChatPanel open />
        </div>
      )}

      <button
        type="button"
        onClick={toggle}
        title={open ? 'Close chat' : 'Open chat'}
        aria-label={open ? 'Close chat' : 'Open chat'}
        className="fixed flex h-11 w-11 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/90 text-zinc-200 shadow-lg shadow-black/50 hover:border-brand-500 hover:text-brand-300"
        style={{ right: 22, bottom: 140, zIndex: 1060, marginRight: 'var(--safe-right)', marginBottom: 'var(--safe-bottom)' }}
      >
        {open ? <X size={18} aria-hidden /> : <MessageCircle size={18} aria-hidden />}
        {!open && cards.some((c) => c.pin == null) && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border border-zinc-900 bg-brand-500" />
        )}
      </button>
    </>
  );
}
