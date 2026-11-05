import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { socket } from '../../socket.js';
import { getBuild } from '../../lib/api.js';
import { useContent } from '../../lib/patd/useContent.js';
import { deriveBuild, stanceOfBuild } from '../../lib/patd/build.js';
import { gateFor, turnActions } from '../../lib/patd/diceBoard.js';
import { setLocalMarks, useDiceMarks } from '../../lib/diceMarks.js';
import { ActionCard, SuperMoveCard } from './ActionCards.jsx';

// **The turn's dice board (decided — vttprojectplan.md, "Action cards and the
// dice board").** Opened by tapping the dice of your turn's Stance roll. A
// full-screen, scrollable list of the Actions this turn can use — Basic on the
// left, Personal on the right — and this roll's dice along the bottom.
//
//   - **Drag a die onto an Action**, or **tap a die, then tap an Action**: the
//     die is crossed out, and the Action and the Gate its number reaches light
//     up in mild green.
//   - **Tap a die** with no Action to follow: it is just crossed out (greyed,
//     still visible). Tap it again to bring it back. Tapping a die laid on an
//     Action takes it off (and selects it, to lay elsewhere).
//
// Purely visual — nothing is paid or resolved. The marks are shared and kept
// for the turn (server/diceMarks.js): reopening shows the same, and the chat
// card shows the crossed dice to everyone.

const DRAG_START_PX = 6;

export function DieFace({ r, crossed = false, selected = false, big = false }) {
  const tone = r.bonus
    ? 'border-amber-500/80 bg-amber-950/60'
    : r.color === 'purple'
      ? 'border-purple-500/80 bg-purple-950/60'
      : r.color === 'green'
        ? 'border-emerald-500/80 bg-emerald-950/60'
        : 'border-zinc-500 bg-zinc-900';
  return (
    <span
      className={`relative flex flex-col items-center justify-center panel-cut-sm border ${big ? 'h-16 w-14' : 'min-w-11 px-1.5 py-1'} ${tone} ${
        crossed ? 'opacity-40 grayscale' : ''
      } ${selected ? 'ring-2 ring-lime-300 ring-offset-2 ring-offset-zinc-950' : ''}`}
    >
      <span className="font-mono text-[10px] text-zinc-400">{r.bonus ? `bonus d${r.die}` : r.die !== undefined ? `d${r.die}` : 'fixed'}</span>
      <span className={`font-mono font-black leading-none text-white ${big ? 'text-3xl' : 'text-xl'} ${crossed ? 'line-through' : ''}`}>{r.result}</span>
      {crossed && (
        <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="h-0.5 w-[120%] rotate-[-35deg] bg-red-400" />
        </span>
      )}
    </span>
  );
}

export default function DiceBoard({ payload, onClose, canEdit }) {
  const idx = useContent();
  const [build, setBuild] = useState(undefined);
  const marks = useDiceMarks(payload.roll_id);
  const editable = canEdit && marks.active;
  const [selected, setSelected] = useState(null);
  const [drag, setDrag] = useState(null); // { i, x, y }
  const pointer = useRef(null);
  const results = payload.results ?? [];

  useEffect(() => {
    let alive = true;
    getBuild(payload.character_id)
      .then(({ build: b }) => alive && setBuild(b ?? null))
      .catch(() => alive && setBuild(null));
    return () => {
      alive = false;
    };
  }, [payload.character_id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const lists = useMemo(() => {
    if (!idx || !build) return null;
    const d = deriveBuild(build, idx);
    return turnActions(d, stanceOfBuild(d, payload.stance_key, idx), idx);
  }, [idx, build, payload.stance_key]);

  const commit = (next) => {
    setLocalMarks(payload.roll_id, { ...next, active: true });
    socket.emit('dice:mark', { rollId: payload.roll_id, ...next });
  };
  const used = new Set(marks.used);
  const assign = marks.assign ?? {};

  const layOn = (i, actionId) => {
    const action = idx?.get(actionId);
    if (!action) return;
    const nextAssign = { ...assign, [i]: { actionId, threshold: gateFor(action, results[i]?.result) } };
    commit({ used: [...new Set([...marks.used, i])], assign: nextAssign });
    setSelected(null);
  };
  const tapDie = (i) => {
    if (!editable) return;
    if (assign[i]) {
      // Off its Action, still crossed and selected: tap an Action to lay it elsewhere.
      const { [i]: _drop, ...rest } = assign;
      commit({ used: marks.used, assign: rest });
      setSelected(i);
    } else if (used.has(i)) {
      if (selected === i) {
        commit({ used: marks.used.filter((x) => x !== i), assign });
        setSelected(null);
      } else setSelected(i);
    } else {
      commit({ used: [...marks.used, i], assign });
      setSelected(i);
    }
  };
  const tapAction = (actionId) => {
    if (editable && selected != null) layOn(selected, actionId);
  };

  // Pointer drag (works with touch, a pen and a mouse alike).
  const onDown = (i) => (e) => {
    if (!editable) return;
    pointer.current = { i, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    const p = pointer.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_START_PX) return;
    p.moved = true;
    setDrag({ i: p.i, x: e.clientX, y: e.clientY });
  };
  const onUp = (e) => {
    const p = pointer.current;
    pointer.current = null;
    setDrag(null);
    if (!p) return;
    if (!p.moved) return tapDie(p.i);
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-action-id]');
    if (target) layOn(p.i, target.getAttribute('data-action-id'));
  };

  const diceOn = (actionId) =>
    Object.entries(assign)
      .filter(([, a]) => a.actionId === actionId)
      .map(([i, a]) => ({ value: results[i]?.result, threshold: a.threshold }));
  const card = (id) => {
    const on = diceOn(id);
    return (
      <div key={id} onClick={() => tapAction(id)} className={selected != null && editable ? 'cursor-pointer' : ''}>
        <ActionCard
          action={idx.get(id)}
          compact
          dropTarget
          lit={on.length ? on.map((x) => x.threshold).filter((t) => t != null) : null}
          dice={on.map((x) => x.value)}
        />
      </div>
    );
  };

  return createPortal(
    <div className="fixed inset-0 flex flex-col bg-zinc-950/[0.97]" style={{ zIndex: 3000 }} role="dialog" aria-modal="true" aria-label="This turn's Actions">
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-3 py-2" style={{ paddingTop: 'max(0.5rem, var(--safe-top))' }}>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-bold uppercase tracking-wide text-zinc-100">{payload.stance}</p>
          <p className="truncate text-[11px] text-zinc-500">
            {payload.fighter?.name} · {editable ? 'drag a die onto an Action, or tap a die and then an Action' : marks.active ? 'view only' : 'this turn is over — view only'}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-zinc-200 hover:border-zinc-400">
          <X size={20} aria-hidden />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        {!lists ? (
          <p className="p-4 text-sm text-zinc-500">{build === null ? 'No build for this character.' : 'Loading the Actions…'}</p>
        ) : (
          <div className="grid grid-cols-2 divide-x divide-zinc-700">
            <section className="space-y-1.5 p-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-wide text-emerald-300">Basic</h3>
              {lists.basic.map(card)}
            </section>
            <section className="space-y-1.5 p-2">
              <h3 className="font-display text-[11px] font-bold uppercase tracking-wide text-emerald-300">Personal</h3>
              {lists.personal.map((g) => (
                <div key={g.title} className="space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">{g.title}</p>
                  {g.ids.map(card)}
                </div>
              ))}
              {lists.supers.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Super Moves</p>
                  {lists.supers.map((id) => (
                    <SuperMoveCard key={id} move={idx.get(id)} compact />
                  ))}
                </div>
              )}
              {lists.personal.length === 0 && lists.supers.length === 0 && <p className="text-xs italic text-zinc-600">No Personal Actions.</p>}
            </section>
          </div>
        )}
      </main>

      <footer className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-3 pt-2" style={{ paddingBottom: 'max(0.75rem, var(--safe-bottom))' }}>
        <div className="flex flex-wrap justify-center gap-2.5">
          {results.map((r, i) => (
            <button
              key={i}
              type="button"
              onPointerDown={onDown(i)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => {
                pointer.current = null;
                setDrag(null);
              }}
              disabled={!editable}
              aria-pressed={used.has(i)}
              aria-label={`Die ${i + 1}: ${r.result}${used.has(i) ? ', crossed out' : ''}${assign[i] ? `, on ${idx?.get(assign[i].actionId)?.name ?? 'an Action'}` : ''}`}
              className="touch-none select-none disabled:cursor-default"
            >
              <DieFace r={r} big crossed={used.has(i)} selected={selected === i} />
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-zinc-500">
          {selected != null && editable ? 'Now tap an Action to lay this die on it — or tap the die again to bring it back.' : 'Purely visual: nothing is paid or resolved.'}
        </p>
      </footer>

      {drag && (
        <div className="pointer-events-none fixed" style={{ left: drag.x - 28, top: drag.y - 32, zIndex: 3001 }}>
          <DieFace r={results[drag.i]} big />
        </div>
      )}
    </div>,
    document.body
  );
}
