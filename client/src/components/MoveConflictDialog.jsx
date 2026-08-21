import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import DialogShell from './DialogShell.jsx';

// The Block-extension prompt (Defence rework decision #4 — this replaces the
// old Forfeit/Postpone dialog).
//
// **The question changed shape, so the dialog did too.** It used to ask about
// one colliding move at a time and re-ask as the knock-on worked down the
// queue. Now the whole cascade is computed server-side and asked about once, so
// the choice is a real one — and the tail is listed, because "push everything
// back" is not a decision anyone can make without seeing what everything is.
//
// Goes to whoever controls the affected character (their own player, or the GM
// for an NPC — see CombatHeaderBar's ownership gate), not to the GM at large:
// it is that fighter's commitment being spent.
//
// Closing without choosing is deliberately not offered. The round is paused on
// this answer, and a dismissed prompt would strand it — which is also why the
// dialog no longer takes itself down on click (decided, reworked): it is
// rendered from the pause as the server reports it and stays up until the server
// stops reporting it. Clicking used to remove it on the spot, so an answer that
// never arrived took the question with it. See DefensePromptDialog, which was
// reworked the same way and for the same reason.
export default function MoveConflictDialog({
  declaredMoveId,
  blockerDeclaredMoveId,
  blockerMoveName,
  shifts = [],
  characterName,
  // Called on click, purely so a hand-summoned copy of this prompt can stand
  // down (see lib/pausePrompts.js). It does NOT dismiss this dialog.
  onAnswered,
}) {
  const [submit, setSubmit] = useState('idle');
  useEffect(() => {
    if (submit !== 'sent') return undefined;
    const timer = setTimeout(() => setSubmit('stalled'), 8000);
    return () => clearTimeout(timer);
  }, [submit]);

  const resolve = (choice) => {
    socket.emit('combat:resolve_move_conflict', { declaredMoveId, blockerDeclaredMoveId, choice });
    setSubmit('sent');
    onAnswered?.();
  };
  const busy = submit === 'sent';
  const first = shifts[0];
  const spills = shifts.filter((s) => s.leavesRound);

  return (
    <DialogShell
      title="The Guard Held Longer"
      dismissible={false}
      maxWidth="max-w-md"
      panelClassName="border-amber-700/50"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => resolve('forfeit')}
            disabled={busy}
            className="min-h-11 flex-1 panel-cut-sm border border-red-700/50 bg-red-950/40 py-2 font-semibold text-red-300 hover:bg-red-900/40 disabled:opacity-50"
          >
            Forfeit {first?.moveName ? `“${first.moveName}”` : 'it'}
          </button>
          <button
            type="button"
            onClick={() => resolve('extend')}
            disabled={busy}
            className="min-h-11 flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold text-white hover:bg-brand-500 disabled:opacity-50"
          >
            Push Everything Back
          </button>
        </div>
      }
    >
      <p className="text-sm text-zinc-300">
        {characterName ? `${characterName}'s ` : 'Your '}
        {blockerMoveName ? `“${blockerMoveName}”` : 'guard'} held through the attack, and the extra
        Recovery runs into what came next.
      </p>

      {shifts.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {shifts.map((s) => (
            <li key={s.declaredMoveId} className="flex items-baseline justify-between gap-3">
              <span className="text-zinc-200">{s.moveName ?? 'A declared move'}</span>
              <span className="shrink-0 font-mono text-xs text-zinc-400">
                Tic {s.from} → {s.to}
                {s.leavesRound && <span className="ml-2 text-amber-400">next round</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {spills.length > 0 && (
        <p className="mt-3 text-xs text-amber-300/90">
          {spills.length === 1 ? 'That last one lands' : 'Those land'} entirely in the next round, so{' '}
          {spills.length === 1 ? 'its' : 'their'} Stamina comes back and you can cancel or re-place{' '}
          {spills.length === 1 ? 'it' : 'them'} when Declaration reopens.
        </p>
      )}

      <p className="mt-3 text-xs text-zinc-500">
        Forfeiting gives up only the first move — its Stamina is refunded, and anything behind it
        still slides forward to clear the guard.
      </p>
      {submit === 'sent' && <p className="mt-2 text-xs text-zinc-500">Sending your choice…</p>}
      {submit === 'stalled' && (
        <p className="mt-2 text-xs text-amber-300/90">
          No answer came back. The choice may not have reached the table — the buttons are live
          again, so try once more.
        </p>
      )}
    </DialogShell>
  );
}
