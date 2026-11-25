import { useEffect, useMemo, useState } from 'react';
import { socket } from '../../socket.js';
import { getBuild } from '../../lib/api.js';
import { useContent } from '../../lib/patd/useContent.js';
import { LEVEL_MAX, XP_AWARDS, deriveBuild, emptyBuild, normalizeBuild, withXp } from '../../lib/patd/build.js';
import { STEPS as ALL_STEPS, StepBody, grantText } from './BuildSteps.jsx';
import { isSkillWarning, useSkillsEnabled } from '../../lib/skillsSetting.js';
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

export default function BuildTab({ characterId, canEdit, isNpc = false, tokenSlot = null }) {
  // Skills off (GM setting): the Skills step is skipped.
  const skillsOn = useSkillsEnabled();
  const STEPS = skillsOn ? ALL_STEPS : ALL_STEPS.filter((st) => st.key !== 'skills');
  const idx = useContent();
  const [saved, setSaved] = useState(undefined); // undefined: loading; null: none yet
  const [draft, setDraft] = useState(null); // the wizard's working copy
  const [rawStep, setStep] = useState(0);
  // Skills switched off mid-way: never past the last step there is.
  const step = Math.min(rawStep, STEPS.length - 1);
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
    if (!canEdit) return <div className="space-y-3">{tokenSlot}<p className="text-sm italic text-zinc-500">No build yet.</p></div>;
    if (!draft) {
      return (
        <div className="flex flex-wrap items-center gap-4">
        {tokenSlot}
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
        </div>
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
          <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)} className="min-h-10 panel-cut-sm border border-zinc-700 px-3 text-sm text-zinc-200 disabled:opacity-40">
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              if (last) {
                save(draft);
                setDraft(null);
              } else setStep(step + 1);
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

  return <Overview saved={saved} idx={idx} canEdit={canEdit} editing={editing} setEditing={setEditing} save={save} characterId={characterId} isNpc={isNpc} tokenSlot={tokenSlot} />;
}

// **The Combat tab as a character sheet (decided, play feedback).** The whole
// screen: a banner with who they are (token, type, level, XP, bars, Build,
// Archetypes), a Stance switcher, then three columns — the **choices** that
// make the build (each editable in place), every **active Ability** in one
// place (always on, then the chosen Stance's), and the **Actions** (Personal
// for that Stance, Super Moves, then the Basic ones). Phones stack them.
function Overview({ saved, idx, canEdit, editing, setEditing, save, characterId, isNpc, tokenSlot = null }) {
  const skillsOn = useSkillsEnabled();
  const d = useMemo(() => deriveBuild(saved, idx), [saved, idx]);
  const build = useMemo(() => normalizeBuild(saved, idx), [saved, idx]);
  const [edit, setEdit] = useState(null);
  const startEdit = (key) => {
    setEdit(normalizeBuild(saved, idx));
    setEditing(key);
  };
  const name = (id) => idx.get(id)?.name ?? id;
  // The Stance the sheet shows (Frantic: each Form and Style is its own source).
  const stanceTabs = d.type.assemble
    ? [...d.formIds, ...d.styleIds].map((id) => ({ key: id, name: idx.get(id)?.name ?? id, abilityIds: idx.get(id)?.abilityIds ?? [], actionIds: idx.get(id)?.actionIds ?? [], dice: null, range: idx.get(id)?.range ?? null }))
    : d.stances.map((s) => ({ key: s.key, name: s.name, abilityIds: s.abilityIds, actionIds: s.actionIds, dice: s.dice, range: s.range }));
  const [picked, setPicked] = useState(null);
  const current = stanceTabs.find((t) => t.key === picked) ?? stanceTabs[0] ?? null;

  // A choice block: its title, an Edit button, and the builder step when editing.
  const choice = (key, title, body) => (
    <section className="space-y-1.5 border-b border-zinc-800/80 pb-3 last:border-b-0">
      <div className="flex items-center justify-between">
        <h4 className="font-display text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">{title}</h4>
        {canEdit && editing !== key && (
          <button type="button" onClick={() => startEdit(key)} className="rounded-sm px-1.5 text-[11px] font-semibold text-brand-300 hover:bg-brand-950/60 hover:text-brand-100">
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
  const column = (title, accent, children, extra = '') => (
    <div className={`min-w-0 space-y-3 panel-cut border border-zinc-800 bg-zinc-900/60 p-3 ${extra}`}>
      <h3 className={`flex items-center gap-2 font-display text-sm font-bold uppercase tracking-wide ${accent}`}>{title}</h3>
      {children}
    </div>
  );
  const chip = (text, tone = 'border-zinc-700 bg-zinc-900 text-zinc-200') => <span className={`rounded-sm border px-2 py-0.5 text-xs font-semibold ${tone}`}>{text}</span>;
  const pct = d.level.nextXp ? Math.min(100, Math.round(((build.xp ?? 0) / d.level.nextXp) * 100)) : 100;

  return (
    <div className="space-y-4" data-testid="combat-sheet">
      {/* ---- the banner */}
      <header className="relative overflow-hidden panel-cut-lg border border-zinc-800 bg-[radial-gradient(ellipse_at_top_left,rgba(220,38,38,0.18),transparent_60%),linear-gradient(180deg,#18181b,#0c0c0e)] p-4">
        <div className="flex flex-wrap items-center gap-4">
          {tokenSlot}
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-display text-2xl font-bold uppercase tracking-wide text-zinc-50">{d.type.name}</span>
              <span className="font-display text-lg font-bold text-amber-300">Level {d.level.level}</span>
              {d.level.canLevelUp && <span className="rounded-sm bg-amber-500 px-1.5 text-[11px] font-bold uppercase text-zinc-950">Level up ready</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {d.archetypes.map((a) => chip(`${a.name} · ${a.variant}`, 'border-purple-500/60 bg-purple-950/40 text-purple-100'))}
              {d.build.buildId && chip(name(d.build.buildId), 'border-zinc-600 bg-zinc-800 text-zinc-100')}
              {build.warriorPathId && chip(name(build.warriorPathId), 'border-sky-600/60 bg-sky-950/40 text-sky-100')}
            </div>
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center sm:min-w-80">
            {[
              ['Health Bars', d.healthBars],
              ['Bonus die', d.level.bonusDie ? `d${d.level.bonusDie.sides}` : '—'],
              ['HP per bar', `+${d.level.bonusHpPerBar}`],
            ].map(([k, v]) => (
              <div key={k} className="panel-cut-sm border border-zinc-800 bg-zinc-950/70 px-2 py-1.5">
                <dt className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">{k}</dt>
                <dd className="font-display text-xl font-bold text-zinc-100">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        {d.level.xpLevel != null && (
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="font-mono text-zinc-300">{build.xp ?? 0} XP</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <div className={`h-full ${d.level.canLevelUp ? 'bg-amber-400' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="text-zinc-500">{d.level.nextXp != null ? `${d.level.nextXp} for level ${build.level + 1}` : 'max level'}</span>
          </div>
        )}
      </header>
      <Warnings derived={d} />

      {/* ---- the Stance switcher */}
      {stanceTabs.length > 0 && (
        <nav className="flex gap-2 overflow-x-auto pb-1" aria-label={d.type.assemble ? 'Forms and Styles' : 'Stances'}>
          {stanceTabs.map((t) => {
            const on = current?.key === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setPicked(t.key)}
                aria-pressed={on}
                className={`min-w-52 shrink-0 panel-cut-sm border px-3 py-2 text-left transition ${on ? 'border-brand-500 bg-brand-950/50 shadow-[0_0_12px_rgba(220,38,38,0.25)]' : 'border-zinc-800 bg-zinc-900/70 hover:border-zinc-600'}`}
              >
                <span className="block font-display text-sm font-bold uppercase tracking-wide text-zinc-100">{t.name}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                  {t.dice && <DiceRow dice={t.dice} />}
                  {t.range && <span className="rounded-sm bg-sky-950/60 px-1.5 py-0.5 font-semibold text-sky-200">{rangeText(t.range)}</span>}
                </span>
              </button>
            );
          })}
        </nav>
      )}

      {/* ---- three columns */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] 2xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
        {column(
          'Choices',
          'text-zinc-200',
          <>
            {choice('type', 'Type', <p className="text-sm text-zinc-200">{d.type.name} · {d.healthBars} Health Bar{d.healthBars === 1 ? '' : 's'}</p>)}
            {choice(
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
            {choice(
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
                  {d.stances.map((st) => (
                    <li key={st.key} className="text-xs text-zinc-300">
                      <span className="font-semibold text-zinc-100">{st.name}</span> <span className="text-zinc-500">· {name(st.formId)} + {name(st.styleId)}</span>
                    </li>
                  ))}
                </ul>
              )
            )}
            {choice('build', 'Build', <p className="text-sm text-zinc-200">{d.build.buildId ? name(d.build.buildId) : '—'}</p>)}
            {skillsOn && choice('skills', 'Skills', <p className="text-sm text-zinc-200">{[...d.skillIds.map(name), d.customSkill].filter(Boolean).join(' · ') || '—'}</p>)}
            {choice(
              'level',
              'Level & advancement',
              <div className="space-y-1 text-xs text-zinc-300">
                <p>
                  Level {d.level.level} · {d.level.bonusDie ? `bonus d${d.level.bonusDie.sides}` : 'no bonus die'} · +{d.level.bonusHpPerBar} HP per bar
                </p>
                {d.level.grants.length > 0 && <p className="text-zinc-500">{d.level.grants.map((g) => `L${g.level}: ${grantText(g, idx)}`).join(' · ')}</p>}
              </div>
            )}
            {d.level.xpLevel != null && <XpTracker build={build} level={d.level} canEdit={canEdit} save={save} idx={idx} />}
            <HitSpends build={build} isNpc={isNpc} canEdit={canEdit} save={save} />
            {canEdit && (
              <button type="button" onClick={() => window.confirm('Delete this build and start over?') && socket.emit('build:clear', { characterId })} className="text-xs text-red-500 hover:text-red-400">
                Delete build
              </button>
            )}
          </>
        )}
        {column('Active Abilities', 'text-purple-200', <AbilitiesColumn d={d} idx={idx} current={current} />)}
        {column('Actions', 'text-emerald-200', <ActionsColumn d={d} idx={idx} current={current} />, 'lg:col-span-2 2xl:col-span-1')}
      </div>
    </div>
  );
}

// Every Ability in force, in one place: always on, Frantic, then the shown Stance's.
function AbilitiesColumn({ d, idx, current }) {
  const groups = [
    { key: 'always', title: 'Always in effect', ids: d.constantAbilityIds },
    ...(d.franticAbilityIds?.length ? [{ key: 'frantic', title: 'Frantic Abilities (one each turn)', ids: d.franticAbilityIds }] : []),
    ...(current ? [{ key: current.key, title: `In ${current.name}`, ids: current.abilityIds }] : []),
  ].filter((g) => g.ids.length);
  if (!groups.length) return <p className="text-xs italic text-zinc-600">No Abilities yet.</p>;
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <div key={g.key} className="space-y-1.5">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{g.title}</p>
          <ul className="space-y-1.5">
            {g.ids.map((id) => (
              <RulesEntry key={id} entry={idx.get(id)} kind="Ability" />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// The Actions: Personal (always available + the shown Stance's), Super Moves, then Basic.
function ActionsColumn({ d, idx, current }) {
  const basic = idx.content.basicActionIds ?? [];
  const isBasic = new Set(basic);
  const always = d.constantActionIds.filter((id) => !isBasic.has(id));
  const [showBasic, setShowBasic] = useState(false);
  const group = (title, ids, render = (id) => <ActionCard key={id} action={idx.get(id)} />) =>
    ids.length > 0 && (
      <div className="space-y-1.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{title}</p>
        <div className="grid gap-1.5 xl:grid-cols-2 2xl:grid-cols-1">{ids.map(render)}</div>
      </div>
    );
  return (
    <div className="space-y-3">
      {group(current ? `${current.name}` : 'Stance', current?.actionIds ?? [])}
      {group('Always available', always)}
      {group('Super Moves', d.superMoveIds, (id) => <SuperMoveCard key={id} move={idx.get(id)} />)}
      {!always.length && !(current?.actionIds ?? []).length && !d.superMoveIds.length && <p className="text-xs italic text-zinc-600">No Personal Actions yet.</p>}
      <div className="space-y-1.5 border-t border-zinc-800 pt-2">
        <button type="button" onClick={() => setShowBasic((v) => !v)} aria-expanded={showBasic} className="flex w-full items-center justify-between font-display text-[11px] font-bold uppercase tracking-wide text-emerald-300">
          Basic Actions ({basic.length})
          <span className="text-zinc-500">{showBasic ? '−' : '+'}</span>
        </button>
        {showBasic && <div className="grid gap-1.5 xl:grid-cols-2 2xl:grid-cols-1">{basic.map((id) => <ActionCard key={id} action={idx.get(id)} />)}</div>}
      </div>
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
  const skillsOn = useSkillsEnabled();
  const warnings = skillsOn ? derived.warnings : derived.warnings.filter((w) => !isSkillWarning(w));
  if (!warnings.length) return null;
  return (
    <ul className="space-y-0.5 panel-cut-sm border border-amber-600/50 bg-amber-950/30 px-2 py-1.5 text-[11px] text-amber-200">
      {warnings.map((w) => (
        <li key={w}>⚠ {w}</li>
      ))}
    </ul>
  );
}
