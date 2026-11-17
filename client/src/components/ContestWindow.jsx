import { useEffect, useMemo, useState } from 'react';
import { Minimize2, Maximize2, Trophy, X } from 'lucide-react';
import { socket } from '../socket.js';
import { useRole } from '../roleContext.jsx';
import { useControl } from '../lib/useControl.js';
import { useDiceMarks } from '../lib/diceMarks.js';
import { livePool } from '../lib/patd/diceBoard.js';
import { pickAt } from '../lib/squarePick.js';
import { useSkillsEnabled } from '../lib/skillsSetting.js';
import { BASIC_TOKENS, TOKEN_BY_KEY } from '../lib/panicTokens.js';
import { SKILL_BONUSES } from '../lib/contests.js';
import { TokenIcon } from '../lib/panicIcons.jsx';
import { ActionButton, StancePrompt } from './FightControls.jsx';
import SquarePickLayer from './SquarePickLayer.jsx';
import PickViewLayer from './PickViewLayer.jsx';
import DialogShell from './DialogShell.jsx';

// **The Stance Contest window (decided: everyone watches live).** While a
// contest runs (`contest:state`, server/contests.js) every screen shows each
// contestant's own mini-arena side by side: their fighter and targets on a
// small grid, HP, tokens, what they've done so far. Whoever controls a
// contestant (or the GM) plays from their panel: Skill bonuses first (Skills
// on), the Stance pick, then Action / End Turn exactly as in a fight — board
// picks land on that arena's grid. When every arena is done the result shows
// for a while, then the window closes itself. Minimised to a pill on request.
const Z = 1150; // over the Scene page and the GM drawer (1100); under the dice board (3000) and prompt bars (3100)
const sideTone = { a: { ring: 'border-sky-500', text: 'text-sky-200', fill: '#38bdf8', name: 'Side A' }, b: { ring: 'border-red-500', text: 'text-red-200', fill: '#f87171', name: 'Side B' } };

export function useContest() {
  const [state, setState] = useState(null);
  useEffect(() => {
    const load = () =>
      fetch('/api/contest')
        .then((r) => r.json())
        .then(setState)
        .catch(() => {});
    load();
    socket.on('contest:state', setState);
    socket.on('connect', load);
    return () => {
      socket.off('contest:state', setState);
      socket.off('connect', load);
    };
  }, []);
  return state;
}

export default function ContestWindow() {
  const state = useContest();
  const { role } = useRole();
  const { controls } = useControl();
  const [small, setSmall] = useState(false);
  const [dismissed, setDismissed] = useState(null);
  useEffect(() => {
    if (state?.status === 'running') setDismissed(null);
  }, [state?.id, state?.status]);
  if (!state || dismissed === state.id) return null;
  const done = state.status === 'done';
  if (small) {
    return (
      <button
        type="button"
        onClick={() => setSmall(false)}
        className="fixed left-1/2 top-2 flex -translate-x-1/2 items-center gap-2 panel-cut-sm border border-purple-400 bg-zinc-950/95 px-3 py-2 font-display text-xs font-bold uppercase tracking-wide text-purple-100 shadow-2xl"
        style={{ zIndex: Z }}
      >
        <Maximize2 size={14} aria-hidden /> {state.def.name}: {done ? 'result' : `${state.arenas.filter((a) => a.done).length}/${state.arenas.length} done`}
      </button>
    );
  }
  return (
    <div className="fixed inset-0 flex flex-col bg-zinc-950 text-zinc-100" style={{ zIndex: Z }} role="dialog" aria-label={`Stance Contest: ${state.def.name}`}>
      <header className="flex items-start gap-3 border-b border-zinc-800 px-3 py-2" style={{ paddingTop: 'max(0.5rem, var(--safe-top, 0px))' }}>
        <Trophy size={20} className="mt-0.5 shrink-0 text-purple-300" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base font-bold uppercase tracking-wide">Stance Contest · {state.def.name}</h2>
          <p className="text-xs text-zinc-400">{state.def.text || 'A custom contest.'} {state.def.better === 'low' ? 'Lowest wins.' : ''}</p>
        </div>
        {role === 'gm' && !done && (
          <button type="button" onClick={() => socket.emit('contest:cancel')} className="min-h-9 shrink-0 panel-cut-sm border border-red-500/60 px-2 font-display text-[11px] font-bold uppercase text-red-200 hover:bg-red-600/30">
            Call it off
          </button>
        )}
        <button type="button" onClick={() => (done ? setDismissed(state.id) : setSmall(true))} aria-label={done ? 'Close' : 'Minimise'} className="flex h-9 w-9 shrink-0 items-center justify-center panel-cut-sm border border-zinc-700 text-zinc-300 hover:border-zinc-500">
          {done ? <X size={16} aria-hidden /> : <Minimize2 size={16} aria-hidden />}
        </button>
      </header>
      {done && state.result && <ResultBanner result={state.result} def={state.def} />}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {state.arenas.map((a) => (
            <ArenaPanel key={a.combatantId} contest={state} arena={a} mine={role === 'gm' || controls(a.characterId)} role={role} controls={controls} done={done} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ResultBanner({ result, def }) {
  const sideNames = (s) => result.scores.filter((x) => x.side === s).map((x) => x.name).join(' & ');
  return (
    <div className="border-b border-purple-500/40 bg-purple-950/40 px-3 py-2 text-center">
      <p className="font-display text-lg font-bold uppercase tracking-wide text-purple-100">
        {result.winner ? `${sideNames(result.winner)} win${result.scores.filter((x) => x.side === result.winner).length === 1 ? 's' : ''}` : 'A tie — a fight breaks out!'}
      </p>
      <p className="text-xs text-zinc-400">
        {['a', 'b'].map((s) => `${sideTone[s].name}: best ${result.best?.[s]?.name ?? '—'} (${summary(def, result.scores.find((x) => x.name === result.best?.[s]?.name)?.stats)})`).join(' · ')}
      </p>
    </div>
  );
}

// What a contestant scored, in words.
function summary(def, st) {
  if (!st) return '—';
  const m = def.measure;
  if (m.startsWith('tokens:')) return `${st.tokens?.[m.slice(7)] ?? 0} ${TOKEN_BY_KEY[m.slice(7)]?.name ?? m.slice(7)}`;
  switch (m) {
    case 'dummy_status':
      return `${st.dummyStatus} Status`;
    case 'biggest_hit':
      return `biggest hit ${st.biggestHit?.damage ?? 0}`;
    case 'total_damage':
      return `${st.totalDamage} damage`;
    case 'push_distance':
      return `pushed ${st.pushDistance}`;
    case 'felled':
      return `${st.felled} felled`;
    case 'hp_lost':
      return `${st.hpLost} HP lost`;
    default:
      return `rolled ${(st.pool ?? []).join(', ') || '—'}`;
  }
}

const CELL = 34;
function ArenaPanel({ contest, arena, mine, role, controls, done }) {
  const tone = sideTone[arena.side];
  const me = arena.tokens?.find((t) => t.id === arena.combatantId);
  const fight = arena.fight;
  // The grid shows everyone with two squares to spare (at least 7×7 round the start).
  const view = useMemo(() => {
    const pts = (arena.tokens ?? []).filter((t) => t.col != null).map((t) => [t.col, t.row]);
    const xs = [...pts.map((p) => p[0]), 1, 7];
    const ys = [...pts.map((p) => p[1]), 1, 7];
    return { c0: Math.min(...xs) - 1, r0: Math.min(...ys) - 1, cols: Math.max(...xs) - Math.min(...xs) + 3, rows: Math.max(...ys) - Math.min(...ys) + 3 };
  }, [arena.tokens]);
  const w = view.cols * CELL;
  const h = view.rows * CELL;
  const quadOf = (col, row) => {
    const x = (col - view.c0) * CELL;
    const y = (row - view.r0) * CELL;
    return [
      [x, y],
      [x + CELL, y],
      [x + CELL, y + CELL],
      [x, y + CELL],
    ];
  };
  const status = done ? 'Done' : arena.done ? 'Done — waiting for the others' : arena.ending ? 'Ending the turn…' : !arena.ready ? 'Choosing Skill bonuses' : fight?.pending_stance ? 'Choosing a Stance' : 'Playing';
  return (
    <section className={`flex flex-col gap-2 panel-cut-sm border-2 ${tone.ring} bg-zinc-900/80 p-2`}>
      <div className="flex items-center gap-2">
        <span className={`font-display text-[10px] font-bold uppercase tracking-[0.2em] ${tone.text}`}>{tone.name}</span>
        <h3 className="min-w-0 flex-1 truncate font-display text-sm font-bold uppercase">{arena.name}</h3>
        <span className="text-[11px] text-zinc-400">{status}</span>
      </div>
      {!done && (
        <div className="relative mx-auto overflow-hidden rounded border border-zinc-800 bg-zinc-950" style={{ width: w, height: h, maxWidth: '100%' }}>
          <svg width={w} height={h} className="absolute inset-0" aria-hidden>
            {Array.from({ length: view.cols * view.rows }, (_, i) => (
              <rect key={i} x={(i % view.cols) * CELL} y={Math.floor(i / view.cols) * CELL} width={CELL} height={CELL} fill={(i + Math.floor(i / view.cols)) % 2 ? '#18181b' : '#1f1f23'} stroke="#27272a" />
            ))}
            {Object.entries(arena.starts ?? {}).map(([id, sq]) => (
              <rect key={`s${id}`} x={(sq.col - view.c0) * CELL + 4} y={(sq.row - view.r0) * CELL + 4} width={CELL - 8} height={CELL - 8} fill="none" stroke="#52525b" strokeDasharray="3 3" />
            ))}
          </svg>
          <PickViewLayer mode="combat" sceneId={arena.sceneId} quadOf={quadOf} width={w} height={h} zIndex={3} />
          {(arena.tokens ?? []).map((t) => (
            <ArenaToken key={t.id} t={t} me={t.id === arena.combatantId} tone={tone} x={(t.col - view.c0) * CELL} y={(t.row - view.r0) * CELL} onClick={() => pickAt('combat', t.col, t.row, arena.sceneId)} />
          ))}
          <SquarePickLayer mode="combat" sceneId={arena.sceneId} quadOf={quadOf} width={w} height={h} zIndex={6} />
        </div>
      )}
      {me && !done && <Holdings fight={me.fight} />}
      {!done && <TargetsLine arena={arena} />}
      {(arena.done || done) && arena.stats && <p className="text-xs text-zinc-300">Scored: {summary(contest.def, arena.stats)}</p>}
      {!done && !arena.done && mine && <Controls contest={contest} arena={arena} role={role} controls={controls} />}
    </section>
  );
}

function ArenaToken({ t, me, tone, x, y, onClick }) {
  const hp = t.fight?.hp;
  const pct = hp?.max ? Math.max(0, Math.min(1, hp.current / hp.max)) : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title={t.name}
      className="absolute flex flex-col items-center"
      style={{ left: x + 2, top: y + 2, width: CELL - 4, height: CELL - 4, zIndex: 4, transition: 'left 300ms, top 300ms' }}
    >
      <span
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-2 bg-zinc-700 bg-cover bg-center font-display text-[10px] font-bold uppercase"
        style={{ borderColor: me ? tone.fill : '#a1a1aa', backgroundImage: t.image_url ? `url(${t.image_url})` : undefined }}
      >
        {!t.image_url && t.name.slice(0, 2)}
      </span>
      {!t.fight?.infinite && hp?.max != null && (
        <span className="absolute -bottom-1 left-0 h-1 w-full rounded bg-zinc-800">
          <span className="block h-full rounded bg-emerald-400" style={{ width: `${pct * 100}%` }} />
        </span>
      )}
    </button>
  );
}

function Holdings({ fight }) {
  const tokens = Object.entries(fight?.tokens ?? {}).filter(([, n]) => n > 0);
  const hp = fight?.hp;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {hp?.max != null && (
        <span className="text-zinc-300">
          HP {hp.current}/{hp.max}
          {hp.bars > 1 ? ` · bar ${hp.broken + 1}/${hp.bars}` : ''}
        </span>
      )}
      {tokens.map(([k, n]) => (
        <span key={k} className="flex items-center gap-0.5 text-zinc-200" title={TOKEN_BY_KEY[k]?.name ?? k}>
          <TokenIcon tokenKey={k} className="h-4 w-4" />×{n}
        </span>
      ))}
      {!tokens.length && <span className="italic text-zinc-500">no tokens</span>}
    </div>
  );
}

function TargetsLine({ arena }) {
  const targets = (arena.tokens ?? []).filter((t) => t.id !== arena.combatantId);
  if (!targets.length) return null;
  return (
    <ul className="space-y-0.5 text-[11px] text-zinc-400">
      {targets.map((t) => {
        const status = Object.entries(t.fight?.tokens ?? {}).filter(([, n]) => n > 0);
        return (
          <li key={t.id}>
            <span className="text-zinc-200">{t.name}</span>
            {t.fight?.infinite ? ` · ${t.fight.damage_taken} damage taken` : ` · HP ${t.fight?.hp?.current}/${t.fight?.hp?.max}`}
            {status.length > 0 && ` · ${status.map(([k, n]) => `${n} ${TOKEN_BY_KEY[k]?.name ?? k}`).join(', ')}`}
          </li>
        );
      })}
    </ul>
  );
}

// The contestant's own controls: bonuses, the Stance pick, Action / End Turn, +2.
function Controls({ contest, arena, role, controls }) {
  const fight = arena.fight;
  const [prep, setPrep] = useState(false);
  if (!arena.ready) {
    return (
      <>
        <button type="button" onClick={() => setPrep(true)} className="min-h-11 panel-cut-sm border border-emerald-400 bg-emerald-600/30 font-display text-xs font-bold uppercase text-emerald-50 hover:bg-emerald-600/50">
          Choose Skill bonuses
        </button>
        {prep && <SkillPrep contest={contest} arena={arena} onClose={() => setPrep(false)} />}
      </>
    );
  }
  if (!fight) return null;
  return (
    <div className="flex flex-col gap-2">
      <StancePrompt mode="combat" fight={fight} fighters={(arena.tokens ?? []).map((t) => ({ combatantId: t.id, characterId: t.character_id, name: t.name }))} role={role} controls={controls} fightId={arena.fightId} zIndex={Z + 50} />
      <ActionButton fight={fight} mode="combat" controls={controls} inline fightId={arena.fightId} />
      {arena.plusTwo > 0 && arena.rollId && <PlusTwo contest={contest} arena={arena} />}
    </div>
  );
}

function PlusTwo({ contest, arena }) {
  const board = useDiceMarks(arena.rollId);
  const placed = new Set((board.placements ?? []).flatMap((p) => (p.kind === 'die' ? [p.die] : p.dice ?? [])));
  const numbers = livePool(board).filter((n) => !n.added && !placed.has(n.index));
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-zinc-400">+2 to one number{arena.plusTwo > 1 ? ` (${arena.plusTwo} left)` : ''}:</span>
      {numbers.map((n) => (
        <button
          key={n.index}
          type="button"
          disabled={(board.results ?? [])[n.index]?.plusTwo}
          onClick={() => socket.emit('contest:plus_two', { contestId: contest.id, combatantId: arena.combatantId, index: n.index })}
          className="min-h-8 min-w-8 panel-cut-sm border border-emerald-500 bg-emerald-950/50 px-1.5 font-display font-bold text-emerald-100 disabled:opacity-40"
        >
          {n.value}→{n.value + 2}
        </button>
      ))}
    </div>
  );
}

// **Skill bonuses (book p.87; Skills on).** Each relevant Skill gives one;
// the contestant (or GM) picks as many as they're entitled to.
function SkillPrep({ contest, arena, onClose }) {
  const skillsOn = useSkillsEnabled();
  const [list, setList] = useState([]);
  const add = (key) => setList((l) => [...l, key === 'basic_tokens' ? { key, tokens: ['power', 'iron', 'speed'] } : { key }]);
  const setTok = (i, j, t) => setList((l) => l.map((b, k) => (k === i ? { ...b, tokens: b.tokens.map((x, m) => (m === j ? t : x)) } : b)));
  const go = () => {
    socket.emit('contest:ready', { contestId: contest.id, combatantId: arena.combatantId, bonuses: list });
    onClose();
  };
  return (
    <DialogShell title={`${arena.name}: Skill bonuses`} onClose={onClose} maxWidth="max-w-md" zIndex={Z + 50} dismissible closeButton portal>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-zinc-400">
          {skillsOn === false ? 'Skills are off at this table.' : 'One bonus for each Skill that fits this contest (the GM decides which do). None is fine too.'}
        </p>
        <div className="grid gap-1">
          {SKILL_BONUSES.map((b) => (
            <button key={b.key} type="button" onClick={() => add(b.key)} disabled={list.length >= 6} className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 text-left text-xs text-zinc-100 hover:border-emerald-400">
              + {b.label}
            </button>
          ))}
        </div>
        {list.length > 0 && (
          <ul className="space-y-1">
            {list.map((b, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1 text-xs">
                <span className="text-emerald-200">{SKILL_BONUSES.find((x) => x.key === b.key)?.label}</span>
                {b.key === 'basic_tokens' &&
                  b.tokens.map((t, j) => (
                    <select key={j} value={t} onChange={(e) => setTok(i, j, e.target.value)} className="h-7 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1">
                      {BASIC_TOKENS.map((x) => (
                        <option key={x.key} value={x.key}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  ))}
                <button type="button" onClick={() => setList((l) => l.filter((_, k) => k !== i))} className="ml-auto text-zinc-500 hover:text-red-300" aria-label="Remove">
                  <X size={13} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={go} className="min-h-11 w-full panel-cut-sm bg-brand-600 px-3 font-display text-xs font-bold uppercase text-white hover:bg-brand-500">
          Ready — roll
        </button>
      </div>
    </DialogShell>
  );
}
