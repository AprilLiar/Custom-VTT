import { useMemo, useState } from 'react';
import DialogShell from '../DialogShell.jsx';
import { LEVEL_MAX, constructChoices, levelInfo, typeOf } from '../../lib/patd/build.js';
import { RulesEntry, cardClass, selectClass } from './BuildParts.jsx';
import { StyleSelect, hbName, useStyleGroups } from './BuildSteps.jsx';

// **Level up (decided, batch 4):** a small window listing everything the next
// level brings — the bonus die and HP, each Feature with its rules, and every
// grant that needs a choice, with the choice right there: a Super Move from
// the Archetypes you own, a new Stance (Form + Style), a new Archetype, a new
// Form or Style (Frantic), the Archetype upgraded at level 9, the Warrior's
// Path. "Level up" applies it all to the build at once. Driven by the type's
// advancement track, so it works for every level of every track.

const variantName = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : '');

export default function LevelUpDialog({ build, idx, onConfirm, onClose }) {
  const nextLevel = Math.min(LEVEL_MAX, build.level + 1);
  const now = levelInfo(build, idx);
  const after = levelInfo({ ...build, level: nextLevel }, idx);
  const step = (now.track?.levels ?? []).find((l) => l.level === nextLevel) ?? { grants: [] };
  const type = typeOf(idx, build.type);
  const groups = useStyleGroups(idx, build);
  const owned = new Set(build.archetypes.map((a) => a.id));

  // One answer per grant (by its index).
  const [answers, setAnswers] = useState({});
  const answer = (i, v) => setAnswers((a) => ({ ...a, [i]: v }));

  const superChoices = useMemo(
    () => idx.content.superMoves.filter((m) => owned.has(m.ownerId) && !build.superMoveIds.includes(m.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idx, build]
  );

  // What each grant needs; `done(i)` when its choice is made.
  const rows = step.grants.map((g, i) => {
    const a = answers[i];
    if (g.kind === 'feature') {
      const feature = idx.get(g.featureId);
      const warriorPath = g.featureId === 'feature.improved-warrior' && !build.warriorPathId;
      return { g, i, done: !warriorPath || Boolean(a), body: (
        <div className="space-y-1">
          <ul>
            <RulesEntry entry={feature} kind="Feature" />
          </ul>
          {warriorPath && (
            <label className="block text-xs text-zinc-400">
              Choose a Warrior&rsquo;s Path
              <select value={a ?? ''} onChange={(e) => answer(i, e.target.value || null)} className={`${selectClass} ml-1`}>
                <option value="">— pick —</option>
                {idx.content.warriorPaths.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      ) };
    }
    if (g.kind === 'super_move') {
      const picked = a ?? [];
      const toggle = (id) => answer(i, picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= (g.count ?? 1) ? [...picked.slice(1), id] : [...picked, id]);
      return { g, i, done: picked.length === Math.min(g.count ?? 1, superChoices.length) && superChoices.length > 0, body: (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400">Choose {g.count ?? 1} Super Move from your Archetypes. Usable from Round 2, once per fight (tap it on your turn board with two matching numbers of 3+).</p>
          {!superChoices.length && <p className="text-xs italic text-amber-300">No Super Move left to choose from your Archetypes — add an Archetype in the builder first.</p>}
          <div className="grid gap-1.5 sm:grid-cols-2">
            {superChoices.map((m) => (
              <button key={m.id} type="button" onClick={() => toggle(m.id)} className={cardClass(picked.includes(m.id))}>
                <span className="block text-xs font-semibold text-zinc-100">
                  {m.name} <span className="font-normal text-zinc-500">· {idx.get(m.ownerId)?.name}</span>
                </span>
                <span className="block text-[11px] leading-snug text-zinc-400">{m.rulesText}</span>
              </button>
            ))}
          </div>
        </div>
      ) };
    }
    if (g.kind === 'stance') {
      const s = a ?? { formId: null, styleId: null, alias: null, constructChoice: null };
      const form = s.formId ? idx.get(s.formId) : null;
      const choices = form ? constructChoices(form, idx) : [];
      const hint = g.styleArchetype === 'gained_previous_level' ? ' Its Style comes from the Archetype you gained at the previous level.' : '';
      return { g, i, done: Boolean(s.formId && s.styleId), body: (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400">A new Stance: one Form with one Style (or a Freestyle).{hint}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={s.formId ?? ''}
              onChange={(e) => {
                const f = idx.get(e.target.value);
                answer(i, { ...s, formId: e.target.value || null, alias: f?.aliases?.[0] ?? null, constructChoice: null });
              }}
              className={selectClass}
              aria-label="New Stance Form"
            >
              <option value="">— Form —</option>
              {idx.content.forms.map((f) => (
                <option key={f.id} value={f.id}>
                  {hbName(f)}
                </option>
              ))}
            </select>
            <StyleSelect value={s.styleId} onChange={(v) => answer(i, { ...s, styleId: v })} groups={groups} label="New Stance Style" />
            {choices.length > 0 && (
              <select value={s.constructChoice ?? choices[0].id} onChange={(e) => answer(i, { ...s, constructChoice: e.target.value })} className={selectClass} aria-label={`${form.name} choice`}>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      ) };
    }
    if (g.kind === 'archetype') {
      const list = idx.content.archetypes.filter((x) => !owned.has(x.id) && (x.kind === 'player' || (g.villainAllowed && x.kind === 'villain')));
      return { g, i, done: Boolean(a), body: (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400">A new Archetype, with its {variantName(g.variant)} ability{g.villainAllowed ? ' (one Villain Archetype at most)' : ''}.</p>
          <div className="grid max-h-56 gap-1.5 overflow-y-auto sm:grid-cols-3">
            {list.map((x) => (
              <button key={x.id} type="button" onClick={() => answer(i, x.id)} className={cardClass(a === x.id)} title={x.descriptionText}>
                <span className="block text-xs font-semibold text-zinc-100">{hbName(x)}</span>
                {x.kind === 'villain' && <span className="text-[10px] uppercase text-red-300">villain</span>}
              </button>
            ))}
          </div>
          {a && (
            <ul>
              {(idx.get(a)?.abilityVariants?.[g.variant] ?? []).map((id) => (
                <RulesEntry key={id} entry={idx.get(id)} kind="Ability" />
              ))}
            </ul>
          )}
        </div>
      ) };
    }
    if (g.kind === 'form' || g.kind === 'style') {
      const key = g.kind === 'form' ? 'forms' : 'styles';
      const pool = g.kind === 'form' ? idx.content.forms : groups.flatMap((gr) => gr.styles);
      const list = pool.filter((x) => !(build[key] ?? []).includes(x.id));
      return { g, i, done: Boolean(a), body: (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400">One more {variantName(g.kind)} to combine into your Stance each turn.</p>
          <select value={a ?? ''} onChange={(e) => answer(i, e.target.value || null)} className={selectClass} aria-label={`New ${g.kind}`}>
            <option value="">— {variantName(g.kind)} —</option>
            {list.map((x) => (
              <option key={x.id} value={x.id}>
                {hbName(x)}
              </option>
            ))}
          </select>
          {a && (
            <ul>
              <RulesEntry entry={idx.get(a)} kind={variantName(g.kind)} />
            </ul>
          )}
        </div>
      ) };
    }
    if (g.kind === 'upgrade_archetype') {
      const candidates = build.archetypes.filter((x) => x.variant === g.fromVariant);
      const pick = a ?? (candidates.length === 1 ? candidates[0].id : null);
      return { g, i, done: Boolean(pick) || !candidates.length, auto: pick, body: (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400">
            The Archetype you gained at level 5 trades its {variantName(g.fromVariant)} ability for its {variantName(g.toVariant)} one.
          </p>
          {candidates.length > 1 ? (
            <select value={pick ?? ''} onChange={(e) => answer(i, e.target.value || null)} className={selectClass} aria-label="Archetype to upgrade">
              <option value="">— which Archetype —</option>
              {candidates.map((x) => (
                <option key={x.id} value={x.id}>
                  {idx.get(x.id)?.name}
                </option>
              ))}
            </select>
          ) : candidates.length === 1 ? (
            <p className="text-xs text-zinc-200">{idx.get(candidates[0].id)?.name}</p>
          ) : (
            <p className="text-xs italic text-zinc-500">No {variantName(g.fromVariant)} Archetype to upgrade.</p>
          )}
          {pick && (
            <ul>
              {(idx.get(pick)?.abilityVariants?.[g.toVariant] ?? []).map((id) => (
                <RulesEntry key={id} entry={idx.get(id)} kind="Ability" />
              ))}
            </ul>
          )}
        </div>
      ) };
    }
    return { g, i, done: true, body: <p className="text-xs text-zinc-400">{g.kind}</p> };
  });

  const ready = rows.every((r) => r.done);
  const apply = () => {
    let next = { ...build, level: nextLevel };
    for (const r of rows) {
      const a = answers[r.i];
      const g = r.g;
      if (g.kind === 'feature' && a) next = { ...next, warriorPathId: a };
      if (g.kind === 'super_move' && a?.length) next = { ...next, superMoveIds: [...next.superMoveIds, ...a] };
      if (g.kind === 'stance' && a) next = { ...next, stances: [...next.stances, a] };
      if (g.kind === 'archetype' && a) next = { ...next, archetypes: [...next.archetypes, { id: a, variant: g.variant }] };
      if (g.kind === 'form' && a) next = { ...next, forms: [...(next.forms ?? []), a] };
      if (g.kind === 'style' && a) next = { ...next, styles: [...(next.styles ?? []), a] };
      if (g.kind === 'upgrade_archetype' && (a ?? r.auto)) next = { ...next, archetypes: next.archetypes.map((x) => (x.id === (a ?? r.auto) ? { ...x, variant: g.toVariant } : x)) };
    }
    onConfirm(next);
  };

  const dieText = (d) => (d ? `d${d.sides}` : 'none');
  return (
    <DialogShell
      title={`Level up → ${nextLevel}`}
      onClose={onClose}
      portal
      centered
      maxWidth="max-w-2xl"
      footer={
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-[11px] text-zinc-500">{ready ? 'All set.' : 'Make the choices above to level up.'}</p>
          <button type="button" onClick={onClose} className="min-h-9 panel-cut-sm border border-zinc-700 px-3 text-sm text-zinc-300">
            Later
          </button>
          <button type="button" onClick={apply} disabled={!ready} className="min-h-9 panel-cut-sm bg-amber-500 px-3 text-sm font-bold uppercase text-zinc-950 hover:bg-amber-400 disabled:opacity-40">
            Level up
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-zinc-400">
          {type?.name ?? 'Your character'} reaches level {nextLevel}. New at this level:
        </p>
        <ul className="space-y-2">
          <li className="panel-cut-sm border border-zinc-800 bg-zinc-900/70 p-2 text-xs text-zinc-300">
            <span className="font-display font-bold uppercase tracking-wide text-zinc-100">Bonus die</span> {dieText(now.bonusDie)} → <span className="font-bold text-amber-300">{dieText(after.bonusDie)}</span>
            <span className="mx-2 text-zinc-600">·</span>
            <span className="font-display font-bold uppercase tracking-wide text-zinc-100">HP per bar</span> +{now.bonusHpPerBar} → <span className="font-bold text-amber-300">+{after.bonusHpPerBar}</span>
          </li>
          {rows.map((r) => (
            <li key={r.i} className={`panel-cut-sm border p-2 ${r.done ? 'border-zinc-800 bg-zinc-900/70' : 'border-amber-600/70 bg-amber-950/20'}`}>
              <p className="mb-1 font-display text-xs font-bold uppercase tracking-wide text-amber-200">{grantTitle(r.g, idx)}</p>
              {r.body}
            </li>
          ))}
          {!rows.length && <li className="text-xs italic text-zinc-500">Nothing to choose: just a stronger bonus die and more HP.</li>}
        </ul>
      </div>
    </DialogShell>
  );
}

function grantTitle(g, idx) {
  if (g.kind === 'feature') return `Feature: ${idx.get(g.featureId)?.name ?? 'a Feature'}`;
  if (g.kind === 'super_move') return g.count > 1 ? `${g.count} Super Moves` : 'A Super Move';
  if (g.kind === 'stance') return 'A new Stance';
  if (g.kind === 'archetype') return `A new Archetype (${g.variant} ability)`;
  if (g.kind === 'form') return 'A new Form';
  if (g.kind === 'style') return 'A new Style';
  if (g.kind === 'upgrade_archetype') return `An Archetype becomes ${g.toVariant}`;
  return g.kind;
}
