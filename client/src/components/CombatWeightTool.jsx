import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { X, Undo2 } from 'lucide-react';
import { socket } from '../socket.js';
import { useStage } from '../lib/useStage.js';
import { useRoster } from '../lib/useRoster.js';
import BattleParamsPanel from './BattleParamsPanel.jsx';
import { groupStooges } from '../lib/stooges.js';
import { WEIGHTS, WEIGHT_BY_KEY, barHp, bonusDie, bonusHp } from '../lib/cinematicWeight.js';

// **GM Tools → Fight Setup** (decided; was Preset Narrative Combat Weight). Works only on the
// Scene page while the active Scene is in Simple Combat or Combat; it applies
// to THAT mode's fight.
//
// Pick one of the five weight classes (book p.38-40), give each fighter a
// level (1-10) and a level table — Hero (Focused/Fused/Frantic) or Warrior —
// and Apply: every fighter gets ONE full Health Bar of the weight's HP plus
// their level's bonus (on every bar, as the book says), the bars' Bleed zone
// is marked, and the Heal button heals by the weight's Heal Value. From level 2
// the turn-start roll also adds the level's Bonus Die.

const IDENTITY = { role: 'gm' };
const LEVELS = Array.from({ length: 10 }, (_, i) => i + 1);

export default function CombatWeightTool({ onDone }) {
  const location = useLocation();
  const stage = useStage(IDENTITY);
  const roster = useRoster();
  const scene = stage?.activeScene ?? null;
  const mode = scene?.combat_mode === 'simple' || scene?.combat_mode === 'combat' ? scene.combat_mode : null;
  const usable = location.pathname === '/scene' && mode;

  const typeOf = useMemo(() => new Map((roster ?? []).map((c) => [c.id, c.character_type])), [roster]);
  const fighters = useMemo(() => {
    if (!stage || !mode) return [];
    // **From the sheet (decided, builder phase 2):** a character with a build
    // brings its level, HP table (hero types: Hero, NPC types: Warrior) and
    // Health Bars; otherwise the token's own, or PC → Hero / NPC → Warrior.
    const setupOf = (characterId) => stage.fighterSetup?.[`character:${characterId}`] ?? null;
    const kindFor = (characterId) => setupOf(characterId)?.kind ?? (characterId != null && typeOf.get(characterId) === 'pc' ? 'hero' : 'warrior');
    const levelFor = (characterId, own) => setupOf(characterId)?.level ?? own ?? 1;
    const barsFor = (characterId) => setupOf(characterId)?.health_bars ?? 1;
    const list = mode === 'combat'
      ? stage.combatTokens.map((t) => ({
          key: `c${t.id}`,
          ref: { combatantId: t.id },
          name: t.name,
          level: levelFor(t.character_id, t.fight.level),
          kind: setupOf(t.character_id)?.kind ?? t.fight.kind ?? kindFor(t.character_id),
          bars: barsFor(t.character_id),
          infinite: Boolean(t.fight.infinite),
          combatantId: t.id,
          characterId: t.character_id,
          excluded: Boolean(t.fight.excluded),
          unit: t.fight.stooge_unit ?? null,
          out: Boolean(t.fight.stooge_out),
        }))
      : stage.summons.filter((s) => s.character_id != null).map((s) => ({
          key: `s${s.id}`,
          ref: { summonId: s.id },
          name: s.name,
          level: levelFor(s.character_id, s.fight?.level),
          kind: setupOf(s.character_id)?.kind ?? s.fight?.kind ?? kindFor(s.character_id),
          bars: barsFor(s.character_id),
          infinite: Boolean(s.fight?.infinite),
          combatantId: s.fight?.combatant_id ?? null,
          characterId: s.character_id,
          excluded: Boolean(s.fight?.excluded),
          unit: s.fight?.stooge_unit ?? null,
          out: Boolean(s.fight?.stooge_out),
        }));
    // A Stooges unit is one row (they share one bar, one level, everything).
    return groupStooges(list);
  }, [stage, mode, typeOf]);

  const [weight, setWeight] = useState(null);
  const [rows, setRows] = useState({}); // key → { level, kind, bars }
  // Uneven Fights: the heroes' Health Bars in all, and how they split them.
  const [heroBars, setHeroBars] = useState(null);
  const [split, setSplit] = useState('even');
  useEffect(() => {
    if (weight == null && scene) setWeight(scene.weights?.[mode] ?? 'middle');
  }, [scene, mode, weight]);
  useEffect(() => {
    setRows((prev) => {
      const next = { ...prev };
      for (const f of fighters) if (!next[f.key]) next[f.key] = { level: f.level, kind: f.kind };
      return next;
    });
  }, [fighters]);

  if (!stage) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (!usable) {
    return (
      <p className="text-sm text-zinc-400">
        This tool works on the Scene page while the active Scene is in <b>Simple Combat</b> or <b>Combat</b> — it sets
        the weight of that fight. Switch the Scene to one of those first.
      </p>
    );
  }

  const set = (key, patch) => setRows((r) => ({ ...r, [key]: { ...r[key], ...patch } }));
  // Before anything below reads it (the Uneven Fights maths does).
  const w = WEIGHT_BY_KEY[weight];
  // **Complications (Fight Setup):** Guest Heroes (one bar, any hero player
  // controls them) and Uneven Fights (bars per fighter; the heroes' extra
  // bars split evenly as HP, or handed out whole).
  const battle = scene?.battle?.[mode];
  const guestsOn = battle?.complications?.includes('guest_heroes');
  const uneven = battle?.complications?.includes('uneven_fights');
  const isGuest = (f) => guestsOn && (battle?.guests ?? []).includes(f.characterId);
  const heroes = fighters.filter((f) => !f.excluded && !isGuest(f) && (rows[f.key]?.kind ?? f.kind) === 'hero');
  const spare = Math.max(0, (heroBars ?? heroes.length) - heroes.length);
  const avgBar = heroes.length ? heroes.reduce((n, f) => n + (w ? barHp(weight, 'hero', rows[f.key]?.level ?? 1) : 0), 0) / heroes.length : 0;
  const evenExtra = uneven && split === 'even' && heroes.length ? Math.ceil((spare * avgBar) / heroes.length) : 0;
  const barsOf = (f) => (isGuest(f) ? 1 : uneven && split === 'uneven' ? (rows[f.key]?.bars ?? f.bars ?? 1) : uneven && split === 'even' && heroes.includes(f) ? 1 : (rows[f.key]?.bars ?? f.bars ?? 1));
  const setAllLevels = (level) => setRows((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, level }])));

  const apply = () => {
    socket.emit('fight:preset_weight', {
      mode,
      weight,
      // A figure left out (×) gets no HP: it stays scenery.
      fighters: fighters
        .filter((f) => !f.excluded)
        .map((f) => ({ ref: f.ref, level: rows[f.key]?.level ?? 1, kind: rows[f.key]?.kind ?? 'hero', bars: barsOf(f), extra: heroes.includes(f) ? evenExtra : 0 })),
    });
    onDone?.();
  };

  return (
    <div className="flex flex-col gap-4 md:flex-row">
    <div className="min-w-0 flex-1 space-y-3">
      <p className="text-xs text-zinc-500">
        For this Scene&rsquo;s <b className="text-zinc-300">{mode === 'simple' ? 'Simple Combat' : 'Combat'}</b> fight. Applying resets everyone listed
        to full Health Bars — one each, or as many as their build says (a Boss). Levels and HP tables come from their builds.
      </p>
      <div className="grid gap-1.5">
        {WEIGHTS.map((opt) => (
          <label
            key={opt.key}
            className={`flex cursor-pointer items-start gap-2 panel-cut-sm border px-2 py-1.5 ${
              weight === opt.key ? 'border-purple-500 bg-purple-950/40' : 'border-zinc-800 bg-zinc-900'
            }`}
          >
            <input type="radio" name="weight" checked={weight === opt.key} onChange={() => setWeight(opt.key)} className="mt-1 accent-purple-500" />
            <span className="min-w-0">
              <span className="block font-display text-sm font-semibold text-zinc-100">
                {opt.name}{' '}
                <span className="font-sans text-[11px] font-normal text-zinc-400">
                  {opt.hp} HP · Heal {opt.heal} · Bleed {opt.bleed} · {opt.supers ? `${opt.supers} Super/round` : 'no Supers'}
                </span>
              </span>
              <span className="block text-[11px] text-zinc-500">{opt.blurb}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <h4 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-300">Fighters</h4>
        <label className="flex items-center gap-1 text-[11px] text-zinc-400">
          All at level
          <select
            defaultValue=""
            onChange={(e) => e.target.value && setAllLevels(Number(e.target.value))}
            className="h-8 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1 text-xs outline-none focus:border-brand-500"
          >
            <option value="">—</option>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      {uneven && (
        <div className="flex flex-wrap items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-950/70 px-2 py-1.5 text-[11px] text-zinc-300">
          <span className="font-display font-bold uppercase tracking-wide text-zinc-200">Uneven Fights</span>
          <label className="flex items-center gap-1">
            Heroes&rsquo; bars
            <input
              type="number"
              min={heroes.length}
              max={30}
              value={heroBars ?? heroes.length}
              onChange={(e) => setHeroBars(Math.max(0, Math.trunc(Number(e.target.value)) || 0))}
              className="h-7 w-14 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1 outline-none focus:border-brand-500"
            />
          </label>
          {['even', 'uneven'].map((k) => (
            <button key={k} type="button" aria-pressed={split === k} onClick={() => setSplit(k)} className={`h-7 panel-cut-sm border px-2 capitalize ${split === k ? 'border-purple-400 bg-purple-500/30 text-purple-100' : 'border-zinc-700 bg-zinc-900'}`}>
              {k}
            </button>
          ))}
          <span className="text-zinc-500">
            {split === 'even'
              ? `Each hero +${evenExtra} HP on their bar (${spare} spare bar${spare === 1 ? '' : 's'}).`
              : 'Set each fighter’s bars below (a Boss up to 6). A 1v1: 2 bars each.'}
          </span>
        </div>
      )}
      {fighters.length === 0 && <p className="text-xs italic text-zinc-500">Nobody is in this fight yet.</p>}
      <ul className="space-y-1">
        {fighters.map((f) => {
          const row = rows[f.key] ?? { level: 1, kind: 'hero' };
          const die = bonusDie(row.level);
          // **Left out (×, decided):** only scenery — no HP, never in a fight.
          if (f.excluded) {
            return (
              <li key={f.key} className="flex items-center gap-2 panel-cut-sm border border-dashed border-zinc-800 bg-zinc-950 px-2 py-1 opacity-60">
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-400 line-through">{f.name}</span>
                <span className="text-[11px] text-zinc-500">Left out of the fight</span>
                <button
                  type="button"
                  onClick={() => f.bodies.forEach((ref) => socket.emit('fighter:exclude', { ref, on: false }))}
                  title="Bring back into the fight"
                  aria-label={`Bring ${f.name} back into the fight`}
                  className="flex h-8 w-8 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-zinc-100"
                >
                  <Undo2 size={14} aria-hidden />
                </button>
              </li>
            );
          }
          return (
            <li key={f.key} className="flex flex-wrap items-center gap-2 panel-cut-sm border border-zinc-800 bg-zinc-900 px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{f.name}</span>
              <span className="flex overflow-hidden panel-cut-sm border border-zinc-700 text-[11px]">
                {['hero', 'warrior'].map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => set(f.key, { kind: k })}
                    className={`px-2 py-1 capitalize ${row.kind === k ? 'bg-brand-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-100'}`}
                  >
                    {k}
                  </button>
                ))}
              </span>
              <select
                value={row.level}
                onChange={(e) => set(f.key, { level: Number(e.target.value) })}
                aria-label={`${f.name} level`}
                className="h-8 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1 text-xs outline-none focus:border-brand-500"
              >
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    Lv {l}
                  </option>
                ))}
              </select>
              {uneven && split === 'uneven' && !isGuest(f) && (
                <label className="flex items-center gap-1 text-[11px] text-zinc-400">
                  Bars
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={rows[f.key]?.bars ?? f.bars ?? 1}
                    onChange={(e) => set(f.key, { bars: Math.min(6, Math.max(1, Math.trunc(Number(e.target.value)) || 1)) })}
                    aria-label={`${f.name} Health Bars`}
                    className="h-8 w-12 panel-cut-sm border border-zinc-700 bg-zinc-800 px-1 text-xs outline-none focus:border-brand-500"
                  />
                </label>
              )}
              {guestsOn && f.characterId != null && (
                <button
                  type="button"
                  onClick={() => socket.emit('battle:set', { mode, change: { guest: { id: f.characterId, on: !isGuest(f) } } })}
                  aria-pressed={isGuest(f)}
                  title={isGuest(f) ? 'A Guest Hero: one Health Bar, any hero player controls them. Tap to undo.' : 'Make a Guest Hero'}
                  className={`h-8 panel-cut-sm border px-2 font-display text-[11px] font-bold uppercase ${isGuest(f) ? 'border-purple-400 bg-purple-500/30 text-purple-100' : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-200'}`}
                >
                  Guest
                </button>
              )}
              {/* **Infinite HP (decided):** per fighter, at once — hits resolve, HP never drops. */}
              <button
                type="button"
                onClick={() => f.bodies.forEach((ref) => socket.emit('fighter:infinite', { ref, on: !f.infinite }))}
                aria-pressed={f.infinite}
                title={f.infinite ? 'Infinite HP: on (hits resolve, HP never drops). Tap to turn off.' : 'Give this fighter infinite HP'}
                className={`h-8 min-w-8 panel-cut-sm border px-2 font-display text-sm font-black ${
                  f.infinite ? 'border-amber-400 bg-amber-500/30 text-amber-100' : 'border-zinc-700 bg-zinc-800 text-zinc-500 hover:text-zinc-200'
                }`}
              >
                ∞
              </button>
              <span className="w-28 text-right text-[11px] tabular-nums text-zinc-300">
                {f.infinite ? 'Infinite HP' : w ? `${barHp(weight, row.kind, row.level) + (stage.fighterSetup?.[`character:${f.characterId}`]?.bar_bonus ?? 0)} HP` : '—'}
                <span className="text-zinc-500"> (+{bonusHp(row.kind, row.level)}{die ? `, d${die}` : ''})</span>
              </span>
              <button
                type="button"
                onClick={() => f.bodies.forEach((ref) => socket.emit('fighter:exclude', { ref, on: true }))}
                title="Leave out of the fight (only scenery)"
                aria-label={`Leave ${f.name} out of the fight`}
                className="flex h-8 w-8 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-800 text-zinc-500 hover:border-red-500 hover:text-red-300"
              >
                <X size={14} aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={apply}
        disabled={!w}
        className="min-h-11 w-full panel-cut-sm bg-purple-600 px-3 text-sm font-semibold text-white hover:bg-purple-500 disabled:opacity-40"
      >
        Apply {w?.name ?? ''}
      </button>
    </div>
    {/* Complications and Battle Parameters (decided): beside the list, as icons. */}
    <aside className="md:w-[19rem] md:shrink-0 md:border-l md:border-zinc-800 md:pl-4">
      <h4 className="mb-2 font-display text-xs font-bold uppercase tracking-wide text-zinc-300">Battle Parameters</h4>
      <BattleParamsPanel mode={mode} battle={scene?.battle?.[mode]} fighters={fighters} />
    </aside>
    </div>
  );
}
