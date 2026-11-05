import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { socket } from '../../socket.js';
import { getBuild } from '../../lib/api.js';
import { useContent } from '../../lib/patd/useContent.js';
import { deriveBuild, stanceOfBuild } from '../../lib/patd/build.js';
import { gateFor, turnActions } from '../../lib/patd/diceBoard.js';
import { affordableOptions, hasDiceCost, optionLabel, paymentText, planPayment, tokenOptions } from '../../lib/patd/tokenCost.js';
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
//   - **Tap an Action with a token cost** (no die selected): your tokens, HP,
//     Shield or Challenge are checked; if there is enough it is paid for real
//     and the Action lights up (with the Gates the payment reaches). One way to
//     pay → paid at once; several → a dialog with only the ways you can afford.
//     Tap it again to undo the payment in full. A Free Action just lights up.
//
// Laying dice is purely visual — nothing is resolved. The marks are shared and
// kept for the turn (server/diceMarks.js): reopening shows the same, and the
// chat card shows the crossed dice to everyone. No header (decided): the
// footer holds the dice and the close button, to leave the screen to the cards.

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
      className={`relative flex flex-col items-center justify-center panel-cut-sm border ${big ? 'h-11 w-10' : 'min-w-11 px-1.5 py-1'} ${tone} ${
        crossed ? 'opacity-40 grayscale' : ''
      } ${selected ? 'ring-2 ring-lime-300 ring-offset-2 ring-offset-zinc-950' : ''}`}
    >
      <span className={`font-mono text-zinc-400 ${big ? 'text-[8px] leading-tight' : 'text-[10px]'}`}>{r.bonus ? (big ? `+d${r.die}` : `bonus d${r.die}`) : r.die !== undefined ? `d${r.die}` : 'fixed'}</span>
      <span className={`font-mono font-black leading-none text-white ${big ? 'text-xl' : 'text-xl'} ${crossed ? 'line-through' : ''}`}>{r.result}</span>
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
  const [fighter, setFighter] = useState(null); // payable state (tokens, HP, Shield, Challenge holders)
  const [paying, setPaying] = useState(null); // { action, options } — the payment dialog
  const [toast, setToast] = useState(null);
  const say = (text) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 2600);
  };

  // The fighter's live state, for token costs; refreshed whenever the table changes.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/fighter-state/${payload.combatant_id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((st) => alive && setFighter(st))
        .catch(() => {});
    load();
    socket.on('stage:updated', load);
    socket.on('dice:marks', load);
    const onFailed = ({ rollId, error }) => rollId === payload.roll_id && say(`Couldn't pay: ${error}.`);
    socket.on('dice:pay_failed', onFailed);
    return () => {
      alive = false;
      socket.off('stage:updated', load);
      socket.off('dice:marks', load);
      socket.off('dice:pay_failed', onFailed);
    };
  }, [payload.combatant_id, payload.roll_id]);

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
  const pay = marks.pay ?? {};
  const tapAction = (actionId) => {
    if (!editable) return;
    const action = idx?.get(actionId);
    if (!action) return;
    if (selected != null) {
      if (hasDiceCost(action)) return layOn(selected, actionId);
      return say(`${action.name} is paid with ${optionLabel(tokenOptions(action)[0]?.option ?? { components: [] })}, not dice.`);
    }
    if (pay[actionId]) return socket.emit('dice:unpay', { rollId: payload.roll_id, actionId });
    if (!tokenOptions(action).length) return;
    if (!fighter) return say('Reading your tokens…');
    const options = affordableOptions(action, fighter);
    if (!options.length) return say(`Not enough for ${action.name}: needs ${tokenOptions(action).map((o) => optionLabel(o.option)).join(' or ')}.`);
    // One way to pay, nothing to decide: paid at once.
    if (options.length === 1 && !options[0].choices.length) return socket.emit('dice:pay', { rollId: payload.roll_id, actionId, option: options[0].index, answers: {} });
    setPaying({ action, options });
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
    const action = idx.get(id);
    const p = pay[id];
    const paidGate = p ? gateFor(action, p.rating) : null;
    const lit = on.length || p ? [...on.map((x) => x.threshold), ...(p ? [paidGate] : [])].filter((t) => t != null) : null;
    const tappable = editable && (selected != null || tokenOptions(action).length > 0);
    return (
      <div key={id} onClick={() => tapAction(id)} className={tappable ? 'cursor-pointer' : ''}>
        <ActionCard action={action} compact dropTarget lit={lit} dice={on.map((x) => x.value)} paid={p?.text ?? null} paidAmount={p ? p.amount : null} />
      </div>
    );
  };

  return createPortal(
    <div className="fixed inset-0 flex flex-col bg-zinc-950/[0.97]" style={{ zIndex: 3000 }} role="dialog" aria-modal="true" aria-label="This turn's Actions">

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

      <footer className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 px-2 pt-1.5" style={{ paddingBottom: 'max(0.4rem, var(--safe-bottom))' }}>
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap justify-center gap-1.5">
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
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-zinc-200 hover:border-zinc-400">
            <X size={16} aria-hidden />
          </button>
        </div>
        <p className="mt-1 truncate text-center text-[9px] text-zinc-500">
          {toast ??
            (!editable
              ? marks.active
                ? `${payload.stance} · view only`
                : `${payload.stance} · this turn is over — view only`
              : selected != null
                ? 'Now tap an Action to lay this die on it — or tap the die again to bring it back.'
                : `${payload.stance} · drag or tap a die onto an Action · tap a token-cost Action to pay it`)}
        </p>
      </footer>

      {paying && (
        <PayDialog
          {...paying}
          fighter={fighter}
          onPay={(option, answers) => {
            socket.emit('dice:pay', { rollId: payload.roll_id, actionId: paying.action.id, option, answers });
            setPaying(null);
          }}
          onClose={() => setPaying(null)}
        />
      )}
      {drag && (
        <div className="pointer-events-none fixed" style={{ left: drag.x - 28, top: drag.y - 32, zIndex: 3001 }}>
          <DieFace r={results[drag.i]} big />
        </div>
      )}
    </div>,
    document.body
  );
}

// **Choosing how to pay (decided).** Full screen, and only what applies: the
// cost options this fighter can afford (none they can't), and for the one
// picked, just its own questions — which Basic tokens, how much HP, or whose
// Challenge — with nothing else on the screen.
function PayDialog({ action, options, fighter, onPay, onClose }) {
  const [pick, setPick] = useState(options.length === 1 ? options[0].index : null);
  const chosen = options.find((o) => o.index === pick) ?? null;
  const [split, setSplit] = useState({});
  const [hp, setHp] = useState(null);
  const [holderId, setHolderId] = useState(null);
  const hpChoice = chosen?.choices.find((c) => c.kind === 'hp');
  // When the split is asked, it must be given (an empty split pays nothing and is refused).
  const needsSplit = chosen?.choices.some((c) => c.kind === 'split');
  const answers = { split: needsSplit ? split : undefined, hp: hp ?? hpChoice?.minimum, holderId: holderId ?? undefined };
  const plan = chosen && fighter ? planPayment(action, chosen.index, answers, fighter) : null;
  const ready = plan && !plan.error;
  const tokenLabel = (k) => k.charAt(0).toUpperCase() + k.slice(1);
  const step = 'flex h-9 w-9 items-center justify-center rounded-full border border-zinc-600 text-lg text-zinc-100 disabled:opacity-30';
  return (
    <div className="fixed inset-0 flex flex-col bg-zinc-950" style={{ zIndex: 3002 }} role="dialog" aria-modal="true" aria-label={`Pay for ${action.name}`}>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-md space-y-4">
          <h2 className="font-display text-lg font-bold uppercase tracking-wide text-zinc-100">Pay for {action.name}</h2>
          {options.length > 1 && (
            <div className="space-y-1.5">
              {options.map((o) => (
                <button
                  key={o.index}
                  type="button"
                  onClick={() => {
                    setPick(o.index);
                    setSplit({});
                    setHp(null);
                    setHolderId(null);
                  }}
                  className={`flex min-h-12 w-full items-center gap-2 panel-cut-sm border px-3 text-left text-sm font-semibold ${
                    pick === o.index ? 'border-lime-400 bg-lime-500/15 text-white' : 'border-zinc-700 bg-zinc-900 text-zinc-200'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          )}
          {chosen?.choices.map((c, i) => {
            if (c.kind === 'split') {
              const total = Object.values(split).reduce((a, b) => a + b, 0);
              return (
                <div key={i} className="space-y-2">
                  <p className="text-sm text-zinc-300">
                    Which Basic tokens? <span className={total === c.amount ? 'text-lime-300' : 'text-zinc-500'}>{total} / {c.amount}</span>
                  </p>
                  {c.keys.map((k) => {
                    const n = split[k] ?? 0;
                    const held = fighter.tokens[k] ?? 0;
                    return (
                      <div key={k} className="flex items-center gap-3">
                        <span className="w-20 text-sm text-zinc-100">{tokenLabel(k)}</span>
                        <button type="button" className={step} disabled={n <= 0} onClick={() => setSplit({ ...split, [k]: n - 1 })} aria-label={`One less ${k}`}>
                          −
                        </button>
                        <span className="w-6 text-center font-mono text-lg text-white">{n}</span>
                        <button type="button" className={step} disabled={n >= held || total >= c.amount} onClick={() => setSplit({ ...split, [k]: n + 1 })} aria-label={`One more ${k}`}>
                          +
                        </button>
                        <span className="text-[11px] text-zinc-500">of {held}</span>
                      </div>
                    );
                  })}
                </div>
              );
            }
            if (c.kind === 'hp') {
              const v = hp ?? c.minimum;
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-sm text-zinc-300">HP to pay</span>
                  <button type="button" className={step} disabled={v <= c.minimum} onClick={() => setHp(v - 1)} aria-label="Less HP">
                    −
                  </button>
                  <span className="w-6 text-center font-mono text-lg text-white">{v}</span>
                  <button type="button" className={step} disabled={v >= c.maximum} onClick={() => setHp(v + 1)} aria-label="More HP">
                    +
                  </button>
                  <span className="text-[11px] text-zinc-500">
                    {c.minimum}–{c.maximum}
                  </span>
                </div>
              );
            }
            return (
              <div key={i} className="space-y-1.5">
                <p className="text-sm text-zinc-300">Take your Challenge back from…</p>
                {c.holders.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => setHolderId(h.id)}
                    className={`flex min-h-11 w-full items-center panel-cut-sm border px-3 text-sm ${holderId === h.id ? 'border-lime-400 bg-lime-500/15 text-white' : 'border-zinc-700 bg-zinc-900 text-zinc-200'}`}
                  >
                    {h.name}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-zinc-800 p-3" style={{ paddingBottom: 'max(0.75rem, var(--safe-bottom))' }}>
        <button type="button" onClick={onClose} className="min-h-11 flex-1 panel-cut-sm border border-zinc-700 text-sm text-zinc-200">
          Cancel
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => onPay(chosen.index, answers)}
          className="min-h-11 flex-[2] panel-cut-sm bg-lime-500 text-sm font-bold uppercase text-zinc-950 disabled:opacity-40"
        >
          {ready ? `Pay ${paymentText(plan)}` : 'Pay'}
        </button>
      </div>
    </div>
  );
}
