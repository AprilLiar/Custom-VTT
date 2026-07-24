import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getChat, getCharacters } from '../lib/api.js';
import { dieFormula } from '../lib/dice.js';
import Thumb from './Thumb.jsx';

function Entry({ entry, character }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const multi = entry.dice.length > 1;
  return (
    <div className="flex gap-2 border-b border-zinc-800 px-3 py-2 text-sm">
      <Thumb
        record={character}
        name={character ? entry.characterName : '?'}
        size="h-6 w-6"
        rounded="rounded-full"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold text-zinc-200">{entry.characterName}</span>
          <span className="ml-auto text-xs text-zinc-600">{time}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-400">
          {entry.dice.map((d, i) => (
            <span key={i}>
              {d.slot_name} ({dieFormula(d.size, d.bonus, entry.modifier)}):{' '}
              <span className="font-mono text-zinc-200">{d.result}</span>
            </span>
          ))}
        </div>
        {multi && (
          <div className="mt-0.5 text-right font-mono text-sm font-bold text-zinc-100">
            Total {entry.total}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({ open, onClose }) {
  const [entries, setEntries] = useState([]);
  const [characters, setCharacters] = useState(new Map());
  const bottomRef = useRef(null);

  useEffect(() => {
    getChat().then(setEntries).catch(console.error);
    const onRoll = (entry) => setEntries((prev) => [...prev, entry]);
    socket.on('roll:result', onRoll);
    return () => socket.off('roll:result', onRoll);
  }, []);

  useEffect(() => {
    // Avatars for the roll feed — unfiltered by role, same as the rolls
    // themselves (everyone sees everyone's rolls, NPCs included).
    const refresh = () =>
      getCharacters()
        .then((list) => setCharacters(new Map(list.map((c) => [c.id, c]))))
        .catch(console.error);
    refresh();
    const events = ['character:created', 'character:updated', 'character:deleted'];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries, open]);

  if (!open) return null;

  return (
    <aside className="fixed inset-0 z-40 flex flex-col bg-zinc-900 md:static md:z-auto md:w-80 md:border-l md:border-zinc-800">
      <div className="flex items-center border-b border-zinc-800 px-3 py-2">
        <h2 className="text-sm font-bold uppercase tracking-wide text-zinc-400">Chat Log</h2>
        <button
          onClick={onClose}
          className="ml-auto rounded px-2 text-zinc-500 hover:text-zinc-200 md:hidden"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="p-4 text-sm text-zinc-600">No rolls yet.</p>
        ) : (
          entries.map((entry, i) => (
            <Entry
              key={entry.id ?? `live-${i}`}
              entry={entry}
              character={characters.get(entry.characterId)}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}
