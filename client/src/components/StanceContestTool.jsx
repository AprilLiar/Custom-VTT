import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { socket } from '../socket.js';
import { useStage } from '../lib/useStage.js';
import { CONTESTS, MEASURES, normalizeCustom } from '../lib/contests.js';
import { BASIC_TOKENS } from '../lib/panicTokens.js';

// **Stance Contests — the GM's setup (GM Tools, decided).** Two sides, any
// number on each (a side counts its best), picked from who is in the current
// view: the figures on the Scene or Simple Combat, the tokens on Combat. Then
// one of the book's twelve contests, or a custom one (what is measured, higher
// or lower wins, the arena) — custom ones are not saved. Start opens the
// contest window for everyone (ContestWindow.jsx); the contest itself runs on
// the server (server/contests.js).
const IDENTITY = { role: 'gm' };
const sideTone = { a: 'border-sky-400 bg-sky-500/25 text-sky-100', b: 'border-red-400 bg-red-500/25 text-red-100' };
const chip = (on, tone = 'border-purple-400 bg-purple-500/30 text-purple-100') =>
  `min-h-8 panel-cut-sm border px-2 font-display text-[11px] font-bold uppercase ${on ? tone : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'}`;
const field = 'h-9 w-full panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 outline-none focus:border-brand-500';

export default function StanceContestTool({ onDone }) {
  const location = useLocation();
  const stage = useStage(IDENTITY);
  const scene = stage?.activeScene ?? null;
  const mode = scene?.combat_mode ?? 'scene';
  // Who is in the current view, one entry per character.
  const people = useMemo(() => {
    if (!stage) return [];
    const list = mode === 'combat' ? stage.combatTokens.map((t) => ({ id: t.character_id, name: t.name })) : stage.summons.filter((s) => s.character_id != null).map((s) => ({ id: s.character_id, name: s.name }));
    const seen = new Set();
    return list.filter((p) => p.id != null && !seen.has(p.id) && seen.add(p.id));
  }, [stage, mode]);
  const [sides, setSides] = useState({}); // characterId → 'a' | 'b'
  const [key, setKey] = useState('sumo');
  const [custom, setCustom] = useState({ name: '', measure: 'tokens', token: 'iron', better: 'high', setup: { dummies: 1, dummyHp: '', respawn: false, hits: '' }, text: '' });
  const [running, setRunning] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const onState = (s) => setRunning(s?.status === 'running' ? s : null);
    const onError = (e) => setError(e?.error ?? 'Could not start');
    fetch('/api/contest')
      .then((r) => r.json())
      .then(onState)
      .catch(() => {});
    socket.on('contest:state', onState);
    socket.on('contest:error', onError);
    return () => {
      socket.off('contest:state', onState);
      socket.off('contest:error', onError);
    };
  }, []);

  if (location.pathname !== '/scene' || !scene) return <p className="text-sm text-zinc-400">Open the Scene page with a Scene active: the contestants are picked from who is on it.</p>;
  if (running) {
    return (
      <div className="flex flex-col gap-3 text-sm text-zinc-300">
        <p>
          <span className="font-display font-bold uppercase text-zinc-100">{running.def.name}</span> is running — {running.arenas.filter((a) => a.done).length} of {running.arenas.length} done.
        </p>
        <button type="button" onClick={() => socket.emit('contest:cancel')} className="min-h-11 panel-cut-sm border border-red-400 bg-red-600/30 font-display text-xs font-bold uppercase text-red-50 hover:bg-red-600/50">
          Call it off
        </button>
      </div>
    );
  }

  const ids = (s) => Object.entries(sides).filter(([, v]) => v === s).map(([k]) => Number(k));
  const toggle = (id, s) => setSides((m) => ({ ...m, [id]: m[id] === s ? undefined : s }));
  const measure = MEASURES.find((m) => m.key === custom.measure);
  const setSetup = (patch) => setCustom((c) => ({ ...c, setup: { ...c.setup, ...patch } }));
  const def =
    key === 'custom'
      ? normalizeCustom({ ...custom, setup: { ...custom.setup, hits: String(custom.setup.hits).split(/[ ,]+/).filter(Boolean) } })
      : CONTESTS.find((c) => c.key === key);
  const ready = ids('a').length > 0 && ids('b').length > 0;
  const start = () => {
    setError(null);
    socket.emit('contest:start', { def: key === 'custom' ? { ...def } : { key }, sides: { a: ids('a'), b: ids('b') } });
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-4 text-sm text-zinc-300">
      <section>
        <h3 className="mb-1 font-display text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-400">Contestants</h3>
        {!people.length && <p className="text-xs italic text-zinc-500">Nobody is in this view. Put figures on the Scene (or tokens on the map) first.</p>}
        <ul className="space-y-1">
          {people.map((p) => (
            <li key={p.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-zinc-100">{p.name}</span>
              {['a', 'b'].map((s) => (
                <button key={s} type="button" aria-pressed={sides[p.id] === s} onClick={() => toggle(p.id, s)} className={chip(sides[p.id] === s, sideTone[s])}>
                  Side {s.toUpperCase()}
                </button>
              ))}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[11px] text-zinc-500">Any number on each side; a side counts its best. Everyone starts fresh: full HP, no tokens. Nothing carries over.</p>
      </section>

      <section>
        <h3 className="mb-1 font-display text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-400">Contest</h3>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {[...CONTESTS, { key: 'custom', name: 'Custom…' }].map((c) => (
            <button key={c.key} type="button" aria-pressed={key === c.key} onClick={() => setKey(c.key)} className={`${chip(key === c.key)} text-left`} title={c.text}>
              {c.name}
            </button>
          ))}
        </div>
        {key !== 'custom' && def && (
          <div className="mt-2 panel-cut-sm border border-zinc-800 bg-zinc-950/80 p-2 text-xs">
            <p className="text-zinc-300">{def.text}</p>
            <p className="mt-1 italic text-zinc-500">{def.examples}</p>
          </div>
        )}
        {key === 'custom' && (
          <div className="mt-2 grid gap-2 panel-cut-sm border border-zinc-800 bg-zinc-950/80 p-2 text-xs sm:grid-cols-2">
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-zinc-500">Name</span>
              <input className={field} value={custom.name} maxLength={60} onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))} placeholder="Custom contest" />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-zinc-500">What is measured</span>
              <select className={field} value={custom.measure} onChange={(e) => setCustom((c) => ({ ...c, measure: e.target.value }))}>
                {MEASURES.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {measure?.needsToken && (
              <label className="flex flex-col gap-1">
                <span className="text-zinc-500">Token</span>
                <select className={field} value={custom.token} onChange={(e) => setCustom((c) => ({ ...c, token: e.target.value }))}>
                  {BASIC_TOKENS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex flex-col gap-1">
              <span className="text-zinc-500">Who wins</span>
              <div className="flex gap-1">
                {[
                  ['high', 'Higher'],
                  ['low', 'Lower'],
                ].map(([v, l]) => (
                  <button key={v} type="button" aria-pressed={custom.better === v} onClick={() => setCustom((c) => ({ ...c, better: v }))} className={chip(custom.better === v)}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Targets in each arena</span>
              <input className={field} type="number" min={measure?.needsDummy ? 1 : 0} max={5} value={custom.setup.dummies} onChange={(e) => setSetup({ dummies: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Target HP (empty = infinite)</span>
              <input className={field} type="number" min={1} max={99} value={custom.setup.dummyHp} onChange={(e) => setSetup({ dummyHp: e.target.value })} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={custom.setup.respawn} onChange={(e) => setSetup({ respawn: e.target.checked })} />
              <span>A felled target is replaced at once</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-zinc-500">Hits taken at the turn’s end (e.g. 5, 5, 5)</span>
              <input className={field} value={custom.setup.hits} onChange={(e) => setSetup({ hits: e.target.value })} placeholder="none" />
            </label>
            <label className="flex flex-col gap-1 sm:col-span-2">
              <span className="text-zinc-500">What it is (shown to everyone)</span>
              <textarea className={`${field} h-16 py-1`} maxLength={400} value={custom.text} onChange={(e) => setCustom((c) => ({ ...c, text: e.target.value }))} />
            </label>
            <p className="text-[11px] text-zinc-500 sm:col-span-2">Custom contests are not saved.</p>
          </div>
        )}
      </section>

      {error && <p className="text-xs text-red-300">{error}</p>}
      <button
        type="button"
        disabled={!ready}
        onClick={start}
        className="min-h-11 panel-cut-sm border border-brand-500 bg-brand-600 font-display text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-500 disabled:opacity-40"
      >
        {ready ? `Start: ${def?.name ?? 'contest'}` : 'Pick someone for each side'}
      </button>
    </div>
  );
}
