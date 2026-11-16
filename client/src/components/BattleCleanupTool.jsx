import { useState } from 'react';
import { socket } from '../socket.js';

// **Battle Cleanup (GM Tools, decided):** one press, asked first, on the
// active Scene in both fight modes: every obstacle and Copy is removed (the
// markers — Danger, King, Control, Important — stay), every fighter loses all
// tokens and any Challenge, and HP is back to full. Server: `fight:cleanup`.
export default function BattleCleanupTool({ onDone }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-col gap-3 text-sm text-zinc-300">
      <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-400">
        <li>Removes every obstacle and Copy from the board (markers stay).</li>
        <li>Clears every token and Challenge from every fighter.</li>
        <li>Resets everyone&rsquo;s HP to full: all bars whole, no Dizzy.</li>
      </ul>
      <p className="text-xs text-zinc-500">On the active Scene, in Simple Combat and Combat alike. A running fight keeps going.</p>
      {confirming ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              socket.emit('fight:cleanup');
              onDone?.();
            }}
            className="min-h-11 flex-1 panel-cut-sm border border-red-400 bg-red-600/40 font-display text-xs font-bold uppercase tracking-wide text-red-50 hover:bg-red-600/60"
          >
            Yes, clean up
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="min-h-11 flex-1 panel-cut-sm border border-zinc-600 bg-zinc-900 font-display text-xs font-bold uppercase tracking-wide text-zinc-200">
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="min-h-11 panel-cut-sm border border-brand-500 bg-brand-600 font-display text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-500"
        >
          Clean up the battle
        </button>
      )}
    </div>
  );
}
