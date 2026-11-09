import { useEffect, useMemo, useState } from 'react';
import { socket } from '../../socket.js';
import { getBuild } from '../../lib/api.js';
import { useContent } from '../../lib/patd/useContent.js';
import { LEVEL_MAX, XP_AWARDS, deriveBuild, emptyBuild, normalizeBuild, withXp } from '../../lib/patd/build.js';
import { STEPS, StepBody, grantText } from './BuildSteps.jsx';
import LevelUpDialog from './LevelUpDialog.jsx';
import { DiceRow, RulesEntry, rangeText } from './BuildParts.jsx';
import { ActionCard, SuperMoveCard } from '../actions/ActionCards.jsx';
import { SPEND_KEYS, SPEND_MODES, spendPrefs } from '../../lib/patd/engine/damage.js';

// **The character builder (builder phase 1 — decided).** On the Combat tab.
// The first run walks through the steps (Type → Archetypes → Stances → Build →
// Skills → Level); after that one overview page shows the whole build, with
// each part editable in place. Warnings, never locks. The overview also holds
// the read-only rules reference — every Ability, Action and Super Move this
// character has (decided: on the sheet only, not in combat).

export default function BuildTab({ characterId, canEdit, isNpc = false }) {
  const idx = useContent();
  const [saved, setSaved] = useState(undefined); // undefined: loading; null: none yet
  const [draft, setDraft] = useState(null); // the wizard's working copy
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState(null); // overview: the step being edited

  useEffect(() => {
    let alive = true;
    getBuild(characterId)
      .then(({ build }) => alive && setSaved(build))
      .catch(console.error);
    const onUpdated = (ev) => {
      if (Number(ev.characterId) === Number(characterId)) setSaved(ev.build);
    };
    socket.on('build:updated', onUpdated);
    return () => {
      alive = false;
      socket.off('build:updated', onUpdated);
    };
  }, [characterId]);

  const save = (build) => socket.emit('build:save', { characterId, build });

  if (!idx || saved === undefined) return <p className="text-sm text-zinc-500">Loading the rules…</p>;

  // ---- the first run
  if (!saved) {
    if (!canEdit) return <p className="text-sm italic text-zinc-500">No build yet.</p>;
    if (!draft) {
      return (
        <button
          type="button"
          onClick={() => {
            setDraft(emptyBuild());
            setStep(0);
          }}
          className="min-h-11 panel-cut-sm bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-500"
        >
          Create this character&rsquo;s build
        </button>
      );
    }
    const last = step === STEPS.length - 1;
    return (
      <div className="space-y-3">
        <ol className="flex flex-wrap gap-1 text-[11px]">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => setStep(i)}
                className={`panel-cut-sm px-2 py-1 font-display font-semibold uppercase tracking-wide ${
                  i === step ? 'bg-brand-600 text-white' : i < step ? 'bg-zinc-800 text-zinc-200' : 'bg-zinc-900 text-zinc-500'
                }`}
              >
                {i + 1}. {s.title}
              </button>
            </li>
          ))}
        </ol>
        <StepBody step={STEPS[step].key} draft={draft} set={(patch) => setDraft((d) => ({ ...d, ...patch }))} idx={idx} />
        <Warnings derived={deriveBuild(draft, idx)} />
        <div className="flex gap-2">
          <button type="button" disabled={step === 0} onClick={() => setStep((s) => s - 1)} className="min-h-10 panel-cut-sm border border-zinc-700 px-3 text-sm text-zinc-200 disabled:opacity-40">
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              if (last) {
                save(draft);
                setDraft(null);
              } else setStep((s) => s + 1);
            }}
            className="min-h-10 panel-cut-sm bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-500"
          >
            {last ? 'Finish' : 'Next'}
          </button>
          <button type="button" onClick={() => setDraft(null)} className="ml-auto text-xs text-zinc-500 hover:text-zinc-300">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return <Overview saved={saved} idx={idx} canEdit={canEdit} editing={editing} setEditing={setEditing} save={save} characterId={characterId} isNpc={isNpc} />;
}

function Overview({ saved, idx, canEdit, editing, setEditing, save, characterId, isNpc }) {
  const d = useMemo(() => deriveBuild(saved, idx), [saved, idx]);
  const [edit, setEdit] = useState(null);
  const startEdit = (key) => {
    setEdit(normalizeBuild(saved, idx));
    setEditing(key);
  };
  const section = (key, title, body) => (
    <section className="space-y-1.5 panel-cut-sm border border-zinc-800 bg-zinc-900/70 p-2.5">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-300">{title}</h3>
        {canEdit && editing !== key && (
          <button type="button" onClick={() => startEdit(key)} className="text-[11px] text-zinc-400 hover:text-zinc-100">
            Edit
          </button>
        )}
      </div>
      {editing === key && edit ? (
        <div className="space-y-2">
          <StepBody step={key} draft={edit} set={(patch) => setEdit((e) => ({ ...e, ...patch }))} idx={idx} />
          <Warnings derived={deriveBuild(edit, idx)} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                save(edit);
                setEditing(null);
              }}
              className="min-h-9 panel-cut-sm bg-brand-600 px-3 text-xs font-semibold text-white hover:bg-brand-500"
            >
              Save
            </button>
            <button type="button" onClick={() => setEditing(null)} className="min-h-9 panel-cut-sm border border-zinc-700 px-3 text-xs text-zinc-300">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        body
      )}
    </section>
  );

  const name = (id) => idx.get(id)?.name ?? id;
  return (
    <div className="space-y-3">
      <Warnings derived={d} />
      {section(
        'type',
        'Type',
        <p className="text-sm text-zinc-200">
          {d.type.name} · Level {d.level.level}
          {d.level.xpLevel != null ? ` · ${d.build.xp} XP` : ''} · {d.healthBars} Health Bar{d.healthBars === 1 ? '' : 's'}
        </p>
      )}
      {section(
        'archetypes',
        'Archetypes',
        <ul className="space-y-1">
          {d.archetypes.length === 0 && <li className="text-xs italic text-zinc-600">None.</li>}
          {d.archetypes.map((a) => (
            <li key={a.id} className="text-sm text-zinc-200">
              {a.name} <span className="text-[11px] text-zinc-500">({a.variant} ability)</span>
            </li>
          ))}
        </ul>
      )}
      {section(
        'stances',
        d.type.assemble ? 'Forms & Styles' : 'Stances',
        d.type.assemble ? (
          <p className="text-xs text-zinc-300">
            Forms: {d.formIds.map(name).join(', ') || '—'}
            <br />
            Styles: {d.styleIds.map(name).join(', ') || '—'}
          </p>
        ) : (
          <ul className="space-y-1">
            {d.stances.length === 0 && <li className="text-xs italic text-zinc-600">None.</li>}
            {d.stances.map((s) => (
              <li key={s.key} className="flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                <span className="font-display text-sm font-semibold uppercase tracking-wide text-zinc-100">{s.name}</span>
                <DiceRow dice={s.dice} />
                <span className="text-zinc-500">{rangeText(s.range)}</span>
              </li>
            ))}
          </ul>
        )
      )}
      {section('build', 'Build', <p className="text-sm text-zinc-200">{d.build.buildId ? name(d.build.buildId) : '—'}</p>)}
      {section(
        'skills',
        'Skills',
        <p className="text-sm text-zinc-200">{[...d.skillIds.map(name), d.customSkill].filter(Boolean).join(' · ') || '—'}</p>
      )}
      {section(
        'level',
        'Level & advancement',
        <div className="space-y-1 text-xs text-zinc-300">
          <p>
            Level {d.level.level} · {d.level.bonusDie ? `bonus d${d.level.bonusDie.sides}` : 'no bonus die'} · +{d.level.bonusHpPerBar} HP per bar
            {d.level.nextXp != null ? ` · next at ${d.level.nextXp} XP` : ''}
            {d.level.canLevelUp && <span className="ml-1 font-bold text-amber-300">— enough XP to level up!</span>}
          </p>
          {d.level.grants.length > 0 && <p className="text-zinc-500">{d.level.grants.map((g) => `L${g.level}: ${grantText(g, idx)}`).join(' · ')}</p>}
        </div>
      )}
      {d.level.xpLevel != null && <XpTracker build={normalizeBuild(saved, idx)} level={d.level} canEdit={canEdit} save={save} idx={idx} />}
      <HitSpends build={normalizeBuild(saved, idx)} isNpc={isNpc} canEdit={canEdit} save={save} />
      <ActionsReference d={d} idx={idx} />
      <RulesReference d={d} idx={idx} />
      {canEdit && (
        <button
          type="button"
          onClick={() => window.confirm('Delete this build and start over?') && socket.emit('build:clear', { characterId })}
          className="text-xs text-red-500 hover:text-red-400"
        >
          Delete build
        </button>
      )}
    </div>
  );
}

// **Hit spends (decided, full automation phase C).** When this character is
// hit or hits, whether the engine asks before spending Power (enhance your
// hit), Iron (reduce theirs) and the Shield (block it), spends them by itself,
// or never does. Players default to Ask, NPCs to Auto. On your own committed
// Actions the dice board's Power toggle decides instead (it starts on for Auto).
const SPEND_LABEL = { power: 'Power', iron: 'Iron', shield: 'Shield' };
const SPEND_HINT = {
  power: 'enhance your hits: +1 damage and Push 1 each',
  iron: 'reduce hits on you: −1 damage and −1 push/pull each (Auto saves it when Armor would block anyway)',
  shield: 'block hits on you with your Shield',
};
function HitSpends({ build, isNpc, canEdit, save }) {
  const prefs = spendPrefs(build.prefs, isNpc);
  const set = (key, mode) => save({ ...build, prefs: { ...build.prefs, [key]: mode } });
  return (
    <section className="space-y-2 panel-cut-sm border border-zinc-800 bg-zinc-900/70 p-2.5">
      <h3 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-300">Hit spends</h3>
      <ul className="space-y-1.5">
        {SPEND_KEYS.map((key) => (
          <li key={key} className="flex flex-wrap items-center gap-2">
            <span className="w-14 font-display text-sm font-semibold uppercase tracking-wide text-zinc-100">{SPEND_LABEL[key]}</span>
            <span className="inline-flex overflow-hidden rounded-sm border border-zinc-700" role="radiogroup" aria-label={SPEND_LABEL[key]}>
              {SPEND_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={prefs[key] === mode}
                  disabled={!canEdit}
                  onClick={() => set(key, mode)}
                  className={`min-h-8 px-2.5 text-xs font-semibold capitalize ${
                    prefs[key] === mode ? 'bg-brand-600 text-white' : 'bg-zinc-900 text-zinc-400 enabled:hover:text-zinc-100'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </span>
            <span className="min-w-0 flex-1 text-[11px] leading-tight text-zinc-500">{SPEND_HINT[key]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// **XP on the sheet (decided).** The total, how far to the next level, quick
// awards (each logged with its reason), the level-up when the XP allows it,
// and the recent history — fight ends add Victory / Defeat here on their own.
function XpTracker({ build, level, canEdit, save, idx }) {
  const add = (n, reason) => save(withXp(build, n, reason));
  // Level up opens the window of what the new level brings (batch 4).
  const [leveling, setLeveling] = useState(false);
  const pct = level.nextXp ? Math.min(100, Math.round((build.xp / level.nextXp) * 100)) : 100;
  const btn = 'min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-200 hover:border-brand-500';
  const log = [...(build.xpLog ?? [])].reverse().slice(0, 6);
  return (
    <section className="space-y-2 panel-cut-sm border border-zinc-800 bg-zinc-900/70 p-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-300">Experience</h3>
        <span className="font-mono text-sm text-zinc-100">
          {build.xp} XP{level.nextXp != null ? <span className="text-zinc-500"> / {level.nextXp} for level {build.level + 1}</span> : ''}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={build.xp} aria-valuemax={level.nextXp ?? build.xp}>
        <div className={`h-full ${level.canLevelUp ? 'bg-amber-400' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} />
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => add(-1, 'Correction')} className={btn} aria-label="Remove 1 XP">
            −1
          </button>
          <button type="button" onClick={() => add(1, 'Manual')} className={btn} aria-label="Add 1 XP">
            +1
          </button>
          <button type="button" onClick={() => add(XP_AWARDS.victory, 'Victory')} className={btn}>
            Victory +{XP_AWARDS.victory}
          </button>
          <button type="button" onClick={() => add(XP_AWARDS.defeat, 'Defeat')} className={btn}>
            Defeat +{XP_AWARDS.defeat}
          </button>
          {level.canLevelUp && (
            <button
              type="button"
              onClick={() => build.level < LEVEL_MAX && setLeveling(true)}
              className="min-h-9 panel-cut-sm bg-amber-500 px-3 text-xs font-bold uppercase text-zinc-950 hover:bg-amber-400"
            >
              Level up → {build.level + 1}
            </button>
          )}
        </div>
      )}
      {leveling && (
        <LevelUpDialog
          build={build}
          idx={idx}
          onClose={() => setLeveling(false)}
          onConfirm={(next) => {
            save(next);
            setLeveling(false);
          }}
        />
      )}
      {log.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-zinc-400">
          {log.map((e, i) => (
            <li key={i} className="flex gap-2">
              <span className={`w-8 shrink-0 text-right font-mono ${e.amount < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {e.amount > 0 ? '+' : ''}
                {e.amount}
              </span>
              <span className="flex-1 truncate">{e.reason || 'XP'}</span>
              {e.at && <span className="text-zinc-600">{new Date(e.at).toLocaleDateString()}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Warnings({ derived }) {
  if (!derived.warnings.length) return null;
  return (
    <ul className="space-y-0.5 panel-cut-sm border border-amber-600/50 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-200">
      {derived.warnings.map((w) => (
        <li key={w}>⚠ {w}</li>
      ))}
    </ul>
  );
}

// **Active effects (decided: on the sheet only).** The Abilities this
// character always has, the Frantic ones, then each Stance's. Actions live in
// their own section below (ActionsReference).
function RulesReference({ d, idx }) {
  const [open, setOpen] = useState(null);
  const groups = [
    { key: 'always', title: 'Always in effect', abilities: d.constantAbilityIds },
    ...(d.franticAbilityIds?.length ? [{ key: 'frantic', title: 'Frantic Abilities (one each turn)', abilities: d.franticAbilityIds }] : []),
    ...d.stances.map((s) => ({ key: s.key, title: s.name, abilities: s.abilityIds })),
    ...(d.type.assemble
      ? [...d.formIds, ...d.styleIds].map((id) => ({ key: id, title: idx.get(id)?.name, abilities: idx.get(id)?.abilityIds ?? [] }))
      : []),
  ].filter((g) => g.abilities.length);
  return (
    <section className="space-y-1.5">
      <h3 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-300">Active effects</h3>
      {groups.map((g) => (
        <div key={g.key} className="panel-cut-sm border border-zinc-800 bg-zinc-900/50">
          <button
            type="button"
            onClick={() => setOpen((k) => (k === g.key ? null : g.key))}
            aria-expanded={open === g.key}
            className="flex w-full items-center justify-between px-2 py-1.5 text-left font-display text-xs font-semibold uppercase tracking-wide text-zinc-200"
          >
            {g.title}
            <span className="text-zinc-500">{open === g.key ? '−' : '+'}</span>
          </button>
          {open === g.key && (
            <ul className="space-y-1 px-2 pb-2">
              {g.abilities.map((id) => (
                <RulesEntry key={id} entry={idx.get(id)} kind="Ability" />
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

// **Actions (decided):** apart from the active effects, drawn as the book's
// cards, in two parts — Basic (everyone's) and Personal (this character's:
// always available, then each Stance's, then Super Moves).
function ActionsReference({ d, idx }) {
  const basic = idx.content.basicActionIds ?? [];
  const isBasic = new Set(basic);
  const personal = [
    { title: 'Always available', ids: d.constantActionIds.filter((id) => !isBasic.has(id)) },
    ...d.stances.map((s) => ({ title: s.name, ids: s.actionIds })),
    ...(d.type.assemble ? [...d.formIds, ...d.styleIds].map((id) => ({ title: idx.get(id)?.name, ids: idx.get(id)?.actionIds ?? [] })) : []),
  ].filter((g) => g.ids.length);
  const [show, setShow] = useState({ basic: false, personal: true });
  const part = (key, title, body) => (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setShow((v) => ({ ...v, [key]: !v[key] }))}
        aria-expanded={show[key]}
        className="flex w-full items-center justify-between font-display text-[11px] font-bold uppercase tracking-wide text-emerald-300"
      >
        {title}
        <span className="text-zinc-500">{show[key] ? '−' : '+'}</span>
      </button>
      {show[key] && body}
    </div>
  );
  return (
    <section className="space-y-3">
      <h3 className="font-display text-xs font-bold uppercase tracking-wide text-zinc-300">Actions</h3>
      <div className="grid gap-4 md:grid-cols-2 md:divide-x md:divide-zinc-800">
        {part(
          'basic',
          `Basic Actions (${basic.length})`,
          <div className="space-y-1.5">
            {basic.map((id) => (
              <ActionCard key={id} action={idx.get(id)} />
            ))}
          </div>
        )}
        <div className="md:pl-4">
          {part(
            'personal',
            'Personal Actions',
            <div className="space-y-3">
              {personal.length === 0 && d.superMoveIds.length === 0 && <p className="text-xs italic text-zinc-600">None yet.</p>}
              {personal.map((g, i) => (
                <div key={i} className="space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">{g.title}</p>
                  {g.ids.map((id) => (
                    <ActionCard key={id} action={idx.get(id)} />
                  ))}
                </div>
              ))}
              {d.superMoveIds.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Super Moves</p>
                  {d.superMoveIds.map((id) => (
                    <SuperMoveCard key={id} move={idx.get(id)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
