import { useState } from 'react';
import { socket } from '../socket.js';

const MIN_TARGET = 2;
const MAX_TARGET = 20;

function Pips({ current, target }) {
  return (
    <div className="flex flex-1 flex-wrap items-center justify-center gap-1.5" title={`${current} / ${target}`}>
      {Array.from({ length: target }, (_, i) => (
        <span
          key={i}
          className={`h-4 w-4 rounded-full border ${
            i < current
              ? 'border-indigo-400 bg-indigo-500'
              : 'border-zinc-700 bg-zinc-800'
          }`}
        />
      ))}
    </div>
  );
}

function CounterRow({ counter }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center gap-2">
        <span className="font-bold text-zinc-100">{counter.name}</span>
        <span className="font-mono text-xs text-zinc-500">
          {counter.current_pips}/{counter.target_pips}
        </span>
        <label className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={Boolean(counter.show_in_combat)}
            onChange={() => socket.emit('counter:toggle_show_in_combat', { counterId: counter.id })}
          />
          Show in Combat
        </label>
        <button
          onClick={() => socket.emit('counter:delete', { counterId: counter.id })}
          title="Delete"
          className="rounded px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
        >
          ✕
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: -1 })}
          disabled={counter.current_pips <= 0}
          className="h-8 w-8 shrink-0 rounded-md border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800 disabled:opacity-30"
        >
          −
        </button>
        <Pips current={counter.current_pips} target={counter.target_pips} />
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: 1 })}
          disabled={counter.current_pips >= counter.target_pips}
          className="h-8 w-8 shrink-0 rounded-md border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800 disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  );
}

// Tab 5: the character's own counters — simple persistent clocks, no
// automation. Anyone controlling the character can create/adjust them.
export default function CountersTab({ data }) {
  const { character, counters } = data;
  const [name, setName] = useState('');
  const [target, setTarget] = useState(6);

  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    socket.emit('counter:create', {
      characterId: character.id,
      name: name.trim(),
      targetPips: target,
    });
    setName('');
    setTarget(6);
  };

  return (
    <div className="space-y-3">
      {counters.length === 0 ? (
        <p className="text-sm text-zinc-600">No counters yet.</p>
      ) : (
        counters.map((counter) => <CounterRow key={counter.id} counter={counter} />)
      )}

      <form onSubmit={add} className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Counter name"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
        <label className="flex items-center gap-1.5 text-xs text-zinc-500">
          Target
          <input
            type="number"
            min={MIN_TARGET}
            max={MAX_TARGET}
            value={target}
            onChange={(e) =>
              setTarget(Math.max(MIN_TARGET, Math.min(MAX_TARGET, Number(e.target.value) || MIN_TARGET)))
            }
            className="w-16 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
          />
        </label>
        <button
          type="submit"
          disabled={!name.trim()}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-semibold hover:bg-indigo-500 disabled:opacity-40"
        >
          + New Counter
        </button>
      </form>
    </div>
  );
}
