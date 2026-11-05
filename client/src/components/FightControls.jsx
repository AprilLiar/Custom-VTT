import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Swords, Users, X } from 'lucide-react';
import { socket } from '../socket.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';
import DialogShell from './DialogShell.jsx';

// A fight's controls (Panic at the Dojo, Phase 5), for whichever fight the
// Scene's mode shows — Simple Combat and Combat are separate fights.
//
//   - StartCombatButton / FightSetupDialog (GM): fighters in the middle column,
//     arrows send them to Allies (left) or Enemies (right); then the side that
//     starts and its opener. Reused to change sides mid-fight.
//   - InitiativeRail: the round's order down the right edge — a portrait in a
//     rectangular frame, then the name — scrolling itself to the current turn.
//     The GM advances turns and ends the fight from it.
//   - StancePrompt: when a fighter with several Stances starts a turn, their
//     player (or the GM, who can always answer) picks one.
//
// `fighters`: [{ key, ref, combatantId, name, image_url, crop, top, turns }]
// — every fighter of this mode, with `top` meaning "show the top of the
// picture" (a full-body Scene Picture rather than a cropped portrait).

function Portrait({ fighter, className }) {
  if (fighter?.image_url) {
    const crop = fighter.crop ? cropOf({ crop_x: fighter.crop.x, crop_y: fighter.crop.y, crop_w: fighter.crop.w, crop_h: fighter.crop.h }) : null;
    return fighter.top ? (
      <img src={fighter.image_url} alt="" className={`object-cover object-top ${className}`} draggable={false} />
    ) : (
      <CroppedImage src={fighter.image_url} crop={crop} alt="" className={className} draggable={false} />
    );
  }
  return (
    <span className={`flex items-center justify-center bg-zinc-800 text-xs font-bold uppercase text-zinc-400 ${className}`}>
      {(fighter?.name ?? '?').slice(0, 1)}
    </span>
  );
}

export function StartCombatButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-2 panel-cut-sm border border-brand-500 bg-brand-600 px-4 py-2 font-display text-sm font-bold uppercase tracking-wide text-white shadow-lg hover:bg-brand-500"
      style={{ zIndex: 1000, marginTop: 'var(--safe-top)' }}
    >
      <Swords size={16} aria-hidden /> Start Combat
    </button>
  );
}

// `existing` (a fight) turns this into the mid-fight sides editor.
export function FightSetupDialog({ mode, fighters, existing = null, onClose }) {
  const [side, setSide] = useState(() => {
    const out = {};
    for (const f of fighters) {
      if (existing?.allies.includes(f.combatantId)) out[f.key] = 'allies';
      else if (existing?.enemies.includes(f.combatantId)) out[f.key] = 'enemies';
      else out[f.key] = null;
    }
    return out;
  });
  const [firstSide, setFirstSide] = useState('allies');
  const [opener, setOpener] = useState('');
  const column = (which) => fighters.filter((f) => (side[f.key] ?? null) === which);
  const allies = column('allies');
  const enemies = column('enemies');
  const starters = firstSide === 'allies' ? allies : enemies;
  useEffect(() => {
    if (!starters.some((f) => f.key === opener)) setOpener(starters[0]?.key ?? '');
  }, [starters, opener]);
  const move = (f, to) => setSide((s) => ({ ...s, [f.key]: to }));

  const submit = () => {
    const refs = (list) => list.map((f) => f.ref);
    if (existing) {
      socket.emit('fight:set_sides', { mode, allies: refs(allies), enemies: refs(enemies) });
    } else {
      socket.emit('fight:start', {
        mode,
        allies: refs(allies),
        enemies: refs(enemies),
        firstSide,
        opener: fighters.find((f) => f.key === opener)?.ref ?? null,
      });
    }
    onClose();
  };

  const Card = ({ f }) => {
    const where = side[f.key] ?? null;
    return (
      <li className="flex items-center gap-1.5 panel-cut-sm border border-zinc-800 bg-zinc-900 p-1">
        {where === 'enemies' && (
          <button type="button" onClick={() => move(f, null)} className="p-1 text-zinc-400 hover:text-zinc-100" aria-label={`Unassign ${f.name}`}>
            <ArrowLeft size={14} aria-hidden />
          </button>
        )}
        {where === null && (
          <button type="button" onClick={() => move(f, 'allies')} className="p-1 text-sky-400 hover:text-sky-200" aria-label={`${f.name} to Allies`}>
            <ArrowLeft size={14} aria-hidden />
          </button>
        )}
        <Portrait fighter={f} className="h-8 w-8 shrink-0 panel-cut-sm" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-100">
          {f.name} <span className="text-zinc-500">×{f.turns}</span>
        </span>
        {where === null && (
          <button type="button" onClick={() => move(f, 'enemies')} className="p-1 text-red-400 hover:text-red-200" aria-label={`${f.name} to Enemies`}>
            <ArrowRight size={14} aria-hidden />
          </button>
        )}
        {where === 'allies' && (
          <button type="button" onClick={() => move(f, null)} className="p-1 text-zinc-400 hover:text-zinc-100" aria-label={`Unassign ${f.name}`}>
            <ArrowRight size={14} aria-hidden />
          </button>
        )}
      </li>
    );
  };
  const Column = ({ title, list, tone }) => (
    <div className="flex min-w-0 flex-1 flex-col">
      <h3 className={`mb-1 font-display text-xs font-bold uppercase tracking-wide ${tone}`}>
        {title} <span className="text-zinc-500">({list.reduce((n, f) => n + f.turns, 0)} turns)</span>
      </h3>
      <ul className="min-h-24 space-y-1 panel-cut-sm border border-zinc-800 bg-zinc-950/60 p-1">
        {list.map((f) => (
          <Card key={f.key} f={f} />
        ))}
      </ul>
    </div>
  );

  return (
    <DialogShell title={existing ? 'Change sides' : 'Start Combat'} onClose={onClose} maxWidth="max-w-3xl" portal>
      <p className="mb-2 text-xs text-zinc-500">
        Send each fighter to Allies or Enemies. "×N" is how many HP bars they have — one turn each per round.
        {existing && ' Changes take effect from the next round.'}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Column title="Allies" list={allies} tone="text-sky-300" />
        <Column title="Fighters" list={column(null)} tone="text-zinc-300" />
        <Column title="Enemies" list={enemies} tone="text-red-300" />
      </div>
      {!existing && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Who starts?</span>
          {['allies', 'enemies'].map((s) => (
            <label key={s} className="flex items-center gap-1 text-sm capitalize text-zinc-200">
              <input type="radio" name="first-side" checked={firstSide === s} onChange={() => setFirstSide(s)} className="accent-brand-500" />
              {s}
            </label>
          ))}
          <select
            value={opener}
            onChange={(e) => setOpener(e.target.value)}
            aria-label="Opening fighter"
            className="min-h-9 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 text-sm outline-none focus:border-brand-500"
          >
            {starters.length === 0 && <option value="">Nobody on that side</option>}
            {starters.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={existing ? false : !(allies.length + enemies.length) || !opener}
        className="mt-3 min-h-11 w-full panel-cut-sm bg-brand-600 px-3 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
      >
        {existing ? 'Save sides' : 'Start Combat'}
      </button>
    </DialogShell>
  );
}

// Top-left (decided: clear of the Scene's chat button and cards, which live
// bottom-right), under the corner buttons — or just right of the GM's left
// drawer while it shows. `left` is set by the page.
export function InitiativeRail({ mode, fight, fighters, role, left = 12, onEditSides, weight = null }) {
  const byCombatant = useMemo(() => new Map(fighters.filter((f) => f.combatantId != null).map((f) => [f.combatantId, f])), [fighters]);
  const currentRef = useRef(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [fight.turn_index, fight.round]);
  const pending = fight.pending_stance;
  return (
    <div
      className="absolute top-16 flex w-48 flex-col panel-cut-sm border border-zinc-700 bg-zinc-950/85 shadow-xl backdrop-blur"
      // Stops above the bottom-left dock, so on a short screen the two never overlap.
      style={{ left, zIndex: 900, maxHeight: 'calc(100% - 140px)', minHeight: 120, marginTop: 'var(--safe-top)', marginLeft: 'var(--safe-left)' }}
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-2 py-1.5">
        <span className="font-display text-xs font-bold uppercase tracking-wide text-zinc-200">Round {fight.round}</span>
        {role === 'gm' && (
          <span className="flex gap-1">
            <button type="button" onClick={onEditSides} title="Change sides" className="p-1 text-zinc-400 hover:text-zinc-100">
              <Users size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => window.confirm('End this fight? HP and tokens stay.') && socket.emit('fight:end', { mode })}
              title="End Combat"
              className="p-1 text-zinc-400 hover:text-red-400"
            >
              <X size={14} aria-hidden />
            </button>
          </span>
        )}
      </div>
      {/* The fight's Cinematic Weight, when the GM has preset one. */}
      {weight && (
        <div className="border-b border-zinc-800 px-2 py-1 font-display text-[10px] uppercase tracking-wide text-zinc-400">
          <span className="font-bold text-purple-300">{weight.name}</span> · Heal {weight.heal} · Bleed {weight.bleed}
        </div>
      )}
      <ol className="flex-1 space-y-1 overflow-y-auto p-1.5">
        {fight.order.map((entry, i) => {
          const f = byCombatant.get(entry.id);
          const current = i === fight.turn_index;
          const done = i < fight.turn_index;
          return (
            <li
              key={`${fight.round}-${i}`}
              ref={current ? currentRef : null}
              className={`flex items-center gap-2 panel-cut-sm border p-1 ${
                current ? 'border-yellow-400 bg-yellow-400/10' : 'border-zinc-800 bg-zinc-900/70'
              } ${done ? 'opacity-40' : ''} ${f ? '' : 'opacity-30 line-through'}`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${entry.side === 'allies' ? 'bg-sky-400' : 'bg-red-500'}`} />
              <Portrait fighter={f} className="h-10 w-8 shrink-0 rounded-sm border border-zinc-700" />
              <span className="min-w-0 flex-1 truncate font-display text-xs font-semibold text-zinc-100">{f?.name ?? 'Gone'}</span>
              {current && pending && <span className="text-[9px] uppercase text-yellow-300">stance…</span>}
            </li>
          );
        })}
      </ol>
      {role === 'gm' && (
        <div className="flex border-t border-zinc-800">
          {/* Previous turn (GM): moves the marker back; nothing re-rolls or re-triggers. */}
          <button
            type="button"
            onClick={() => socket.emit('fight:previous', { mode })}
            disabled={fight.round <= 1 && fight.turn_index === 0}
            title="Previous turn"
            aria-label="Previous turn"
            className="flex items-center justify-center border-r border-zinc-800 bg-zinc-900 px-2.5 py-2 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-40"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => socket.emit('fight:next', { mode })}
            className="flex flex-1 items-center justify-center gap-1 bg-brand-600 px-2 py-2 font-display text-xs font-bold uppercase tracking-wide text-white hover:bg-brand-500"
          >
            Next turn <ChevronRight size={14} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

export function StancePrompt({ mode, fight, fighters, role, controls = () => false }) {
  const pending = fight?.pending_stance;
  if (!pending) return null;
  const mine = role === 'gm' || (pending.character_id != null && controls(pending.character_id));
  if (!mine) return null;
  const fighter = fighters.find((f) => f.combatantId === pending.combatant_id);
  if (pending.assemble) return <FranticPick key={pending.combatant_id} mode={mode} name={fighter?.name ?? 'Fighter'} options={pending.assemble} />;
  return (
    <DialogShell title={`${fighter?.name ?? 'Fighter'}: choose a stance`} onClose={() => {}} maxWidth="max-w-sm" portal>
      <p className="mb-2 text-xs text-zinc-500">Only the chosen stance’s dice roll.</p>
      <div className="flex flex-col gap-2">
        {pending.stances.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => socket.emit('fight:choose_stance', { mode, stanceId: s.id })}
            className="min-h-11 panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 font-display text-sm font-semibold uppercase tracking-wide text-zinc-100 hover:border-brand-500 hover:bg-brand-950/40"
          >
            {s.name}
          </button>
        ))}
      </div>
    </DialogShell>
  );
}

// **Frantic Versatility (builder phase 4).** A Frantic Hero assembles this
// turn's Stance: one Form, one Style and one Frantic Ability, none of which
// they used last turn (those are shown struck through and can't be picked).
function FranticPick({ mode, name, options }) {
  const first = (list) => list.find((o) => !o.used)?.id ?? null;
  const [formId, setForm] = useState(() => first(options.forms));
  const [styleId, setStyle] = useState(() => first(options.styles));
  const [abilityId, setAbility] = useState(() => first(options.abilities));
  const part = (title, list, value, set) => (
    <fieldset className="space-y-1">
      <legend className="mb-1 font-display text-[11px] font-bold uppercase tracking-wide text-zinc-400">{title}</legend>
      <div className="flex flex-wrap gap-1.5">
        {list.map((o) => (
          <button
            key={o.id}
            type="button"
            disabled={o.used}
            aria-pressed={value === o.id}
            onClick={() => set(o.id)}
            title={o.used ? 'Used last turn' : undefined}
            className={`min-h-10 panel-cut-sm border px-2.5 text-xs font-semibold ${
              value === o.id ? 'border-brand-500 bg-brand-950/50 text-white' : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500'
            } disabled:cursor-not-allowed disabled:line-through disabled:opacity-40`}
          >
            {o.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
  const ready = formId && styleId && (options.abilities.length === 0 || abilityId);
  return (
    <DialogShell title={`${name}: assemble this turn’s stance`} onClose={() => {}} maxWidth="max-w-md" portal>
      <div className="space-y-3">
        {part('Form', options.forms, formId, setForm)}
        {part('Style', options.styles, styleId, setStyle)}
        {options.abilities.length > 0 && part('Frantic Ability', options.abilities, abilityId, setAbility)}
        <p className="text-[11px] text-zinc-500">Last turn’s picks can’t be used again this turn.</p>
        <button
          type="button"
          disabled={!ready}
          onClick={() => socket.emit('fight:choose_stance', { mode, stanceId: `${formId}+${styleId}`, abilityId: options.abilities.length ? abilityId : null })}
          className="min-h-11 w-full panel-cut-sm bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-40"
        >
          Roll this stance
        </button>
      </div>
    </DialogShell>
  );
}

// **Turn-trigger prompts (builder phase 3).** A start/end-of-turn ability's
// choice or targets, asked of whoever controls that fighter and of the GM;
// the first answer wins (server/triggers.js). Several queue one at a time.
export function TriggerPrompts() {
  const [prompts, setPrompts] = useState([]);
  useEffect(() => {
    const onPrompt = (p) => setPrompts((list) => (list.some((x) => x.id === p.id) ? list : [...list, p]));
    const onResolved = ({ id }) => setPrompts((list) => list.filter((x) => x.id !== id));
    socket.on('trigger:prompt', onPrompt);
    socket.on('trigger:resolved', onResolved);
    return () => {
      socket.off('trigger:prompt', onPrompt);
      socket.off('trigger:resolved', onResolved);
    };
  }, []);
  const p = prompts[0];
  if (!p) return null;
  return <TriggerPromptDialog key={p.id} prompt={p} />;
}

function TriggerPromptDialog({ prompt }) {
  const [picked, setPicked] = useState([]);
  const answer = (value) => socket.emit('trigger:answer', { id: prompt.id, answer: value });
  const button =
    'min-h-11 panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 font-display text-sm font-semibold uppercase tracking-wide text-zinc-100 hover:border-brand-500 hover:bg-brand-950/40';
  const options = prompt.options ?? [];
  // A pick of several (targets, or "choose one or both").
  const multi = prompt.kind === 'targets' || (prompt.kind === 'choose' && prompt.maximum > 1);
  return (
    <DialogShell title={`${prompt.fighterName}: ${prompt.title}`} onClose={() => {}} maxWidth="max-w-sm" portal>
      {prompt.text && <p className="mb-3 whitespace-pre-line text-xs text-zinc-400">{prompt.text}</p>}
      {prompt.kind === 'confirm' && (
        <div className="flex gap-2">
          <button type="button" onClick={() => answer(true)} className={`${button} flex-1`}>
            Yes
          </button>
          <button type="button" onClick={() => answer(false)} className={`${button} flex-1`}>
            No
          </button>
        </div>
      )}
      {prompt.kind === 'choose' && !multi && (
        <div className="flex flex-col gap-2">
          {options.map((o) => (
            <button key={o.id} type="button" onClick={() => answer(o.id)} className={button}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {multi && (
        <div className="space-y-2">
          <p className="text-[11px] text-zinc-500">
            Choose {prompt.minimum === prompt.maximum ? prompt.maximum : `${prompt.minimum}–${prompt.maximum}`}.
          </p>
          <div className="flex flex-col gap-1.5">
            {options.map((o) => {
              const on = picked.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setPicked((list) => (on ? list.filter((v) => v !== o.id) : list.length < prompt.maximum ? [...list, o.id] : list))
                  }
                  className={`${button} ${on ? 'border-brand-500 bg-brand-950/50' : ''}`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={picked.length < prompt.minimum}
              onClick={() => answer(picked)}
              className="min-h-10 flex-1 panel-cut-sm bg-brand-600 px-3 text-sm font-semibold text-white hover:bg-brand-500 disabled:opacity-40"
            >
              Confirm
            </button>
            {prompt.minimum === 0 && (
              <button type="button" onClick={() => answer([])} className="min-h-10 panel-cut-sm border border-zinc-700 px-3 text-sm text-zinc-300">
                Skip
              </button>
            )}
          </div>
        </div>
      )}
    </DialogShell>
  );
}
