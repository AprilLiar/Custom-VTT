import { useState } from 'react';
import { HelpCircle, X, ArrowLeftRight, Ban, Bomb, Car, Crown, Factory, Flame, FlameKindling, Gem, Grid2x2, Hourglass, Infinity as InfinityIcon, Layers, Link as LinkIcon, Lock, Medal, Repeat, Repeat2, Scale3d, ShieldUser, Snowflake, Triangle, Trophy, Turtle, UserPlus, Wine, Zap } from 'lucide-react';
import { socket } from '../socket.js';
import { FAMILIES, PARAM_BY_KEY, SIDES, SIDE_LABEL, paramsOf } from '../lib/battleParams.js';

// **Fight Setup's Complications and Battle Parameters (decided).** Beside the
// fighters list: small square icons in four groups — Complications, Tilted,
// Arena, Victory — stacked as a vertical list, each group under a horizontal line carrying its name. Hover
// (or a tap, on a phone) shows the name and what it does; a click sets it:
//   Tilted: pick the side it is on (one Tilt per side) · Arena / Complications:
//   on or off · Victory: the one in force.
// The ones the engine doesn't run yet are greyed out, saying so.
const sideTone = { allies: 'bg-sky-500', enemies: 'bg-red-500', renegades: 'bg-amber-500' };

const ICONS = { ArrowLeftRight, Ban, Bomb, Car, Crown, Factory, Flame, FlameKindling, Gem, Grid2x2, Hourglass, Infinity: InfinityIcon, Layers, Link: LinkIcon, Lock, Medal, Repeat, Repeat2, Scale3d, ShieldUser, Snowflake, Triangle, Trophy, Turtle, UserPlus, Wine, Zap };
function Glyph({ name, size = 16 }) {
  const I = ICONS[name] ?? HelpCircle;
  return <I size={size} aria-hidden />;
}

export default function BattleParamsPanel({ mode, battle, fighters = [] }) {
  const [focus, setFocus] = useState(null); // the param shown in the detail box
  const [tiltPick, setTiltPick] = useState(null); // a Tilt whose side is being picked
  const set = (change) => socket.emit('battle:set', { mode, change });
  const sidesWith = (key) => SIDES.filter((s) => battle?.tilts?.[s] === key);
  const isOn = (p) =>
    p.family === 'tilt' ? sidesWith(p.key).length > 0 : p.family === 'arena' ? battle?.arena?.includes(p.key) : p.family === 'victory' ? battle?.victory === p.key : battle?.complications?.includes(p.key);
  const usable = (p) => p.built && (mode === 'combat' || p.lane);

  const click = (p) => {
    setFocus(p.key);
    if (!usable(p)) return;
    if (p.family === 'tilt') setTiltPick((k) => (k === p.key ? null : p.key));
    else if (p.family === 'arena') set({ arena: p.key });
    else if (p.family === 'victory') set({ victory: p.key });
    else set({ complication: p.key });
  };

  const shown = PARAM_BY_KEY[tiltPick ?? focus] ?? null;
  const cuffsOn = SIDES.some((s) => battle?.tilts?.[s] === 'handcuffs');

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {/* A vertical list (play feedback 10): each group under a horizontal line carrying its name. */}
      <div className="flex flex-col gap-2">
        {FAMILIES.map((fam) => (
          <div key={fam.key} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <div className="h-px flex-1 bg-zinc-700" />
              <span className="font-display text-[9px] font-bold uppercase tracking-[0.2em] text-zinc-400">{fam.label}</span>
              <div className="h-px flex-1 bg-zinc-700" />
            </div>
            <div className="flex flex-wrap gap-1">
              {paramsOf(fam.key).map((p) => {
                const on = isOn(p);
                const ok = usable(p);
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => click(p)}
                    onMouseEnter={() => setFocus(p.key)}
                    onFocus={() => setFocus(p.key)}
                    aria-pressed={Boolean(on)}
                    aria-label={`${p.name}${ok ? '' : ' (not automated yet)'}`}
                    title={`${p.name} — ${p.text}${ok ? '' : mode === 'simple' && !p.lane ? ' (map only)' : ' (not automated yet)'}`}
                    className={`relative flex h-9 w-9 items-center justify-center panel-cut-sm border ${
                      on
                        ? 'border-purple-400 bg-purple-500/30 text-purple-100'
                        : ok
                          ? 'border-zinc-700 bg-zinc-800 text-zinc-300 hover:border-purple-400 hover:text-white'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-600'
                    }`}
                  >
                    <Glyph name={p.icon} />
                    {/* A Tilt shows the sides it is on. */}
                    {p.family === 'tilt' && on && (
                      <span className="absolute -bottom-1 left-1/2 flex -translate-x-1/2 gap-0.5">
                        {sidesWith(p.key).map((s) => (
                          <span key={s} className={`h-1.5 w-1.5 rounded-full ${sideTone[s]}`} />
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* What the hovered / tapped one does. */}
      {shown && (
        <div className="panel-cut-sm border border-zinc-800 bg-zinc-950/80 p-2 text-xs">
          <p className="mb-0.5 flex items-center gap-1.5 font-display font-bold uppercase tracking-wide text-zinc-100">
            <Glyph name={shown.icon} size={13} /> {shown.name}
            {!usable(shown) && <span className="font-sans text-[10px] font-normal normal-case text-zinc-500">{mode === 'simple' && !shown.lane ? 'map only' : 'not automated yet'}</span>}
          </p>
          <p className="text-zinc-400">{shown.text}</p>
          {shown.family === 'victory' && battle?.victory === shown.key && <VictoryOptions victory={shown.key} opts={battle?.victoryOpts ?? {}} fighters={fighters} set={set} />}
          {/* A Tilt: which side it is on (one Tilt per side). */}
          {tiltPick === shown.key && (
            <div className="mt-2 flex flex-wrap gap-1">
              {SIDES.map((s) => {
                const here = battle?.tilts?.[s] === shown.key;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => set({ tilt: { side: s, key: here ? null : shown.key } })}
                    aria-pressed={here}
                    className={`min-h-8 panel-cut-sm border px-2 font-display text-[11px] font-bold uppercase ${here ? 'border-purple-400 bg-purple-500/30 text-purple-100' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`}
                  >
                    {here ? '✓ ' : ''}
                    {SIDE_LABEL[s]}
                    {battle?.tilts?.[s] && !here ? ` (has ${PARAM_BY_KEY[battle.tilts[s]].name})` : ''}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Handcuffs: the GM pairs them (decided). */}
      {cuffsOn && <CuffPairs mode={mode} cuffs={battle?.cuffs ?? []} fighters={fighters} set={set} />}
    </div>
  );
}

function CuffPairs({ cuffs, fighters, set }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const nameOf = (id) => fighters.find((f) => f.combatantId === id)?.name ?? `#${id}`;
  const pickable = fighters.filter((f) => f.combatantId != null);
  return (
    <div className="panel-cut-sm border border-zinc-800 bg-zinc-950/80 p-2 text-xs">
      <p className="mb-1 font-display font-bold uppercase tracking-wide text-zinc-200">Handcuffs</p>
      <ul className="mb-1.5 space-y-1">
        {cuffs.map(([x, y]) => (
          <li key={`${x}-${y}`} className="flex items-center gap-2 text-zinc-300">
            <span className="min-w-0 flex-1 truncate">
              {nameOf(x)} ⛓ {nameOf(y)}
            </span>
            <button type="button" onClick={() => set({ uncuff: x })} aria-label={`Uncuff ${nameOf(x)}`} className="text-zinc-500 hover:text-red-300">
              <X size={13} aria-hidden />
            </button>
          </li>
        ))}
        {!cuffs.length && <li className="italic text-zinc-500">Nobody is cuffed yet.</li>}
      </ul>
      <div className="flex items-center gap-1">
        {[
          [a, setA],
          [b, setB],
        ].map(([v, setV], i) => (
          <select
            key={i}
            value={v}
            onChange={(e) => setV(e.target.value)}
            aria-label={i ? 'Second fighter' : 'First fighter'}
            className="h-8 min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1 outline-none focus:border-brand-500"
          >
            <option value="">—</option>
            {pickable.map((f) => (
              <option key={f.combatantId} value={f.combatantId}>
                {f.name}
              </option>
            ))}
          </select>
        ))}
        <button
          type="button"
          disabled={!a || !b || a === b}
          onClick={() => {
            set({ cuff: [Number(a), Number(b)] });
            setA('');
            setB('');
          }}
          className="h-8 panel-cut-sm border border-purple-400 bg-purple-500/20 px-2 font-display text-[11px] font-bold uppercase text-purple-100 disabled:opacity-40"
        >
          Cuff
        </button>
      </div>
    </div>
  );
}

// The chosen Victory Parameter's own choices (Fight Setup).
const chip = (on) =>
  `min-h-8 panel-cut-sm border px-2 font-display text-[11px] font-bold uppercase ${on ? 'border-purple-400 bg-purple-500/30 text-purple-100' : 'border-zinc-700 bg-zinc-900 text-zinc-300'}`;
function VictoryOptions({ victory, opts, fighters, set }) {
  const two = ['allies', 'enemies'];
  if (victory === 'outlast' || victory === 'sabotage') {
    const key = victory === 'outlast' ? 'survivors' : 'saboteurs';
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-zinc-500">{victory === 'outlast' ? 'Survivors:' : 'Saboteurs:'}</span>
        {two.map((s) => (
          <button key={s} type="button" aria-pressed={opts[key] === s} onClick={() => set({ victoryOpts: { [key]: s } })} className={chip(opts[key] === s)}>
            {SIDE_LABEL[s]}
          </button>
        ))}
      </div>
    );
  }
  if (victory === 'tournament') {
    return (
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-1 text-zinc-500">Best of</span>
        {[3, 5].map((n) => (
          <button key={n} type="button" aria-pressed={opts.bestOf === n} onClick={() => set({ victoryOpts: { bestOf: n } })} className={chip(opts.bestOf === n)}>
            {n}
          </button>
        ))}
      </div>
    );
  }
  if (victory === 'protect_the_vip') {
    const pickable = fighters.filter((f) => f.combatantId != null);
    return (
      <div className="mt-2 space-y-1">
        {two.map((s) => (
          <label key={s} className="flex items-center gap-2">
            <span className="w-16 text-zinc-500">{SIDE_LABEL[s]} VIP</span>
            <select
              value={opts.vips?.[s] ?? ''}
              onChange={(e) => set({ victoryOpts: { vip: { side: s, id: e.target.value === '' ? null : Number(e.target.value) } } })}
              className="h-8 min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1 outline-none focus:border-brand-500"
            >
              <option value="">—</option>
              {pickable.map((f) => (
                <option key={f.combatantId} value={f.combatantId}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        ))}
        <p className="text-[10px] text-zinc-500">Set before Start Combat: the VIPs get +10 max HP on their first bar then.</p>
      </div>
    );
  }
  return null;
}
