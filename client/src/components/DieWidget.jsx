import { dieLabel, tintFor } from '../lib/dice.js';

export default function DieWidget({ die, onRoll, onStep, selecting, selected, onToggleSelect }) {
  const incapacitated = die.status === 'incapacitated';
  const tint = tintFor(die);

  const clickDie = () => {
    if (incapacitated) return;
    if (selecting) onToggleSelect(die);
    else onRoll(die);
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-1">
        <button
          onClick={clickDie}
          disabled={incapacitated}
          title={
            incapacitated
              ? 'Incapacitated — step up to revive'
              : selecting
                ? selected
                  ? 'Remove from pool roll'
                  : 'Add to pool roll'
                : 'Roll this die'
          }
          className={`relative flex h-16 w-16 items-center justify-center rounded-xl border text-lg font-bold transition ${
            incapacitated
              ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-700'
              : 'border-zinc-700 bg-zinc-800 text-zinc-100 hover:border-indigo-500 active:scale-95'
          } ${selected ? 'ring-2 ring-indigo-400' : ''} ${
            selecting && !incapacitated && !selected ? 'opacity-70' : ''
          }`}
          style={tint ? { backgroundColor: tint } : undefined}
        >
          <span className={incapacitated ? 'line-through' : ''}>
            {dieLabel(die.current_size, die.bonus)}
          </span>
          {incapacitated && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <span className="h-0.5 w-full rotate-45 bg-red-900/70" />
              <span className="absolute h-0.5 w-full -rotate-45 bg-red-900/70" />
            </span>
          )}
          {selected && (
            <span className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-xs text-white">
              ✓
            </span>
          )}
        </button>
        <div className="flex flex-col">
          <button
            onClick={() => onStep(die, 'up')}
            title={incapacitated ? 'Revive to d4' : 'Step up'}
            className="rounded px-1 text-green-500 hover:bg-green-900/30"
          >
            ▲
          </button>
          <button
            onClick={() => onStep(die, 'down')}
            disabled={incapacitated}
            title="Step down"
            className="rounded px-1 text-red-500 hover:bg-red-900/30 disabled:opacity-30"
          >
            ▼
          </button>
        </div>
      </div>
      <span className="text-xs text-zinc-500">{die.slot_name}</span>
    </div>
  );
}
