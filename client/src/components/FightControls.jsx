import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Flag, GripVertical, Swords, Users, X } from 'lucide-react';
import { socket } from '../socket.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';
import DialogShell from './DialogShell.jsx';
import { clearSquarePick, setPromptsOpen, setSquarePick, useSquarePick } from '../lib/squarePick.js';
import { startFreeMove, stopFreeMove, undoFreeMove } from '../lib/freeMove.js';
import DiceBoard from './actions/DiceBoard.jsx';
import { ActionCard } from './actions/ActionCards.jsx';
import { useContent } from '../lib/patd/useContent.js';

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
  const [ending, setEnding] = useState(false);
  // **The GM drags the order (decided, batch 5):** by an entry's grip, to any
  // place — the current turn stays put. `drag`: { from, to }.
  const listRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const indexAt = (y) => {
    const items = [...(listRef.current?.children ?? [])];
    let best = items.length - 1;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (y < r.bottom) {
        best = i;
        break;
      }
    }
    return best;
  };
  const gripDown = (e, i) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ from: i, to: i });
  };
  const gripMove = (e) => drag && setDrag((d) => (d ? { ...d, to: indexAt(e.clientY) } : d));
  const gripUp = () => {
    if (drag && drag.to !== drag.from) socket.emit('fight:reorder', { mode, from: drag.from, to: drag.to });
    setDrag(null);
  };
  // While a square is being picked (phase D) the rail fades and lets taps
  // through to the map under it.
  const picking = useSquarePick();
  return (
    <>
    {ending && <EndFightDialog mode={mode} fight={fight} byCombatant={byCombatant} onClose={() => setEnding(false)} />}
    <div
      className={`absolute top-16 flex w-48 flex-col panel-cut-sm border border-zinc-700 bg-zinc-950/85 shadow-xl backdrop-blur transition-opacity ${picking ? 'pointer-events-none opacity-20' : ''}`}
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
              onClick={() => setEnding(true)}
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
      <ol ref={listRef} className="flex-1 space-y-1 overflow-y-auto p-1.5">
        {fight.order.map((entry, i) => {
          const f = byCombatant.get(entry.id);
          const current = i === fight.turn_index;
          const done = i < fight.turn_index;
          const dropHere = drag && drag.to === i && drag.from !== i;
          return (
            <li
              key={`${fight.round}-${i}`}
              ref={current ? currentRef : null}
              data-rail-entry={i}
              className={`flex items-center gap-2 panel-cut-sm border p-1 ${
                current ? 'border-yellow-400 bg-yellow-400/10' : 'border-zinc-800 bg-zinc-900/70'
              } ${done ? 'opacity-40' : ''} ${f ? '' : 'opacity-30 line-through'} ${drag?.from === i ? 'opacity-50 ring-1 ring-brand-400' : ''} ${
                dropHere ? (drag.to > drag.from ? 'border-b-2 border-b-brand-400' : 'border-t-2 border-t-brand-400') : ''
              }`}
            >
              {role === 'gm' && !current && (
                <button
                  type="button"
                  title="Drag to reorder"
                  aria-label="Drag to reorder"
                  data-rail-grip={i}
                  onPointerDown={(e) => gripDown(e, i)}
                  onPointerMove={gripMove}
                  onPointerUp={gripUp}
                  onPointerCancel={() => setDrag(null)}
                  className="-ml-0.5 shrink-0 cursor-grab touch-none text-zinc-600 hover:text-zinc-300"
                >
                  <GripVertical size={12} aria-hidden />
                </button>
              )}
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
    </>
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

// **End Combat (GM, decided):** who won — Victory XP (+2) for the winning
// side, Defeat XP (+1) for the losing one, on hero builds — or Skip, when the
// fight ended mechanically but the story goes on. HP and tokens stay.
function EndFightDialog({ mode, fight, byCombatant, onClose }) {
  const names = (ids) => [...new Set((ids ?? []).map((id) => byCombatant.get(id)?.name).filter(Boolean))].join(', ') || '—';
  const end = (outcome) => {
    socket.emit('fight:end', { mode, outcome });
    onClose();
  };
  const btn = 'min-h-11 w-full panel-cut-sm border px-3 text-left text-sm';
  return (
    <DialogShell title="End Combat" onClose={onClose} maxWidth="max-w-sm" portal>
      <p className="mb-3 text-xs text-zinc-500">HP and tokens stay. Who won? The winners get Victory XP (+2), the losers Defeat XP (+1) — heroes only.</p>
      <div className="flex flex-col gap-2">
        <button type="button" onClick={() => end('allies')} className={`${btn} border-emerald-600 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-900/40`}>
          <span className="block font-display font-bold uppercase tracking-wide">Allies won</span>
          <span className="block text-[11px] text-zinc-400">{names(fight.allies)}</span>
        </button>
        <button type="button" onClick={() => end('enemies')} className={`${btn} border-red-600 bg-red-950/30 text-red-100 hover:bg-red-900/40`}>
          <span className="block font-display font-bold uppercase tracking-wide">Enemies won</span>
          <span className="block text-[11px] text-zinc-400">{names(fight.enemies)}</span>
        </button>
        <button type="button" onClick={() => end('skip')} className={`${btn} border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500`}>
          <span className="block font-display font-bold uppercase tracking-wide">Skip — no XP</span>
          <span className="block text-[11px] text-zinc-500">The fight ended mechanically, but the story goes on.</span>
        </button>
        <button type="button" onClick={onClose} className="mt-1 text-xs text-zinc-500 hover:text-zinc-300">
          Cancel — keep fighting
        </button>
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
  // While any is open, no token menu opens (batch 3).
  useEffect(() => {
    setPromptsOpen(prompts.length);
  }, [prompts.length]);
  useEffect(() => () => setPromptsOpen(0), []);
  const p = prompts[0];
  if (!p) return null;
  if (p.kind === 'square') return <SquarePromptBar key={p.id} prompt={p} />;
  // **Targets on the board (decided, batch 3):** when the targets stand on
  // the board, they're tapped there — no list.
  if (p.kind === 'targets' && p.mode && (p.options ?? []).some((o) => o.col != null)) return <TargetPromptBar key={p.id} prompt={p} />;
  // "Perform an Action" (Remember Your Training …): the Actions as cards (play feedback 7).
  if (p.kind === 'choose' && p.display === 'actions' && !(p.maximum > 1)) return <ActionPickDialog key={p.id} prompt={p} />;
  return <TriggerPromptDialog key={p.id} prompt={p} />;
}

// **Picking an Action to perform (play feedback 7):** every Action on offer
// as its card, like the Interrupt board, so what each does can be read, with
// the Gates the number it's performed at reaches lit (Remember Your Training:
// 4); a tap on a card performs it.
function ActionPickDialog({ prompt }) {
  const idx = useContent();
  const answer = (value) => socket.emit('trigger:answer', { id: prompt.id, answer: value });
  const options = prompt.options ?? [];
  return (
    <DialogShell title={`${prompt.fighterName}: ${prompt.title}`} onClose={() => {}} maxWidth="max-w-3xl" portal zIndex={3100}>
      {prompt.when && <p className="mb-1 font-display text-[10px] font-bold uppercase tracking-wide text-amber-300">{prompt.when}</p>}
      {prompt.text && (
        <p className="mb-3 whitespace-pre-line text-xs text-zinc-400">
          {prompt.text} {prompt.rating != null ? `Performed at ${prompt.rating}: the Gates it reaches are lit. ` : ''}Tap a card to perform it.
        </p>
      )}
      <div className="grid max-h-[65vh] grid-cols-1 gap-3 overflow-y-auto p-1.5 sm:grid-cols-2">
        {options.map((o) => {
          const action = idx?.get?.(o.id);
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => answer(o.id)}
              className="block w-full text-left transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
              title={`Perform ${o.label}`}
            >
              {action ? (
                <ActionCard action={action} compact lit={prompt.rating != null ? [prompt.rating] : null} />
              ) : (
                <span className="flex min-h-11 items-center panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 font-display text-sm font-semibold uppercase text-zinc-100">{o.label}</span>
              )}
            </button>
          );
        })}
      </div>
      {prompt.skippable && (
        <button type="button" onClick={() => answer('__skip')} className="mt-3 min-h-11 w-full panel-cut-sm border border-zinc-700 bg-zinc-900 font-display text-sm font-semibold uppercase text-zinc-300 hover:border-brand-500">
          Skip
        </button>
      )}
    </DialogShell>
  );
}

// **Picking targets on the board (decided, batch 3).** The Range shows faint
// red, each legal target brighter red; a tap picks it, as if from the list.
// One target: the tap answers. Several: taps toggle, then Done. Targets not on
// the board (none usually) are buttons in the bar. A required one (the
// Challenger) starts picked and stays.
function TargetPromptBar({ prompt }) {
  const required = useMemo(() => (prompt.required ?? []).map(String), [prompt.required]);
  const single = (prompt.maximum ?? 1) === 1 && !required.length;
  const [chosen, setChosen] = useState(required);
  const answer = (value) => socket.emit('trigger:answer', { id: prompt.id, answer: value });
  const toggle = (id) => {
    if (single) return answer([id]);
    setChosen((list) => (list.includes(id) ? (required.includes(id) ? list : list.filter((x) => x !== id)) : list.length >= (prompt.maximum ?? 1) ? list : [...list, id]));
  };
  const onBoard = (prompt.options ?? []).filter((o) => o.col != null);
  const offBoard = (prompt.options ?? []).filter((o) => o.col == null);
  useEffect(() => {
    setSquarePick({
      key: prompt.id,
      tone: 'target',
      mode: prompt.mode,
      title: prompt.title,
      area: prompt.area ?? [],
      options: onBoard.map((o) => ({ ...o, selected: chosen.includes(o.id) })),
      onPick: toggle,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.id, chosen]);
  useEffect(() => () => clearSquarePick(prompt.id), [prompt.id]);
  const min = Math.max(prompt.minimum ?? 0, required.length);
  return (
    <div className={`${topBarShell} max-w-md border-red-500`} style={{ zIndex: 3100, ...topStyle }} role="dialog" aria-label={`${prompt.fighterName}: ${prompt.title}`}>
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-display text-xs font-bold uppercase tracking-wide text-red-200" title={prompt.text}>
          {prompt.title} · {single ? 'tap a target' : `${chosen.length}/${prompt.maximum} picked`}
        </p>
        {!single && (
          <button
            type="button"
            disabled={chosen.length < min}
            onClick={() => answer(chosen)}
            className="min-h-7 shrink-0 panel-cut-sm border border-red-400 bg-red-500/20 px-2 font-display text-[11px] font-bold uppercase text-red-100 disabled:opacity-40"
          >
            Done
          </button>
        )}
        {/* Skip (decided, batch 4): an attack or any targeted effect may be declined. */}
        {(min === 0 || prompt.skippable) && (
          <button type="button" onClick={() => answer(prompt.skippable ? ['__skip'] : [])} className="min-h-7 shrink-0 panel-cut-sm border border-zinc-700 px-2 text-[11px] text-zinc-300 hover:border-red-400">
            Skip
          </button>
        )}
      </div>
      {offBoard.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {offBoard.map((o) => (
            <button key={o.id} type="button" onClick={() => toggle(o.id)} className={`${barButton} ${chosen.includes(o.id) ? 'border-red-400 bg-red-500/20' : ''}`}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// **A square pick (phase D; revised, decided):** the legal squares glow on the
// map or lane (SquarePickLayer) and are picked there — no list of squares.
// A slim bar at the top of the screen says only what is doing it and how:
// "One-Two Form (Move 2)", with Skip when skipping is allowed.
const barShell = 'pointer-events-auto fixed inset-x-2 bottom-2 mx-auto max-w-md panel-cut-sm border bg-zinc-950/95 p-2 shadow-2xl';
// Picking squares happens on the board: those bars sit at the top, out of the way.
const topBarShell = 'pointer-events-auto fixed inset-x-2 mx-auto max-w-md panel-cut-sm border bg-zinc-950/90 px-2 py-1 shadow-xl';
const topStyle = { top: 'max(0.5rem, var(--safe-top, 0px))' };
const barButton = 'min-h-8 panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-left text-xs text-zinc-100 hover:border-lime-400';
function SquarePromptBar({ prompt }) {
  const answer = (value) => socket.emit('trigger:answer', { id: prompt.id, answer: value });
  useEffect(() => {
    setSquarePick({ key: prompt.id, tone: 'pick', mode: prompt.mode, title: prompt.title, options: prompt.options ?? [], onPick: (id) => answer(id) });
    return () => clearSquarePick(prompt.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.id]);
  return (
    <div
      className={`${topBarShell} flex max-w-sm items-center gap-2 border-lime-600`}
      style={{ zIndex: 3100, ...topStyle }}
      role="dialog"
      aria-label={`${prompt.fighterName}: ${prompt.title}`}
    >
      <p className="min-w-0 flex-1 truncate font-display text-xs font-bold uppercase tracking-wide text-lime-200">{prompt.title}</p>
      {/* Skip (decided, batch 4): every movement from an Action or Ability may be declined. */}
      {(prompt.minimum === 0 || prompt.skippable) && (
        <button type="button" onClick={() => answer(prompt.skippable ? ['__skip'] : [])} className="min-h-7 shrink-0 panel-cut-sm border border-zinc-700 px-2 text-[11px] text-zinc-300 hover:border-lime-400">
          Skip
        </button>
      )}
    </div>
  );
}

// **Free Movement in progress (phase D):** the reachable squares glow with
// their Speed cost; this bar says how much Speed is left and ends it.
export function MoveBar() {
  const pick = useSquarePick();
  const [error, setError] = useState(null);
  useEffect(() => setError(null), [pick?.key, pick?.canUndo]);
  if (pick?.tone !== 'move') return null;
  return (
    <div className={`${topBarShell} border-sky-500`} style={{ zIndex: 3050, ...topStyle }} role="dialog" aria-label={pick.title}>
      {/* Slim, at the top (decided): the squares show their own Speed costs. */}
      <div className="flex items-center gap-2">
        {/* The back arrow (decided, batch 3): take back the last move, Speed refunded, until an Action resolves. */}
        {pick.canUndo && (
          <button
            type="button"
            onClick={() => undoFreeMove(setError)}
            title="Take back the last move (Speed refunded)"
            aria-label="Take back the last move"
            className="flex h-7 w-7 shrink-0 items-center justify-center panel-cut-sm border border-sky-400 bg-sky-500/10 text-sky-100 hover:bg-sky-500/30"
          >
            <ArrowLeft size={14} aria-hidden />
          </button>
        )}
        <p className="min-w-0 flex-1 truncate font-display text-xs font-bold uppercase tracking-wide text-sky-200">
          {pick.title} · {pick.speed} Speed
          {pick.fatigued ? ' · Fatigued (2 less)' : ''}
          {!pick.options.length ? ' · nowhere to go' : ''}
        </p>
        <button type="button" onClick={() => stopFreeMove(true)} className="min-h-7 shrink-0 panel-cut-sm border border-sky-400 bg-sky-500/20 px-2 font-display text-[11px] font-bold uppercase text-sky-100">
          Done
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-red-300">Can't take it back: {error}.</p>}
      {pick.swaps.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {pick.swaps.map((a) => (
            <button key={a.id} type="button" onClick={() => socket.emit('move:swap', { combatantId: pick.combatantId, allyId: a.id })} className={barButton}>
              Swap with {a.name} (2 Speed)
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// **The Action button (decided, batch 5).** At the bottom of the screen for
// whoever controls the fighter whose turn it is (the GM: always): it opens
// the turn's dice board — the Actions, the pool, Commit, Move, End turn. The
// Stance roll's dice in the chat no longer open it. After Heroic Spirit it
// belongs to the ally who was given the turn.
export function ActionButton({ fight, mode, controls = () => false }) {
  const pick = useSquarePick();
  const [current, setCurrent] = useState(null); // { payload, characterId }
  const [open, setOpen] = useState(false);
  const turnKey = fight ? `${fight.id ?? ''}:${mode}:${fight.round}:${fight.turn_index}:${fight.pending_stance ? 'p' : ''}` : null;
  useEffect(() => {
    if (!turnKey) {
      setCurrent(null);
      return undefined;
    }
    let alive = true;
    let timer = null;
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(() => socket.emit('board:current', { mode }, (r) => alive && setCurrent(r?.payload ? r : null)), 200);
    };
    load();
    // A new roll, Heroic Spirit, a turn ending: the board changes hands.
    socket.on('dice:marks', load);
    socket.on('fight:turn_ended', load);
    return () => {
      alive = false;
      clearTimeout(timer);
      socket.off('dice:marks', load);
      socket.off('fight:turn_ended', load);
    };
  }, [turnKey, mode]);
  const rollId = current?.payload?.roll_id ?? null;
  const [confirming, setConfirming] = useState(false);
  // The turn moved on: an open board of the old turn closes.
  useEffect(() => {
    setOpen(false);
    setConfirming(false);
  }, [rollId]);
  if (!current || !controls(current.characterId)) return null;
  if (open) return <DiceBoard payload={current.payload} canEdit onClose={() => setOpen(false)} />;
  if (pick || fight?.interrupt?.active) return null;
  const name = current.payload.fighter?.name ?? '';
  const shape = 'pointer-events-auto flex min-h-11 items-center gap-1.5 panel-cut-sm border px-4 font-display text-xs font-bold uppercase tracking-wide shadow-lg backdrop-blur';
  return (
    <div
      className="pointer-events-none fixed left-1/2 flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-end gap-2"
      style={{ zIndex: 2990, bottom: 'max(0.5rem, var(--safe-bottom, 0px))' }}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-action-button
        title={`${name || 'Your'} turn: open the Actions`}
        className={`${shape} min-w-0 border-lime-400 bg-lime-500/25 text-lime-100 hover:bg-lime-500/40`}
      >
        <Swords size={14} className="shrink-0" aria-hidden />
        <span className="truncate">Action · {name}</span>
      </button>
      {/* **End Turn (play feedback 8):** beside Action, only on your own turn, asked first. */}
      <div className="relative shrink-0">
        {confirming && (
          <div className="pointer-events-auto absolute bottom-full right-0 mb-2 w-56 panel-cut-sm border border-red-500/70 bg-zinc-950/95 p-2 shadow-2xl" role="dialog" aria-label="End your turn?">
            <p className="mb-2 text-xs text-zinc-200">End {name ? `${name}’s` : 'your'} turn? Placed Actions that aren’t committed are dropped.</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  socket.emit('board:end_turn', { rollId });
                }}
                className="min-h-11 flex-1 panel-cut-sm border border-red-400 bg-red-600/40 font-display text-xs font-bold uppercase text-red-50 hover:bg-red-600/60"
              >
                End turn
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="min-h-11 flex-1 panel-cut-sm border border-zinc-600 bg-zinc-900 font-display text-xs font-bold uppercase text-zinc-200">
                Keep going
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => setConfirming((v) => !v)}
          data-end-turn-button
          aria-expanded={confirming}
          title="End your turn"
          className={`${shape} border-red-400 bg-red-500/25 text-red-100 hover:bg-red-500/40`}
        >
          <Flag size={14} className="shrink-0" aria-hidden />
          <span>End Turn</span>
        </button>
      </div>
    </div>
  );
}

// An Interrupt board opened from elsewhere (the lock, or `interrupt:open`
// when the stack it waited for finished) shows in InterruptBar.
const interruptBoardListeners = new Set();
const showInterruptBoard = (payload) => interruptBoardListeners.forEach((fn) => fn(payload));

// **Interrupts (decided, revised — replaces the reaction windows):** no
// asking after every Action. Whoever this person controls that can take a
// Reactive Action right now — a token Action they can pay for whose
// conditions allow it now (the Mentor's on an ally's turn …), or a dice
// Action a Chaos token can pay "as if you had spent a 4" — gets an
// **Interrupt** button; it opens their Interrupt board with only those.
// The offers come from the server (`interrupt:offers`), refreshed whenever
// the stage or a board changes.
// `left`: clear of the GM's sidebar (like the initiative rail).
export function InterruptBar({ fight, mode, left = 8 }) {
  const pick = useSquarePick();
  const [offers, setOffers] = useState({});
  const [board, setBoard] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    interruptBoardListeners.add(setBoard);
    return () => interruptBoardListeners.delete(setBoard);
  }, []);
  const fightKey = fight ? `${fight.id ?? ''}:${mode}` : null;
  useEffect(() => {
    if (!fightKey) {
      setOffers({});
      return undefined;
    }
    let alive = true;
    let timer = null;
    const load = () => {
      clearTimeout(timer);
      timer = setTimeout(() => socket.emit('interrupt:offers', { mode }, (r) => alive && setOffers(r?.offers ?? {})), 350);
    };
    load();
    socket.on('stage:updated', load);
    socket.on('dice:marks', load);
    return () => {
      alive = false;
      clearTimeout(timer);
      socket.off('stage:updated', load);
      socket.off('dice:marks', load);
    };
  }, [fightKey, mode]);
  if (board) return <DiceBoard payload={board} canEdit onClose={() => setBoard(null)} />;
  const list = Object.entries(offers).filter(([, o]) => o.mode === mode);
  // Under someone's Interrupt lock, nobody else can press it (decided).
  if (!list.length || pick || fight?.interrupt?.active) return null;
  const waiting = new Set((fight?.interrupt?.queue ?? []).map((q) => String(q.combatantId)));
  // Pressed while an Action resolves: it waits (a ⚡ chip) — see InterruptLock.
  const open = (id) =>
    socket.emit('react:open', { combatantId: Number(id) }, (r) => {
      if (r?.payload) {
        setError(null);
        setBoard(r.payload);
      } else if (r?.queued) setError(null);
      else setError(r?.error ?? 'Could not interrupt');
    });
  return (
    <div className="pointer-events-auto fixed flex max-w-[60vw] flex-col items-start gap-1" style={{ zIndex: 2990, left, bottom: 'max(0.5rem, var(--safe-bottom, 0px))' }} role="group" aria-label="Interrupts">
      {error && <p className="panel-cut-sm bg-zinc-950/90 px-2 py-0.5 text-[10px] text-red-300">{error}</p>}
      {list.map(([id, o]) => (
        <button
          key={id}
          type="button"
          onClick={() => open(id)}
          disabled={waiting.has(id)}
          title={waiting.has(id) ? 'Waiting for the Action resolving now to finish' : o.clusters.map((c) => `${c.label}: ${c.ids.length}`).join(' · ')}
          className="flex min-h-8 max-w-full items-center gap-1 panel-cut-sm border border-fuchsia-400 bg-fuchsia-600/30 px-2 font-display text-[11px] font-bold uppercase tracking-wide text-fuchsia-100 shadow-lg hover:bg-fuchsia-600/50 disabled:opacity-60"
        >
          <span aria-hidden>⚡</span>
          <span className="truncate">{waiting.has(id) ? 'Waiting' : 'Interrupt'} · {o.name}</span>
        </button>
      ))}
    </div>
  );
}

// **The Interrupt lock (decided).** Someone pressed Interrupt: a full-screen
// "<name> is interrupting the current turn" for everyone — nobody can act —
// until they commit their Interrupt board (it then resolves) or give it up.
// The interrupter's own board sits above it. Pressed while an Action is
// resolving, it waits: a small ⚡ chip with the name at the bottom, and the
// lock opens as soon as that stack finishes (`interrupt:open`). The GM can
// lift a stuck lock.
export function InterruptLock({ fight, mode, fighters = [], role, controls = () => false }) {
  const [error, setError] = useState(null);
  const lock = fight?.interrupt ?? null;
  const active = lock?.active ?? null;
  const queue = lock?.queue ?? [];
  useEffect(() => {
    const onOpen = (e) => {
      if (e?.mode === mode && e.by === socket.id && e.payload) showInterruptBoard(e.payload);
    };
    socket.on('interrupt:open', onOpen);
    return () => socket.off('interrupt:open', onOpen);
  }, [mode]);
  useEffect(() => setError(null), [active?.combatantId]);
  if (!active && !queue.length) return null;
  const fighter = active ? fighters.find((f) => f.combatantId === active.combatantId) : null;
  const mine = Boolean(active) && (active.by === socket.id || (role === 'player' && fighter?.characterId != null && controls(fighter.characterId)));
  const openBoard = () =>
    socket.emit('react:open', { combatantId: active.combatantId }, (r) => (r?.payload ? showInterruptBoard(r.payload) : setError(r?.error ?? 'Could not open it')));
  const lockButton = 'min-h-9 panel-cut-sm border px-3 font-display text-xs font-bold uppercase tracking-wide';
  return (
    <>
      {queue.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 flex flex-wrap justify-center gap-1 px-4" style={{ zIndex: 3600, bottom: 'max(0.5rem, var(--safe-bottom, 0px))' }} role="status" aria-label="Waiting to interrupt">
          {queue.map((q) => (
            <span key={q.combatantId} title="Waiting for the Action resolving now to finish" className="flex items-center gap-1 panel-cut-sm border border-fuchsia-400/70 bg-zinc-950/90 px-2 py-0.5 font-display text-[11px] font-bold uppercase tracking-wide text-fuchsia-100 shadow-lg">
              <span aria-hidden>⚡</span>
              {q.name}
            </span>
          ))}
        </div>
      )}
      {active && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" style={{ zIndex: mine ? 2995 : 3500 }} role="alertdialog" aria-modal="true" aria-label={`${active.name} is interrupting the current turn`}>
          <div className="panel-cut w-full max-w-sm border border-fuchsia-400 bg-zinc-950/95 px-6 py-5 text-center shadow-2xl">
            <p className="text-4xl leading-none text-fuchsia-300" aria-hidden>
              ⚡
            </p>
            <p className="mt-2 font-display text-2xl font-bold uppercase tracking-wide text-fuchsia-100">{active.name}</p>
            <p className="text-sm text-zinc-300">is interrupting the current turn</p>
            <p className="mt-1 text-[11px] text-zinc-500">{mine ? 'Place and commit your Interrupt — everyone waits for you.' : 'Everyone waits until the Interrupt is committed.'}</p>
            {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
            {(mine || role === 'gm') && (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={openBoard} className={`${lockButton} border-fuchsia-400 bg-fuchsia-600/30 text-fuchsia-100 hover:bg-fuchsia-600/50`}>
                  Open the Interrupt
                </button>
                {mine ? (
                  <button type="button" onClick={() => socket.emit('react:pass', { combatantId: active.combatantId })} className={`${lockButton} border-zinc-600 text-zinc-200`}>
                    Give it up
                  </button>
                ) : (
                  <button type="button" onClick={() => socket.emit('interrupt:cancel', { mode })} className={`${lockButton} border-zinc-600 text-zinc-300 hover:border-red-500 hover:text-red-300`}>
                    Cancel it
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// **Early / Late Movement (decided, phase D):** the phase waits for everyone
// holding Speed — each moves (Move) or passes (Done); the GM can Skip.
export function MovementPhaseBar({ mode, fight, fighters, role, controls = () => false }) {
  const pick = useSquarePick();
  const phase = fight?.movement_phase;
  if (!phase || pick) return null;
  const byId = new Map(fighters.map((f) => [f.combatantId, f]));
  const waiting = phase.waiting.map((id) => byId.get(id)).filter(Boolean);
  const mine = waiting.filter((f) => role === 'gm' || (f.characterId != null && controls(f.characterId)));
  return (
    <div className={`${barShell} border-sky-700`} style={{ zIndex: 3000 }} role="status" aria-label={`${phase.kind === 'early' ? 'Early' : 'Late'} Movement`}>
      <p className="font-display text-sm font-bold uppercase tracking-wide text-sky-200">{phase.kind === 'early' ? 'Early' : 'Late'} Movement</p>
      <p className="text-[11px] text-zinc-400">Waiting for {waiting.map((f) => f.name).join(', ') || '…'} — Free Movement with Speed, then Done.</p>
      {mine.length > 0 && (
        <ul className="mt-1 space-y-1">
          {mine.map((f) => (
            <li key={f.combatantId} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{f.name}</span>
              <button type="button" onClick={() => startFreeMove({ combatantId: f.combatantId, name: f.name, inPhase: true })} className="min-h-9 panel-cut-sm border border-sky-400 bg-sky-500/20 px-3 font-display text-xs font-bold uppercase text-sky-100">
                Move
              </button>
              <button type="button" onClick={() => socket.emit('move:done', { combatantId: f.combatantId })} className="min-h-9 panel-cut-sm border border-zinc-600 px-3 font-display text-xs font-bold uppercase text-zinc-200">
                Done
              </button>
            </li>
          ))}
        </ul>
      )}
      {role === 'gm' && (
        <button type="button" onClick={() => socket.emit('move:skip', { mode })} className="mt-1 min-h-9 w-full panel-cut-sm border border-zinc-700 px-3 text-xs text-zinc-300">
          Skip this phase
        </button>
      )}
    </div>
  );
}

function TriggerPromptDialog({ prompt }) {
  // Required picks (the Challenger a damaging Action must include) start picked and stay.
  const [picked, setPicked] = useState(() => [...(prompt.required ?? [])]);
  const answer = (value) => socket.emit('trigger:answer', { id: prompt.id, answer: value });
  const button =
    'min-h-11 panel-cut-sm border border-zinc-700 bg-zinc-900 px-3 font-display text-sm font-semibold uppercase tracking-wide text-zinc-100 hover:border-brand-500 hover:bg-brand-950/40';
  const options = prompt.options ?? [];
  // A pick of several (targets, or "choose one or both").
  const multi = prompt.kind === 'targets' || (prompt.kind === 'choose' && prompt.maximum > 1);
  return (
    <DialogShell title={`${prompt.fighterName}: ${prompt.title}`} onClose={() => {}} maxWidth="max-w-sm" portal zIndex={3100}>
      {/* Whose turn this belongs to: it closes when that turn ends. */}
      {prompt.when && <p className="mb-1 font-display text-[10px] font-bold uppercase tracking-wide text-amber-300">{prompt.when}</p>}
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
            Choose {prompt.minimum === prompt.maximum ? prompt.maximum : `${prompt.minimum}–${prompt.maximum}`} ·{' '}
            <span className={picked.length ? 'font-semibold text-brand-300' : ''}>{picked.length} selected</span>
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
                    (prompt.required ?? []).includes(o.id) ||
                    setPicked((list) =>
                      on
                        ? list.filter((v) => v !== o.id)
                        : list.length < prompt.maximum
                          ? [...list, o.id]
                          : // A one-target pick takes the latest tap (decided): it replaces the last choice.
                            prompt.maximum === 1 && !(prompt.required ?? []).length
                            ? [o.id]
                            : list
                    )
                  }
                  // Separate classes per state: mixing them with the base ones let the
                  // base border win, so a pick didn't show.
                  className={`flex min-h-11 items-center gap-2 panel-cut-sm border px-3 text-left font-display text-sm font-semibold uppercase tracking-wide ${
                    on ? 'border-brand-400 bg-brand-600/30 text-white' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[11px] leading-none ${on ? 'border-brand-300 bg-brand-500 text-white' : 'border-zinc-600'}`}
                  >
                    {on ? '✓' : ''}
                  </span>
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
            {(prompt.minimum === 0 || prompt.skippable) && (
              <button type="button" onClick={() => answer(prompt.skippable ? ['__skip'] : [])} className="min-h-10 panel-cut-sm border border-zinc-700 px-3 text-sm text-zinc-300">
                Skip
              </button>
            )}
          </div>
        </div>
      )}
    </DialogShell>
  );
}
