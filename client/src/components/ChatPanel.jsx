import { useEffect, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { getChat } from '../lib/api.js';
import { dieLabel } from '../lib/dice.js';

function Entry({ entry }) {
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const multi = entry.dice.length > 1;
  return (
    <div className="border-b border-zinc-800 px-3 py-2 text-sm">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-zinc-200">{entry.characterName}</span>
        {entry.modifier !== 0 && (
          <span className="text-xs text-indigo-400">
            mod {entry.modifier > 0 ? `+${entry.modifier}` : entry.modifier}
          </span>
        )}
        <span className="ml-auto text-xs text-zinc-600">{time}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-400">
        {entry.dice.map((d, i) => (
          <span key={i}>
            {d.slot_name} ({dieLabel(d.size, d.bonus)}):{' '}
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
  );
}

export default function ChatPanel({ open, onClose }) {
  const [entries, setEntries] = useState([]);
  const bottomRef = useRef(null);

  useEffect(() => {
    getChat().then(setEntries).catch(console.error);
    const onRoll = (entry) => setEntries((prev) => [...prev, entry]);
    socket.on('roll:result', onRoll);
    return () => socket.off('roll:result', onRoll);
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
          entries.map((entry, i) => <Entry key={entry.id ?? `live-${i}`} entry={entry} />)
        )}
        <div ref={bottomRef} />
      </div>
    </aside>
  );
}
