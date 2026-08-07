import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import DialogShell from './DialogShell.jsx';

// The receiving half of GM Tools' Roll Requester. Mounted globally (see
// App.jsx) rather than on any one page, for the same reason the Dodge prompt
// is: a request has to reach the player wherever they happen to be, and the
// combat header bar — the app's other global mount point — only renders
// while a fight is running. A roll request is not a combat feature.
//
// Answering it runs an ordinary pool:roll for that character's own die, so
// the result is an ordinary chat roll with every usual server-side bonus
// (Reasons to Fight, the Stance matchup) already folded in. This component
// adds no roll mechanic of its own — it only asks.
export default function RollRequestPrompt() {
  const { role, characterId } = useRole();
  // A queue, not a single slot: a GM can fire two requests back to back, and
  // silently dropping the second would leave the table waiting on a roll
  // that was never asked for. Same one-at-a-time pattern the Dodge and
  // move-conflict prompts already use.
  const [queue, setQueue] = useState([]);
  const [modifier, setModifier] = useState('0');

  useEffect(() => {
    const onRequested = (payload) =>
      setQueue((q) => (q.some((r) => r.requestId === payload.requestId) ? q : [...q, payload]));
    socket.on('roll:requested', onRequested);
    return () => socket.off('roll:requested', onRequested);
  }, []);

  const current = queue[0] ?? null;
  const pop = () => {
    setQueue((q) => q.slice(1));
    setModifier('0');
  };

  if (!current) return null;

  // The GM gets the same event so their own (and any second GM tab's) view
  // confirms the request actually went out — but they are not the one being
  // asked to roll, so it's a notice, not a prompt.
  const isMine = role === 'player' && characterId === current.characterId;
  if (!isMine) {
    return (
      <AnimatePresence>
        <motion.div
          key={current.requestId}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          style={{ bottom: 'calc(var(--safe-bottom) + 8rem)' }}
          className="fixed left-1/2 z-[54] -translate-x-1/2 panel-cut-sm border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-300 shadow-lg shadow-black/50"
        >
          Roll request sent — {current.characterName}: {current.slotName}
          {current.targetNumber != null && ` (target ${current.targetNumber})`}
          <button
            type="button"
            onClick={pop}
            className="ml-3 text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </motion.div>
      </AnimatePresence>
    );
  }

  const clamp = (n) => Math.max(-20, Math.min(20, Math.trunc(Number(n) || 0)));
  const roll = () => {
    socket.emit('pool:roll', {
      characterId: current.characterId,
      dieIds: [current.dieId],
      modifier: clamp(modifier),
      // Rides back so the server can resolve this roll against the target
      // number the GM set — which only the server ever knew, so the check
      // cannot be gamed by editing what came down the wire.
      rollRequestId: current.requestId,
    });
    pop();
  };

  const incapacitated = current.status === 'incapacitated';

  return (
    <DialogShell
      title="The GM asks you to roll"
      dismissible={false}
      maxWidth="max-w-sm"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={roll}
            disabled={incapacitated}
            className="flex-1 panel-cut-sm bg-brand-600 py-2 font-display font-semibold uppercase tracking-wide hover:bg-brand-500 disabled:opacity-40"
          >
            Roll {current.slotName}
          </button>
          <button
            type="button"
            onClick={pop}
            className="panel-cut-sm border border-zinc-700 px-4 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            Decline
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-zinc-300">
          <span className="font-display font-semibold text-brand-300">{current.slotName}</span> —{' '}
          <span className="font-mono text-zinc-400">
            d{current.size}
            {current.bonus ? `${current.bonus > 0 ? '+' : '−'}${Math.abs(current.bonus)}` : ''}
          </span>
        </p>
        {incapacitated ? (
          <p className="text-sm text-red-400">
            That Stat is incapacitated — there's nothing to roll. Tell the GM.
          </p>
        ) : (
          <label className="text-sm text-zinc-400">
            Modifier (−20 to +20)
            <input
              autoFocus
              type="number"
              min={-20}
              max={20}
              value={modifier}
              onChange={(e) => setModifier(e.target.value)}
              onFocus={(e) => e.target.select()}
              className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-2 text-lg text-zinc-100 outline-none focus:border-brand-500"
            />
          </label>
        )}
        <p className="text-xs text-zinc-600">
          Rolls exactly like rolling this Stat yourself — any Reasons to Fight and Stance matchup
          bonus is added server-side.
        </p>
      </div>
    </DialogShell>
  );
}
