import { useMemo } from 'react';
import {
  CUSTOM_SKILL_MAX,
  LEVEL_MAX,
  VARIANTS,
  buildTypes,
  constructChoices,
  deriveStance,
  levelInfo,
  shortStyleName,
} from '../../lib/patd/build.js';
import { DiceRow, RulesEntry, cardClass, rangeText, selectClass } from './BuildParts.jsx';

// The builder's steps (decided: step by step on the first run, then each one
// editable from the overview). Every step edits a draft build through
// `set(patch)`; nothing is locked — illegal picks only show warnings.

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const STEPS = [
  { key: 'type', title: 'Type' },
  { key: 'archetypes', title: 'Archetypes' },
  { key: 'stances', title: 'Stances' },
  { key: 'build', title: 'Build' },
  { key: 'skills', title: 'Skills' },
  { key: 'level', title: 'Level' },
];

export function StepBody({ step, draft, set, idx }) {
  if (step === 'type') return <TypeStep draft={draft} set={set} idx={idx} />;
  if (step === 'archetypes') return <ArchetypeStep draft={draft} set={set} idx={idx} />;
  if (step === 'stances') return <StanceStep draft={draft} set={set} idx={idx} />;
  if (step === 'build') return <BuildStep draft={draft} set={set} idx={idx} />;
  if (step === 'skills') return <SkillStep draft={draft} set={set} idx={idx} />;
  return <LevelStep draft={draft} set={set} idx={idx} />;
}

function TypeStep({ draft, set, idx }) {
  const types = buildTypes(idx);
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">Any character may be any type — hero or NPC. The type sets the defaults the builder checks against.</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {types.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() =>
              set({
                type: t.id,
                archetypes: draft.archetypes.map((a) => ({ ...a, variant: t.variant })),
              })
            }
            className={cardClass(draft.type === t.id)}
          >
            <span className="block font-display text-sm font-bold uppercase tracking-wide text-zinc-100">{t.name}</span>
            <span className="block text-[11px] text-zinc-400">
              {t.kind === 'hero' ? 'Hero' : 'NPC'} · {t.assemble ? 'builds a Stance each turn' : `${t.stanceCount} Stance${t.stanceCount === 1 ? '' : 's'}`} ·{' '}
              {titleCase(t.variant)} abilities{t.healthBarRange ? ` · ${t.healthBarRange.minimum}-${t.healthBarRange.maximum} bars` : ''}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ArchetypeStep({ draft, set, idx }) {
  const type = buildTypes(idx).find((t) => t.id === draft.type);
  const all = idx.content.archetypes;
  const has = (id) => draft.archetypes.some((a) => a.id === id);
  const toggle = (id) =>
    set({
      archetypes: has(id) ? draft.archetypes.filter((a) => a.id !== id) : [...draft.archetypes, { id, variant: type?.variant ?? 'focused' }],
    });
  const setVariant = (id, variant) => set({ archetypes: draft.archetypes.map((a) => (a.id === id ? { ...a, variant } : a)) });
  return (
    <div className="space-y-3">
      {draft.archetypes.length > 0 && (
        <ul className="space-y-1">
          {draft.archetypes.map((a) => {
            const arch = idx.get(a.id);
            const abilities = (arch?.abilityVariants?.[a.variant] ?? []).map((id) => idx.get(id));
            return (
              <li key={a.id} className="panel-cut-sm border border-brand-700 bg-brand-950/30 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-sm font-bold uppercase text-zinc-100">{arch?.name}</span>
                  {arch?.kind === 'villain' && <span className="text-[10px] uppercase text-red-300">villain</span>}
                  {arch?.abilityVariants && Object.keys(arch.abilityVariants).length > 0 && (
                    <select value={a.variant} onChange={(e) => setVariant(a.id, e.target.value)} className={selectClass} aria-label={`${arch.name} ability`}>
                      {VARIANTS.filter((v) => arch.abilityVariants[v]).map((v) => (
                        <option key={v} value={v}>
                          {titleCase(v)} ability
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="button" onClick={() => toggle(a.id)} className="ml-auto text-[11px] text-red-400 hover:text-red-300">
                    Remove
                  </button>
                </div>
                <ul className="mt-1 space-y-1">
                  {abilities.map((ab) => (
                    <RulesEntry key={ab?.id} entry={ab} />
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {['player', 'villain'].map((kind) => (
        <div key={kind}>
          <h4 className="mb-1 text-[10px] font-bold uppercase tracking-wide text-zinc-500">{kind === 'player' ? 'Archetypes' : 'Villain Archetypes'}</h4>
          <div className="grid gap-1.5 sm:grid-cols-3">
            {all
              .filter((a) => a.kind === kind)
              .map((a) => (
                <button key={a.id} type="button" onClick={() => toggle(a.id)} className={cardClass(has(a.id))} title={a.descriptionText}>
                  <span className="block text-xs font-semibold text-zinc-100">{a.name}</span>
                  <span className="block text-[10px] text-zinc-500">
                    {(a.keywords ?? []).join(' · ')}
                    {a.complexity ? ` · complexity ${a.complexity}` : ''}
                  </span>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// Every Style and Freestyle, grouped: this character's Archetypes first.
function useStyleGroups(idx, draft) {
  return useMemo(() => {
    const mine = new Set(draft.archetypes.map((a) => a.id));
    const groups = [];
    const byArch = new Map();
    for (const s of idx.content.styles) {
      if (!byArch.has(s.archetypeId)) byArch.set(s.archetypeId, []);
      byArch.get(s.archetypeId).push(s);
    }
    const archs = idx.content.archetypes.filter((a) => byArch.has(a.id));
    archs.sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)));
    for (const a of archs) groups.push({ label: a.name + (mine.has(a.id) ? ' ★' : ''), styles: byArch.get(a.id) });
    groups.push({ label: 'Freestyles', styles: idx.content.freestyles });
    return groups;
  }, [idx, draft.archetypes]);
}

function StyleSelect({ value, onChange, groups, label }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} className={selectClass} aria-label={label}>
      <option value="">— Style —</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.styles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function StanceStep({ draft, set, idx }) {
  const type = buildTypes(idx).find((t) => t.id === draft.type);
  const groups = useStyleGroups(idx, draft);
  const lv = levelInfo(draft, idx);
  if (type?.assemble) {
    const toggleIn = (key, id) => set({ [key]: draft[key].includes(id) ? draft[key].filter((x) => x !== id) : [...draft[key], id] });
    return (
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">
          A Frantic Hero knows Forms and Styles and combines them into a Stance at the start of each turn (that comes with the
          fight automation). Pick {3 + lv.extra.forms} Forms and {3 + lv.extra.styles} Styles, one per Archetype.
        </p>
        <h4 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Forms</h4>
        <div className="grid gap-1.5 sm:grid-cols-4">
          {idx.content.forms.map((f) => (
            <button key={f.id} type="button" onClick={() => toggleIn('forms', f.id)} className={cardClass(draft.forms.includes(f.id))}>
              <span className="block text-xs font-semibold text-zinc-100">{f.name}</span>
              <DiceRow dice={f.actionDice} />
            </button>
          ))}
        </div>
        <h4 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Styles</h4>
        {groups.map((g) => (
          <div key={g.label}>
            <p className="text-[10px] text-zinc-500">{g.label}</p>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {g.styles.map((s) => (
                <button key={s.id} type="button" onClick={() => toggleIn('styles', s.id)} className={cardClass(draft.styles.includes(s.id))}>
                  <span className="text-xs text-zinc-100">{shortStyleName(s.name)}</span>
                  <span className="ml-1 text-[10px] text-zinc-500">{rangeText(s.range)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }
  const want = (type?.stanceCount ?? 3) + lv.extra.stances;
  const update = (i, patch) => set({ stances: draft.stances.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">
        Each Stance pairs one Form with one Style (or a Freestyle). Expected at level {draft.level}: {want}.
      </p>
      {draft.stances.map((s, i) => {
        const form = s.formId ? idx.get(s.formId) : null;
        const derived = deriveStance(s, idx, lv.bonusDie);
        const choices = form ? constructChoices(form, idx) : [];
        return (
          <div key={i} className="space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-900 p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={s.formId ?? ''}
                onChange={(e) => {
                  const f = idx.get(e.target.value);
                  update(i, { formId: e.target.value || null, alias: f?.aliases?.[0] ?? null, constructChoice: null });
                }}
                className={selectClass}
                aria-label={`Stance ${i + 1} Form`}
              >
                <option value="">— Form —</option>
                {idx.content.forms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              {form && (
                <select value={s.alias ?? ''} onChange={(e) => update(i, { alias: e.target.value })} className={selectClass} aria-label={`Stance ${i + 1} name`}>
                  {form.aliases.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              )}
              <StyleSelect value={s.styleId} onChange={(v) => update(i, { styleId: v })} groups={groups} label={`Stance ${i + 1} Style`} />
              {choices.length > 0 && (
                <select
                  value={s.constructChoice ?? choices[0].id}
                  onChange={(e) => update(i, { constructChoice: e.target.value })}
                  className={selectClass}
                  aria-label={`Stance ${i + 1} ${form.name} choice`}
                >
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" onClick={() => set({ stances: draft.stances.filter((_, j) => j !== i) })} className="ml-auto text-[11px] text-red-400 hover:text-red-300">
                Remove
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
              <span className="font-display font-semibold uppercase tracking-wide text-zinc-100">{derived.name}</span>
              <DiceRow dice={derived.dice} />
              <span className="text-zinc-500">{rangeText(derived.range)}</span>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => set({ stances: [...draft.stances, { formId: null, styleId: null, alias: null, constructChoice: null }] })}
        className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 text-xs font-semibold text-zinc-200 hover:border-brand-500"
      >
        + Add Stance
      </button>
    </div>
  );
}

function BuildStep({ draft, set, idx }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {idx.content.builds.map((b) => {
        const ab = idx.get(b.abilityIds?.[0]);
        return (
          <button key={b.id} type="button" onClick={() => set({ buildId: b.id })} className={cardClass(draft.buildId === b.id)}>
            <span className="block font-display text-sm font-bold uppercase tracking-wide text-zinc-100">{b.name}</span>
            <span className="block text-[11px] leading-snug text-zinc-400">{ab?.rulesText ?? b.descriptionText}</span>
          </button>
        );
      })}
    </div>
  );
}

function SkillStep({ draft, set, idx }) {
  const type = buildTypes(idx).find((t) => t.id === draft.type);
  const formIds = [...new Set(type?.assemble ? draft.forms : draft.stances.map((s) => s.formId).filter(Boolean))];
  const formSkills = formIds.map((id) => idx.get(idx.get(id)?.skillId)).filter(Boolean);
  const sk = draft.skills;
  const setSk = (patch) => set({ skills: { ...sk, ...patch } });
  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500">Each Form gives a Skill. You may swap one of them for any other Skill, and you write a two-word description as your last.</p>
      <ul className="space-y-1">
        {formSkills.map((s) => (
          <RulesEntry key={s.id} entry={s.id === sk.replaceFromId && sk.replaceToId ? { ...idx.get(sk.replaceToId), name: `${idx.get(sk.replaceToId)?.name} (replaces ${s.name})` } : s} kind="Skill" />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
        Replace
        <select value={sk.replaceFromId ?? ''} onChange={(e) => setSk({ replaceFromId: e.target.value || null })} className={selectClass} aria-label="Skill to replace">
          <option value="">— none —</option>
          {formSkills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        with
        <select value={sk.replaceToId ?? ''} onChange={(e) => setSk({ replaceToId: e.target.value || null })} className={selectClass} aria-label="Replacement Skill">
          <option value="">— none —</option>
          {idx.content.skills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <label className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
        Two-word Skill
        <input
          value={sk.custom}
          maxLength={CUSTOM_SKILL_MAX}
          onChange={(e) => setSk({ custom: e.target.value })}
          placeholder="e.g. Grumpy Monk"
          className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
        />
      </label>
    </div>
  );
}

function LevelStep({ draft, set, idx }) {
  const type = buildTypes(idx).find((t) => t.id === draft.type);
  const lv = levelInfo(draft, idx);
  const owned = new Set(draft.archetypes.map((a) => a.id));
  const supers = idx.content.superMoves.filter((m) => owned.has(m.ownerId));
  const toggleSuper = (id) =>
    set({ superMoveIds: draft.superMoveIds.includes(id) ? draft.superMoveIds.filter((x) => x !== id) : [...draft.superMoveIds, id] });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-zinc-400">
          Level
          <select value={draft.level} onChange={(e) => set({ level: Number(e.target.value) })} className={`${selectClass} ml-1`}>
            {Array.from({ length: LEVEL_MAX }, (_, i) => i + 1).map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {lv.xpLevel != null && (
          <label className="text-xs text-zinc-400">
            XP
            <input
              type="number"
              min={0}
              value={draft.xp}
              onChange={(e) => set({ xp: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })}
              className="ml-1 min-h-9 w-20 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
            />
          </label>
        )}
        {lv.xpLevel != null && (
          <span className="flex gap-1">
            {[
              ['Victory', 2],
              ['Defeat', 1],
            ].map(([label, n]) => (
              <button
                key={label}
                type="button"
                onClick={() => set({ xp: draft.xp + n })}
                className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200 hover:border-brand-500"
              >
                {label} +{n}
              </button>
            ))}
          </span>
        )}
        {lv.canLevelUp && (
          <button
            type="button"
            onClick={() => set({ level: Math.min(LEVEL_MAX, draft.level + 1) })}
            className="min-h-9 panel-cut-sm bg-amber-500 px-3 text-xs font-bold uppercase text-zinc-950 hover:bg-amber-400"
          >
            Level up → {draft.level + 1}
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-400">
        {lv.bonusDie ? `Bonus die d${lv.bonusDie.sides}` : 'No bonus die'} · +{lv.bonusHpPerBar} HP per bar
        {lv.nextXp != null ? ` · next level at ${lv.nextXp} XP` : ''}
      </p>
      {lv.grants.length > 0 && (
        <div>
          <h4 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Granted so far</h4>
          <ul className="mt-1 space-y-0.5 text-xs text-zinc-300">
            {lv.grants.map((g, i) => (
              <li key={i}>
                Level {g.level}: {grantText(g, idx)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h4 className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
          Super Moves ({draft.superMoveIds.length} of {lv.extra.superMoves})
        </h4>
        {supers.length === 0 && <p className="text-xs italic text-zinc-600">Pick Archetypes first.</p>}
        <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
          {supers.map((m) => (
            <button key={m.id} type="button" onClick={() => toggleSuper(m.id)} className={cardClass(draft.superMoveIds.includes(m.id))}>
              <span className="block text-xs font-semibold text-zinc-100">{m.name}</span>
              <span className="block text-[11px] leading-snug text-zinc-400">{m.rulesText}</span>
            </button>
          ))}
        </div>
      </div>
      {(type?.id === 'character-type.warrior' || lv.featureIds.includes('feature.improved-warrior')) && (
        <label className="block text-xs text-zinc-400">
          Warrior&rsquo;s Path
          <select value={draft.warriorPathId ?? ''} onChange={(e) => set({ warriorPathId: e.target.value || null })} className={`${selectClass} ml-1`}>
            <option value="">— none —</option>
            {idx.content.warriorPaths.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {type?.healthBarRange && (
        <label className="block text-xs text-zinc-400">
          Health Bars
          <input
            type="number"
            min={1}
            max={9}
            value={draft.healthBars ?? type.healthBars}
            onChange={(e) => set({ healthBars: Math.max(1, Math.min(9, Math.trunc(Number(e.target.value) || 1))) })}
            className="ml-1 min-h-9 w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 text-sm text-zinc-100 outline-none focus:border-brand-500"
          />
        </label>
      )}
    </div>
  );
}

export function grantText(g, idx) {
  if (g.kind === 'super_move') return `${g.count} Super Move`;
  if (g.kind === 'feature') return idx.get(g.featureId)?.name ?? 'a Feature';
  if (g.kind === 'stance') return `${g.count} more Stance`;
  if (g.kind === 'form') return `${g.count} more Form`;
  if (g.kind === 'style') return `${g.count} more Style`;
  if (g.kind === 'archetype') return `${g.count} new Archetype (${g.variant} ability)`;
  if (g.kind === 'upgrade_archetype') return `the level-5 Archetype's ability becomes ${g.toVariant}`;
  return g.kind;
}
