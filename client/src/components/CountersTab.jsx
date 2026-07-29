import { useState } from 'react';
import { socket } from '../socket.js';
import { REWARD_TYPES, REWARD_LABELS, REWARD_COLORS } from '../lib/counterDisplay.js';

const MIN_TARGET = 2;
const MAX_TARGET = 20;

// Doubles as the reward "tag" and its own editing control — colored when a
// reward is set, neutral dashed-looking when not. Purely cosmetic, no
// mechanical effect; character-owned counters only (every counter on this
// tab already is one).
function RewardSelect({ counter }) {
  return (
    <select
      value={counter.reward_type ?? ''}
      onChange={(e) =>
        socket.emit('counter:set_reward', { counterId: counter.id, rewardType: e.target.value || null })
      }
      title="Reward (tracking only — no mechanical effect)"
      className={`shrink-0 rounded-full border-none px-2 py-0.5 text-xs font-semibold uppercase outline-none ${
        counter.reward_type ? REWARD_COLORS[counter.reward_type] : 'bg-zinc-800 text-zinc-500'
      }`}
    >
      <option value="">No Reward</option>
      {REWARD_TYPES.map((r) => (
        <option key={r} value={r}>
          {REWARD_LABELS[r]}
        </option>
      ))}
    </select>
  );
}

function Pips({ current, target }) {
  return (
    <div className="flex flex-1 flex-wrap items-center justify-center gap-1.5" title={`${current} / ${target}`}>
      {Array.from({ length: target }, (_, i) => (
        <span
          key={i}
          className={`h-4 w-4 rounded-full border ${
            i < current
              ? 'border-brand-400 bg-brand-500'
              : 'border-zinc-700 bg-zinc-800'
          }`}
        />
      ))}
    </div>
  );
}

function CounterRow({ counter }) {
  return (
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-3">
      <div className="flex items-center gap-2">
        <span className="font-bold text-zinc-100">{counter.name}</span>
        <RewardSelect counter={counter} />
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
          className="panel-cut-sm px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
        >
          ✕
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: -1 })}
          disabled={counter.current_pips <= 0}
          className="h-8 w-8 shrink-0 panel-cut-sm border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800 disabled:opacity-30"
        >
          −
        </button>
        <Pips current={counter.current_pips} target={counter.target_pips} />
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: 1 })}
          disabled={counter.current_pips >= counter.target_pips}
          className="h-8 w-8 shrink-0 panel-cut-sm border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800 disabled:opacity-30"
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
  const [reward, setReward] = useState('');

  const add = (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    socket.emit('counter:create', {
      characterId: character.id,
      name: name.trim(),
      targetPips: target,
      rewardType: reward || null,
    });
    setName('');
    setTarget(6);
    setReward('');
  };

  return (
    <div className="space-y-3">
      {counters.length === 0 ? (
        <p className="text-sm text-zinc-600">No counters yet.</p>
      ) : (
        counters.map((counter) => <CounterRow key={counter.id} counter={counter} />)
      )}

      <form onSubmit={add} className="flex flex-wrap items-center gap-2 panel-cut-lg border border-zinc-800 bg-zinc-900 p-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Counter name"
          className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
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
            className="w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
        </label>
        <select
          value={reward}
          onChange={(e) => setReward(e.target.value)}
          title="Reward (tracking only — no mechanical effect)"
          className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-300 outline-none focus:border-brand-500"
        >
          <option value="">No Reward</option>
          {REWARD_TYPES.map((r) => (
            <option key={r} value={r}>
              Reward: {REWARD_LABELS[r]}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!name.trim()}
          className="panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
        >
          + New Counter
        </button>
      </form>
    </div>
  );
}
