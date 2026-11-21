import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Zap } from 'lucide-react';
import { socket } from '../../socket.js';
import { useContent } from '../../lib/patd/useContent.js';
import { poolOf } from '../../lib/patd/diceBoard.js';
import { ActionCard } from './ActionCards.jsx';

// **After a real Interrupt (decided).** Someone interrupted this turn while
// its queue of Actions was resolving; now that the Interrupt is over, the
// interrupted player sees what is still queued — each Action as its card,
// with the number laid on it and the Gate it reaches — and keeps all, some or
// none. Those given up come off the board: their dice fully back, nothing done
// (server: diceMarks.js `board:resume`).
export default function InterruptReview({ board, rollId, name }) {
  const idx = useContent();
  const queued = useMemo(() => (board.placements ?? []).filter((p) => !p.committed), [board.placements]);
  const [keep, setKeep] = useState(() => new Set(queued.map((p) => p.key)));
  const pool = useMemo(() => poolOf({ results: board.results ?? [], extra: board.extra ?? [] }), [board.results, board.extra]);
  const valueOf = (p) =>
    p.kind === 'super' ? (p.dice ?? []).map((i) => pool.find((n) => n.index === i)?.value).join(' + ') : p.kind === 'die' ? String(pool.find((n) => n.index === p.die)?.value ?? '?') : (p.text ?? 'token cost');
  const toggle = (key) =>
    setKeep((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const send = (keys) => socket.emit('board:resume', { rollId, keep: [...keys] });
  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center bg-black/70 p-3" style={{ zIndex: 3100 }} role="dialog" aria-modal="true" aria-label="After the Interrupt">
      <div className="panel-cut flex max-h-[92dvh] w-full max-w-xl flex-col border border-amber-500/60 bg-zinc-950 shadow-2xl">
        <header className="border-b border-zinc-800 px-4 py-3">
          <h2 className="flex items-center gap-1.5 font-display text-lg font-bold uppercase tracking-wide text-amber-300">
            <Zap size={18} aria-hidden /> You were interrupted
          </h2>
          <p className="mt-0.5 text-xs text-zinc-400">
            {name ? `${name}'s` : 'Your'} queue is waiting. Keep the Actions that should still happen — the ones you give up return their dice and do nothing.
          </p>
        </header>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="interrupt-review">
          {queued.map((p, i) => {
            const action = idx?.get(p.actionId);
            const on = keep.has(p.key);
            return (
              <li key={p.key}>
                <label className={`flex cursor-pointer items-start gap-2 rounded-sm border p-2 transition ${on ? 'border-lime-500/70 bg-lime-500/10' : 'border-zinc-800 bg-zinc-900/60 opacity-60'}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(p.key)} className="mt-1 h-4 w-4 accent-lime-500" aria-label={`Keep ${action?.name ?? 'this Action'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="mb-1 text-[11px] text-zinc-400">
                      #{i + 1} · <b className="text-zinc-200">{action?.name ?? p.actionId}</b> · paid with <b className="font-mono text-zinc-200">{valueOf(p)}</b>
                      {(p.stop ?? p.threshold) ? ` · Gate ${p.stop ?? p.threshold}` : ''}
                    </p>
                    {action && <ActionCard action={action} compact lit={[p.stop ?? p.threshold ?? 0]} />}
                  </div>
                </label>
              </li>
            );
          })}
          {!queued.length && <li className="text-sm italic text-zinc-500">Nothing was left in the queue.</li>}
        </ul>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 px-3 py-2.5">
          <button type="button" onClick={() => send([])} className="min-h-10 panel-cut-sm border border-zinc-600 px-3 text-xs font-bold uppercase tracking-wide text-zinc-200 hover:border-red-400">
            Give up all
          </button>
          <button type="button" onClick={() => send(queued.map((p) => p.key))} className="min-h-10 panel-cut-sm border border-zinc-600 px-3 text-xs font-bold uppercase tracking-wide text-zinc-200 hover:border-lime-400">
            Keep all
          </button>
          <button type="button" onClick={() => send(keep)} className="min-h-10 panel-cut-sm bg-lime-600 px-4 text-xs font-bold uppercase tracking-wide text-zinc-950 hover:bg-lime-500">
            Continue with {keep.size} of {queued.length}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  );
}
