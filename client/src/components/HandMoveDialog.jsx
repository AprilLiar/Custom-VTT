import { useState } from 'react';
import { createPortal } from 'react-dom';
import { socket } from '../socket.js';

// **A hand move (decided):** dragging a fighter who holds Speed asks "Do you
// need to spend Speed tokens on this move?". "No" just moves them (the GM or
// player is fixing the board); "Yes x/y" spends x — the cheapest Free
// Movement there, a diagonal counting 2 — of the y they hold, and is only
// pressable when y covers x. The server checks it again, then makes it as
// Free Movement itself (play feedback 7: Fatigue stops it 2 spaces short on
// the same path), and the stage update moves the token.
//
// useHandMove() → [start, dialog]: call start({ combatantId, name, speed,
// where, send, revert }) on a drop — `where` is { col, row } (map) or
// { slot } (lane), `send()` makes the move, `revert()` puts the token back.
export function useHandMove() {
  const [ask, setAsk] = useState(null);
  const start = ({ combatantId, name, speed, where, send, revert }) => {
    // Nothing to spend, or not in a fight: just move.
    if (combatantId == null || !(speed > 0)) return send();
    socket.emit('move:hand_cost', { combatantId, ...where }, (r) => {
      if (!r || r.error) return send();
      setAsk({ combatantId, name, where, cost: r.cost, speed: r.speed, fatigue: r.fatigue ?? 0, send, revert });
    });
  };
  const dialog = ask ? <HandMoveDialog ask={ask} close={() => setAsk(null)} /> : null;
  return [start, dialog];
}

function HandMoveDialog({ ask, close }) {
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const { cost, speed } = ask;
  const enough = cost != null && cost <= speed;
  const no = () => {
    ask.send();
    close();
  };
  const yes = () => {
    if (!enough || busy) return;
    setBusy(true);
    socket.emit('move:hand_pay', { combatantId: ask.combatantId, ...ask.where }, (r) => {
      setBusy(false);
      if (r?.ok) {
        // The server made it as Free Movement (Fatigue may stop it short): its stage update moves the token.
        if (!r.moved) ask.send();
        close();
      } else setError(r?.error ?? 'could not pay');
    });
  };
  const cancel = () => {
    ask.revert?.();
    close();
  };
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && cancel()}>
      <div role="dialog" aria-label="Spend Speed on this move" className="panel-cut w-full max-w-sm border border-zinc-700 bg-zinc-950/95 p-4 shadow-2xl">
        <p className="text-[11px] uppercase tracking-wider text-zinc-400">{ask.name}</p>
        <h2 className="mt-1 text-sm font-semibold text-zinc-100">Do you need to spend Speed tokens on this move?</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={no} className="min-h-10 panel-cut-sm border border-zinc-600 bg-zinc-900 px-3 text-sm text-zinc-100 hover:border-lime-400">
            No
          </button>
          <button
            type="button"
            onClick={yes}
            disabled={!enough || busy}
            title={cost == null ? 'No way there with Free Movement' : enough ? `Spend ${cost} of your ${speed} Speed` : `Needs ${cost} Speed — you hold ${speed}`}
            className="min-h-10 panel-cut-sm border border-sky-500 bg-sky-900/60 px-3 text-sm font-semibold text-sky-50 hover:bg-sky-800 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-500"
          >
            Yes · {cost == null ? '—' : cost}/{speed}
          </button>
        </div>
        {ask.fatigue > 0 && (
          <p className="mt-2 text-xs text-orange-300">Fatigued: spending Speed discards 1 Fatigue and stops 2 spaces short on the way (only the spaces moved are paid).</p>
        )}
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <button type="button" onClick={cancel} className="mt-3 w-full text-center text-xs text-zinc-400 hover:text-zinc-200">
          Cancel the move
        </button>
      </div>
    </div>,
    document.body
  );
}
