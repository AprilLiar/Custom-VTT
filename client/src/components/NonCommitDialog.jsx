import { useState } from 'react';
import DialogShell from './DialogShell.jsx';
import { socket } from '../socket.js';

// **Non-Committed's take-it-back window.**
//
// Raised at the head of a round — after everyone has declared, before anything
// reveals — for the fighter who holds the Perk. Pick any of your own moves to
// Interrupt: the Stamina comes back and the Tics are freed.
//
// `dismissible={false}`, like the other two pause prompts, and for the same
// reason: the pair's whole round is stopped behind this answer, so a dialog
// that could be clicked away would strand the fight with nothing on screen
// saying why. **Keeping everything is a real answer**, and it is the one the
// primary button gives — the Perk is an option, not an obligation, and a
// player who opens this and wants none of it should not have to hunt for the
// way out.
export default function NonCommitDialog({ pairIndex, entries = [], onAnswered }) {
  const [picked, setPicked] = useState(() => new Set());
  const [sent, setSent] = useState(false);

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const answer = (ids) => {
    if (sent) return;
    setSent(true);
    socket.emit('combat:resolve_noncommit', { pairIndex, declaredMoveIds: ids });
    onAnswered?.();
  };

  const all = entries.flatMap((e) => e.moves);
  const refund = all
    .filter((m) => picked.has(m.declaredMoveId))
    .reduce((sum, m) => sum + (m.staminaRefund ?? 0), 0);

  return (
    <DialogShell title="Non-Committed" dismissible={false}>
      <p className="text-sm text-zinc-400">
        Everyone has declared and nothing has revealed yet. Take back any of your own moves — the
        Stamina comes back and the Tics are freed.
      </p>
      {entries.map((entry) => (
        <div key={entry.characterId} className="mt-3 space-y-1">
          {entries.length > 1 && (
            <p className="font-display text-xs uppercase tracking-wide text-zinc-500">
              {entry.characterName}
            </p>
          )}
          {entry.moves.map((move) => {
            const on = picked.has(move.declaredMoveId);
            return (
              <button
                key={move.declaredMoveId}
                type="button"
                onClick={() => toggle(move.declaredMoveId)}
                className={`flex w-full items-center justify-between gap-3 panel-cut-sm border px-3 py-2 text-left text-sm ${
                  on
                    ? 'border-red-600 bg-red-950/40 text-red-200'
                    : 'border-zinc-700 text-zinc-300 hover:border-zinc-500'
                }`}
              >
                <span className={on ? 'line-through decoration-red-400' : ''}>{move.moveName}</span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {move.footprintTics} Tic{move.footprintTics === 1 ? '' : 's'}
                  {move.staminaRefund > 0 && ` · +${move.staminaRefund} ST back`}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {picked.size > 0 && (
          <span className="mr-auto text-xs text-zinc-500">
            {picked.size} of {all.length} taken back
            {refund > 0 && ` · +${refund} Stamina`}
          </span>
        )}
        <button
          type="button"
          disabled={sent}
          onClick={() => answer([])}
          className="panel-cut-sm bg-emerald-700 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-600 disabled:opacity-50"
        >
          Commit to everything
        </button>
        <button
          type="button"
          disabled={sent || picked.size === 0}
          onClick={() => answer([...picked])}
          className="panel-cut-sm border border-red-700 px-3 py-1.5 text-sm font-semibold text-red-200 hover:bg-red-900/40 disabled:opacity-40"
        >
          Interrupt {picked.size || ''}
        </button>
      </div>
    </DialogShell>
  );
}
