import { useRef } from 'react';
import { motion } from 'framer-motion';
import { gsap } from 'gsap';
import { dieLabel, tintFor } from '../lib/dice.js';

// compact drops the slot-name label and shrinks the button. Icon, if given,
// renders low-opacity inside the button itself, behind the die-size number
// — used on the Vitruvian anatomy layout (Tab 1) to mark what each die is.
export default function DieWidget({
  die,
  onRoll,
  onStep,
  selecting,
  selected,
  onToggleSelect,
  compact = false,
  Icon = null,
}) {
  const incapacitated = die.status === 'incapacitated';
  const tint = tintFor(die);
  const buttonRef = useRef(null);

  const clickDie = () => {
    if (incapacitated) return;
    if (selecting) onToggleSelect(die);
    else onRoll(die);
  };

  // A quick punchy flash/pop on step — GSAP handles the timeline so the glow
  // fades independently of React's render cycle, no state needed for it.
  const step = (direction) => {
    onStep(die, direction);
    if (buttonRef.current) {
      gsap.fromTo(
        buttonRef.current,
        { scale: 1.22, boxShadow: '0 0 0 6px rgba(99,102,241,0.55)' },
        { scale: 1, boxShadow: '0 0 0 0 rgba(99,102,241,0)', duration: 0.45, ease: 'power3.out' }
      );
    }
  };

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex items-center gap-1">
        <motion.button
          ref={buttonRef}
          onClick={clickDie}
          disabled={incapacitated}
          whileTap={incapacitated ? undefined : { scale: 0.9 }}
          title={
            incapacitated
              ? 'Incapacitated — step up to revive'
              : selecting
                ? selected
                  ? 'Remove from pool roll'
                  : 'Add to pool roll'
                : 'Roll this die'
          }
          className={`relative flex items-center justify-center rounded-xl border font-display font-bold transition-colors ${
            compact ? 'h-14 w-14 text-base' : 'h-16 w-16 text-lg'
          } ${
            incapacitated
              ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-700'
              : 'border-zinc-700 bg-zinc-800/90 text-zinc-100 backdrop-blur-sm hover:border-indigo-500'
          } ${selected ? 'ring-2 ring-indigo-400' : ''} ${
            selecting && !incapacitated && !selected ? 'opacity-70' : ''
          }`}
          style={tint ? { backgroundColor: tint } : undefined}
        >
          {Icon && !incapacitated && (
            <Icon
              className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-zinc-100 opacity-25 ${
                compact ? 'h-8 w-8' : 'h-9 w-9'
              }`}
            />
          )}
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
        </motion.button>
        <div className="flex flex-col">
          <button
            onClick={() => step('up')}
            title={incapacitated ? 'Revive to d4' : 'Step up'}
            className="rounded px-1 text-green-500 hover:bg-green-900/30"
          >
            ▲
          </button>
          <button
            onClick={() => step('down')}
            disabled={incapacitated}
            title="Step down"
            className="rounded px-1 text-red-500 hover:bg-red-900/30 disabled:opacity-30"
          >
            ▼
          </button>
        </div>
      </div>
      {!compact && <span className="text-xs text-zinc-500">{die.slot_name}</span>}
    </div>
  );
}
