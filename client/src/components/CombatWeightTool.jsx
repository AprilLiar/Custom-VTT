import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { socket } from '../socket.js';
import { useStage } from '../lib/useStage.js';
import { useRoster } from '../lib/useRoster.js';
import { WEIGHTS, WEIGHT_BY_KEY, barHp, bonusDie, bonusHp } from '../lib/cinematicWeight.js';

// **GM Tools → Preset Narrative Combat Weight** (decided). Works only on the
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
    const kindFor = (characterId) => (characterId != null && typeOf.get(characterId) === 'pc' ? 'hero' : 'warrior');
    return mode === 'combat'
      ? stage.combatTokens.map((t) => ({
          key: `c${t.id}`,
          ref: { combatantId: t.id },
          name: t.name,
          level: t.fight.level,
          kind: t.fight.kind ?? kindFor(t.character_id),
        }))
      : stage.summons.map((s) => ({
          key: `s${s.id}`,
          ref: { summonId: s.id },
          name: s.name,
          level: s.fight?.level ?? 1,
          kind: s.fight?.kind ?? kindFor(s.character_id),
        }));
  }, [stage, mode, typeOf]);

  const [weight, setWeight] = useState(null);
  const [rows, setRows] = useState({}); // key → { level, kind }
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
  const setAllLevels = (level) => setRows((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { ...v, level }])));
  const w = WEIGHT_BY_KEY[weight];

  const apply = () => {
    socket.emit('fight:preset_weight', {
      mode,
      weight,
      fighters: fighters.map((f) => ({ ref: f.ref, level: rows[f.key]?.level ?? 1, kind: rows[f.key]?.kind ?? 'hero' })),
    });
    onDone?.();
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        For this Scene&rsquo;s <b className="text-zinc-300">{mode === 'simple' ? 'Simple Combat' : 'Combat'}</b> fight. Applying resets everyone
        listed to one full Health Bar.
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
      {fighters.length === 0 && <p className="text-xs italic text-zinc-500">Nobody is in this fight yet.</p>}
      <ul className="space-y-1">
        {fighters.map((f) => {
          const row = rows[f.key] ?? { level: 1, kind: 'hero' };
          const die = bonusDie(row.level);
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
              <span className="w-28 text-right text-[11px] tabular-nums text-zinc-300">
                {w ? `${barHp(weight, row.kind, row.level)} HP` : '—'}
                <span className="text-zinc-500"> (+{bonusHp(row.kind, row.level)}{die ? `, d${die}` : ''})</span>
              </span>
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
  );
}
