import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Footprints, Play, X, Zap } from 'lucide-react';
import { socket } from '../../socket.js';
import { getBuild } from '../../lib/api.js';
import { useRole } from '../../roleContext.jsx';
import { useContent } from '../../lib/patd/useContent.js';
import { deriveBuild, stanceOfBuild } from '../../lib/patd/build.js';
import { minusReserved, poolOf, reservedBy, stopChoices, turnActions } from '../../lib/patd/diceBoard.js';
import { affordableOptions, hasDiceCost, optionLabel, paymentText, planPayment, tokenOptions } from '../../lib/patd/tokenCost.js';
import { useDiceMarks } from '../../lib/diceMarks.js';
import { useSquarePick } from '../../lib/squarePick.js';
import { startFreeMove } from '../../lib/freeMove.js';
import { ActionCard, SuperMoveCard } from './ActionCards.jsx';

// **The turn's dice board (full automation, phase B — vttprojectplan.md, "Full
// automation").** Opened by tapping the dice of your turn's Stance roll: the
// Actions this turn can use — Basic on the left, Personal on the right — and
// the Action Pool along the bottom.
//
//   - **Place** a die on an Action: drag it there, or tap the die, then the
//     Action. The die turns grey and gets its **order number** (top-right).
//     Tap a placed die to take it back. A lower lit Gate on the card can be
//     tapped to stop there (decided); the default is the highest.
//   - **Tap a token-cost Action** (no die selected) to place its payment —
//     checked against your tokens now, paid at Commit. Tap it again to take
//     it back. A dialog asks only what that cost needs (which Basic tokens …).
//   - **Commit** performs every placed Action in placement order (the engine:
//     server/engine/actions.js). Committed dice are crossed out and locked;
//     only the GM can retrieve one (undoing it and every later Action).
//   - **Power** (left): the balance, and a toggle to Enhance the hits of the
//     placed Actions (phase C applies it).
//   - **End turn** ends your turn (decided: the active player ends it).
// No header (decided): the footer holds the pool and the buttons.

const DRAG_START_PX = 6;

// One pool number: a rolled die, a fixed number, or a number added by an
// Ability. `state`: 'free' | 'placed' (grey, with its order) | 'committed'
// (grey, crossed out, locked).
export function DieFace({ r, crossed = false, selected = false, big = false, state = null, order = null }) {
  const placed = state === 'placed' || state === 'committed';
  const isCrossed = crossed || state === 'committed';
  const tone = r.bonus
    ? 'border-amber-500/80 bg-amber-950/60'
    : r.color === 'purple'
      ? 'border-purple-500/80 bg-purple-950/60'
      : r.color === 'green'
        ? 'border-emerald-500/80 bg-emerald-950/60'
        : r.added
          ? 'border-sky-500/80 bg-sky-950/60'
          : 'border-zinc-500 bg-zinc-900';
  const value = r.result ?? r.value;
  const label = r.added ? '+pool' : r.bonus ? (big ? `+d${r.die}` : `bonus d${r.die}`) : r.die !== undefined ? `d${r.die}` : 'fixed';
  // The face (greyed when placed) and the order badge beside it: the badge sits
  // outside the face so the cut corner doesn't clip it and it stays bright.
  return (
    <span className="relative inline-flex">
      <span
        className={`relative flex flex-col items-center justify-center panel-cut-sm border ${big ? 'h-11 w-10' : 'min-w-11 px-1.5 py-1'} ${tone} ${
          placed || crossed ? 'opacity-45 grayscale' : ''
        } ${selected ? 'ring-2 ring-lime-300 ring-offset-2 ring-offset-zinc-950' : ''}`}
      >
        <span className={`font-mono text-zinc-400 ${big ? 'text-[8px] leading-tight' : 'text-[10px]'}`}>{label}</span>
        <span className={`font-mono font-black leading-none text-white ${big ? 'text-xl' : 'text-xl'} ${isCrossed ? 'line-through' : ''}`}>{value}</span>
        {isCrossed && (
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="h-0.5 w-[120%] rotate-[-35deg] bg-red-400" />
          </span>
        )}
      </span>
      {order != null && (
        <span className="absolute -right-2 -top-2 z-10 flex h-4 min-w-4 items-center justify-center rounded-full bg-lime-300 px-0.5 font-mono text-[9px] font-black text-zinc-950 shadow">
          {order}
        </span>
      )}
    </span>
  );
}

export default function DiceBoard({ payload, onClose, canEdit }) {
  const idx = useContent();
  const { role } = useRole();
  const isGm = role === 'gm';
  const [build, setBuild] = useState(undefined);
  const board = useDiceMarks(payload.roll_id);
  // A square being picked on the map or lane (phase D): the board steps aside.
  const picking = useSquarePick();
  const editable = canEdit && board.active;
  const [selected, setSelected] = useState(null);
  const [drag, setDrag] = useState(null); // { i, x, y }
  const pointer = useRef(null);
  const [fighter, setFighter] = useState(null); // payable state (tokens, HP, Shield, Challenge holders)
  const [paying, setPaying] = useState(null); // { action, options } — the payment dialog
  const [toast, setToast] = useState(null);
  const say = (text) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 2600);
  };
  const emit = (ev, extra = {}) => socket.emit(ev, { rollId: payload.roll_id, ...extra });

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
    const onFailed = ({ rollId, error }) => rollId === payload.roll_id && say(`Can't: ${error}.`);
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

  // The pool: the roll's results (from the board, or the card for an old roll) and added numbers.
  const pool = useMemo(() => poolOf({ results: board.results?.length ? board.results : payload.results ?? [], extra: board.extra ?? [] }), [board.results, board.extra, payload.results]);
  const placements = board.placements ?? [];
  const orderOf = (key) => placements.findIndex((p) => p.key === key) + 1 || null;
  const dieState = (i) => {
    const p = placements.find((x) => x.kind === 'die' && x.die === i);
    return p ? { state: p.committed ? 'committed' : 'placed', order: orderOf(p.key), placement: p } : { state: 'free', order: null, placement: null };
  };
  const busy = board.committing;
  const pending = placements.filter((p) => !p.committed);

  // Tokens still free after what uncommitted token placements promise.
  const free = useMemo(() => {
    if (!fighter || !idx) return fighter;
    return minusReserved(fighter, reservedBy(placements, (p) => planPayment(idx.get(p.actionId), p.option, p.answers ?? {}, fighter)));
  }, [fighter, idx, placements]);

  const place = (i, actionId) => {
    const action = idx?.get(actionId);
    if (!action) return;
    if (!hasDiceCost(action)) return say(`${action.name} is paid with ${optionLabel(tokenOptions(action)[0]?.option ?? { components: [] })}, not dice.`);
    emit('board:place', { die: i, actionId });
    setSelected(null);
  };
  const tapDie = (i) => {
    const st = dieState(i);
    if (st.state === 'committed') {
      // Only the GM can retrieve (decided): undoes that Action and every later one.
      if (isGm && !busy && window.confirm(`Retrieve this die? Its Action and every Action committed after it are undone.`)) emit('board:retrieve', { key: st.placement.key });
      return;
    }
    if (!editable || busy) return;
    if (st.state === 'placed') {
      emit('board:unplace', { key: st.placement.key });
      setSelected(i);
      return;
    }
    setSelected((s) => (s === i ? null : i));
  };
  const tapAction = (actionId) => {
    if (!editable || busy) return;
    const action = idx?.get(actionId);
    if (!action) return;
    if (selected != null) return place(selected, actionId);
    const mine = placements.filter((p) => p.kind === 'token' && p.actionId === actionId && !p.committed);
    if (mine.length) return emit('board:unplace', { key: mine[mine.length - 1].key });
    if (!tokenOptions(action).length) return;
    if (!free) return say('Reading your tokens…');
    const options = affordableOptions(action, free);
    if (!options.length) return say(`Not enough for ${action.name}: needs ${tokenOptions(action).map((o) => optionLabel(o.option)).join(' or ')}.`);
    if (options.length === 1 && !options[0].choices.length) return emit('board:place', { actionId, option: options[0].index, answers: {} });
    setPaying({ action, options });
  };
  const tapGate = (actionId, threshold) => {
    if (!editable || busy) return;
    const p = placements.find((x) => x.actionId === actionId && !x.committed && stopChoices(idx.get(actionId), x.threshold).includes(threshold));
    if (p) emit('board:stop', { key: p.key, stop: threshold === (p.stop ?? p.threshold) ? null : threshold });
  };

  // Pointer drag (works with touch, a pen and a mouse alike).
  const onDown = (i) => (e) => {
    if (dieState(i).state !== 'free' || !editable || busy) return;
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
  const onUp = (i) => (e) => {
    const p = pointer.current;
    pointer.current = null;
    setDrag(null);
    if (!p || !p.moved) return tapDie(i);
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-action-id]');
    if (target) place(p.i, target.getAttribute('data-action-id'));
  };

  const card = (id) => {
    const action = idx.get(id);
    const on = placements.filter((p) => p.actionId === id);
    const lit = on.length ? on.map((p) => p.stop ?? p.threshold ?? 0) : null;
    const dice = on.filter((p) => p.kind === 'die').map((p) => pool.find((n) => n.index === p.die)?.value);
    const paid = on.filter((p) => p.kind === 'token').map((p) => `#${orderOf(p.key)} ${p.text ?? ''}${p.committed ? ' ✓' : ''}`);
    const tappable = editable && !busy && (selected != null || tokenOptions(action).length > 0);
    return (
      <div key={id} onClick={() => tapAction(id)} className={tappable ? 'cursor-pointer' : ''}>
        <ActionCard
          action={action}
          compact
          dropTarget
          lit={lit}
          dice={dice}
          paid={paid.length ? paid.join(' · ') : null}
          onGateTap={on.some((p) => !p.committed) ? (t) => tapGate(id, t) : null}
          committed={on.length > 0 && on.every((p) => p.committed)}
        />
      </div>
    );
  };

  const power = fighter?.tokens?.power ?? 0;
  const btn = 'flex h-9 shrink-0 items-center gap-1 rounded-full border px-3 font-display text-[11px] font-bold uppercase tracking-wide disabled:opacity-40';
  if (picking) return null;
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
          {/* Power (decided): the balance, and Enhance for the placed Actions' hits. */}
          <button
            type="button"
            onClick={() => editable && emit('board:power', { on: !board.power })}
            disabled={!editable}
            aria-pressed={board.power}
            title={board.power ? 'Power on: placed Actions Enhance their hits while Power lasts' : 'Power off'}
            className={`${btn} ${board.power ? 'border-red-400 bg-red-500/25 text-red-100' : 'border-zinc-700 text-zinc-300'}`}
          >
            <Zap size={13} aria-hidden /> {power}
          </button>
          <div className="flex min-w-0 flex-1 flex-wrap justify-center gap-1.5">
            {pool.map((n) => {
              const st = dieState(n.index);
              return (
                <button
                  key={n.index}
                  type="button"
                  onPointerDown={onDown(n.index)}
                  onPointerMove={onMove}
                  onPointerUp={onUp(n.index)}
                  onPointerCancel={() => {
                    pointer.current = null;
                    setDrag(null);
                  }}
                  aria-pressed={st.state !== 'free'}
                  aria-label={`Pool number ${n.value}${st.state === 'placed' ? `, placed #${st.order}` : st.state === 'committed' ? ', committed' : ''}`}
                  className="touch-none select-none"
                >
                  <DieFace r={n} big state={st.state} order={st.order} selected={selected === n.index} />
                </button>
              );
            })}
          </div>
          {board.paused ? (
            <button type="button" onClick={() => emit('board:commit')} disabled={!editable} className={`${btn} border-sky-400 bg-sky-500/25 text-sky-100`}>
              <Play size={13} aria-hidden /> Continue
            </button>
          ) : (
            <button type="button" onClick={() => emit('board:commit')} disabled={!editable || busy || !pending.length} className={`${btn} border-lime-400 bg-lime-500/20 text-lime-100`}>
              <Check size={13} aria-hidden /> {busy ? 'Performing…' : `Commit${pending.length ? ` ${pending.length}` : ''}`}
            </button>
          )}
          {/* Free Movement before an Action (phase D): the board steps aside. */}
          <button
            type="button"
            onClick={() => startFreeMove({ combatantId: payload.combatant_id, name: payload.fighter?.name ?? 'Free Movement', onError: say })}
            disabled={!editable || busy}
            className={`${btn} border-sky-500 text-sky-100`}
          >
            <Footprints size={13} aria-hidden /> Move
          </button>
          <button
            type="button"
            onClick={() => (!pending.length || window.confirm('End your turn? Placed Actions that are not committed are dropped.')) && emit('board:end_turn')}
            disabled={!editable || busy}
            className={`${btn} border-zinc-600 text-zinc-200`}
          >
            End turn
          </button>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-zinc-200 hover:border-zinc-400">
            <X size={16} aria-hidden />
          </button>
        </div>
        <p className="mt-1 truncate text-center text-[9px] text-zinc-500">
          {toast ??
            (!board.active
              ? `${payload.stance} · this turn is over — view only`
              : !editable
                ? `${payload.stance} · view only`
                : board.paused
                  ? 'Paused for reactions — Continue when everyone had their chance.'
                  : selected != null
                    ? 'Now tap an Action to place this die on it — or tap the die again.'
                    : `${payload.stance} · place dice or token costs on Actions, then Commit`)}
        </p>
      </footer>

      {paying && (
        <PayDialog
          {...paying}
          fighter={free}
          onPay={(option, answers) => {
            emit('board:place', { actionId: paying.action.id, option, answers });
            setPaying(null);
          }}
          onClose={() => setPaying(null)}
        />
      )}
      {drag && (
        <div className="pointer-events-none fixed" style={{ left: drag.x - 28, top: drag.y - 32, zIndex: 3001 }}>
          <DieFace r={pool.find((n) => n.index === drag.i)} big />
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
