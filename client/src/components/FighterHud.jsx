import { useEffect } from 'react';
import { motion, useAnimation, useReducedMotion } from 'framer-motion';
import { socket } from '../socket.js';
import { portraitSrc } from '../lib/image.js';
import { useIsCoarsePointer } from '../lib/useMediaQuery.js';
import PopNumber from './PopNumber.jsx';

// How a fighter's condition is displayed, in one place.
//
// Visual Overhaul (Ink & Impact), Phase V2. Dogfight has no HP bar — a
// fighter's condition IS the eight Stat dice plus the numeric Stamina pool —
// and RoundCutscene had already worked out how to show exactly that, with a
// pip per die that flashes and punches when the die it represents takes a
// hit. The Arena needed the same vocabulary for its new HUD bars, so rather
// than build a second one that would drift, both now import from here.
// Same argument that produced lib/framePhaseColors.js.
//
// Two consumers, two different source shapes: the cutscene feeds normalised
// `{ slotName, size, bonus, status }` reconstructed from its own event
// stream (see fightersFrom in RoundCutscene.jsx), the Arena feeds live
// `characters` rows straight off /api/combat. normaliseDice below is the
// adapter, so StatPip itself only ever knows one shape.

// Head, arms, core, legs — the order a person reads a body in, and the same
// order the cutscene has always used.
export const DIE_ORDER = [
  'Skull',
  'Brain',
  'Left Hand',
  'Right Hand',
  'Body',
  'Stamina',
  'Left Leg',
  'Right Leg',
];

// Slot names shortened for the pip label. Even at four across inside a
// half-width pair panel a pip is only ~95px, and "Right Hand" at that size
// either wraps or ellipses; the compact Uneven Combat variant is tighter
// still. The full name stays in every pip's title tooltip, so the only
// thing given up is characters, not information.
const SLOT_ABBR = {
  'Left Hand': 'L Hand',
  'Right Hand': 'R Hand',
  'Left Leg': 'L Leg',
  'Right Leg': 'R Leg',
  Stamina: 'Stam',
};

// Live DB die rows (`slot_name`/`current_size`) -> the pip shape.
export function normaliseDice(dice) {
  return [...(dice ?? [])]
    .map((d) => ({
      slotName: d.slot_name,
      size: d.current_size,
      bonus: d.bonus,
      status: d.status,
    }))
    .sort((a, b) => DIE_ORDER.indexOf(a.slotName) - DIE_ORDER.indexOf(b.slotName));
}

// One Stat die. `hit` marks the die that just took damage; `beat` is the
// playback beat it happened on, and exists purely to re-key the animation so
// two hits on the same die in one round both play instead of the second
// being swallowed as "no prop changed".
export function StatPip({ die, hit, beat, compact = false }) {
  const reduceMotion = useReducedMotion();
  const out = die.status === 'incapacitated';
  const controls = useAnimation();
  useEffect(() => {
    if (!hit || reduceMotion) return;
    controls.set({ scale: 1 });
    controls.start({
      scale: [1, 1.45, 0.92, 1],
      transition: { duration: 0.6, times: [0, 0.2, 0.6, 1], ease: 'easeOut' },
    });
  }, [hit, beat, controls, reduceMotion]);
  return (
    <motion.div
      animate={controls}
      title={`${die.slotName} — d${die.size}${die.bonus ? `+${die.bonus}` : ''}${out ? ' (out)' : ''}`}
      className={`flex min-w-0 flex-col items-center gap-0.5 border px-1 ${compact ? 'py-0' : 'py-0.5'} ${
        hit
          ? 'border-rose-400 bg-rose-900/50 shadow-[0_0_12px_2px_rgba(251,113,133,0.6)]'
          : out
            ? 'border-zinc-800 bg-zinc-900/60'
            : 'border-zinc-700 bg-zinc-900'
      }`}
    >
      {/* w-full is load-bearing: `truncate` only clips against a bounded
          width, and a flex column's centred child sizes to max-content, so
          without it a long slot name overflows the pip and collides with
          its neighbour's border instead of ellipsing. */}
      <span
        className={`w-full truncate text-center font-display text-[9px] uppercase tracking-wide ${
          compact ? '' : 'md:text-[10px]'
        } ${hit ? 'text-rose-200' : out ? 'text-zinc-600' : 'text-zinc-500'}`}
      >
        {SLOT_ABBR[die.slotName] ?? die.slotName}
      </span>
      <span
        className={`font-display font-bold ${compact ? 'text-[11px]' : 'text-xs md:text-sm'} ${
          out ? 'text-zinc-600 line-through' : hit ? 'text-rose-200' : 'text-zinc-200'
        }`}
      >
        {out ? 'OUT' : `d${die.size}${die.bonus ? `+${die.bonus}` : ''}`}
      </span>
    </motion.div>
  );
}

// The cutscene's own fighter card. Unchanged from where it used to live in
// RoundCutscene.jsx — moved, not redesigned, so a replay recorded before
// this refactor still reads identically.
export function FighterCard({ fighter, lastHit, beat }) {
  const hitSlot = lastHit?.characterId === fighter.characterId ? lastHit.slotName : null;
  return (
    <div className="panel-cut-sm min-w-0 flex-1 border border-zinc-800 bg-zinc-950/70 p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-zinc-700 bg-zinc-800 font-display text-sm text-zinc-300">
          {(fighter.name ?? '?').charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate font-display text-sm uppercase tracking-wide text-zinc-200 md:text-base">
          {fighter.name}
        </span>
        <span className="shrink-0 font-display text-xs text-amber-300 md:text-sm">
          {fighter.currentStamina}/{fighter.maxStamina} ST
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {fighter.dice.map((d) => (
          <StatPip key={d.slotName} die={d} hit={hitSlot === d.slotName} beat={beat} />
        ))}
      </div>
    </div>
  );
}

// The Stamina bar. A real depleting bar rather than a number, because it is
// the one Dogfight resource that behaves like a fighting game's health bar —
// it drains as you commit to moves and comes back when you don't.
//
// The pending-cost preview is drawn as a distinct segment at the leading
// edge rather than by just moving the fill: while a side is still declaring,
// the spend has NOT happened yet (current_stamina is untouched server-side
// until Done Declaring), and showing it as already gone would be a lie about
// game state. Red for a spend, emerald for a restoring move — the same two
// colours this preview has always used.
function StaminaBar({ current, max, pending, mirrored }) {
  const safeMax = Math.max(1, max || 1);
  const after = Math.max(0, Math.min(safeMax, current - pending));
  const settled = Math.max(0, Math.min(current, after));
  const settledPct = (settled / safeMax) * 100;
  const pendingPct = (Math.abs(after - settled) / safeMax) * 100;
  const restoring = pending < 0;
  return (
    <div className="w-full">
      <div
        className={`flex h-2.5 w-full overflow-hidden border border-zinc-700 bg-zinc-950 ${
          mirrored ? 'flex-row-reverse' : ''
        }`}
      >
        <div
          className="bg-gradient-to-b from-amber-300 to-amber-500 transition-[width] duration-300"
          style={{ width: `${settledPct}%` }}
        />
        {pending !== 0 && (
          <div
            className={`transition-[width] duration-300 ${
              restoring ? 'bg-emerald-500/70' : 'bg-red-600/70'
            }`}
            style={{ width: `${pendingPct}%` }}
          />
        )}
      </div>
      <div
        className={`mt-0.5 flex items-baseline gap-1 font-display text-[11px] ${
          mirrored ? 'flex-row-reverse' : ''
        }`}
      >
        <span className="uppercase tracking-wide text-zinc-500">Stamina</span>
        <span
          className={
            pending === 0 ? 'text-amber-300' : restoring ? 'text-emerald-400' : 'text-red-400'
          }
          title={
            pending !== 0
              ? `Pending, not yet confirmed: ${pending > 0 ? '-' : '+'}${Math.abs(pending)} Stamina`
              : undefined
          }
        >
          {pending !== 0 ? after : <PopNumber value={current} />}
        </span>
        <span className="text-zinc-600">/ {max}</span>
      </div>
    </div>
  );
}

function ReasonsToFight({ characterId, value, mirrored }) {
  return (
    <div
      className={`flex items-center gap-1 text-[11px] text-zinc-500 ${
        mirrored ? 'flex-row-reverse' : ''
      }`}
      title="Reasons to Fight: +1 to all rolls per point, during combat"
    >
      <span className="shrink-0 font-display uppercase tracking-wide">Reasons</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          socket.emit('combat:adjust_reasons_to_fight', { characterId, delta: -1 });
        }}
        disabled={value <= 0}
        className="px-1 leading-none text-red-400 hover:bg-zinc-800 disabled:opacity-30"
      >
        ▼
      </button>
      <span className="w-3 text-center font-mono font-semibold text-zinc-200">{value}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          socket.emit('combat:adjust_reasons_to_fight', { characterId, delta: 1 });
        }}
        disabled={value >= 3}
        className="px-1 leading-none text-green-400 hover:bg-zinc-800 disabled:opacity-30"
      >
        ▲
      </button>
    </div>
  );
}

// The Arena's fighter HUD bar — the layout every fighting game uses, read
// inward from each corner: portrait, name plate, Stamina bar, Stat pips.
// `mirrored` flips the whole thing for the right-hand side.
//
// This replaces the horizontal ParticipantCard, and deliberately keeps every
// one of its behaviours: draggable to re-seat, click-through to the full
// sheet, and the GM's hover cluster (move seat / ad-hoc damage / remove).
// None of that is visual, so none of it was up for redesign here.
export function FighterHudBar({
  entry,
  participant,
  role,
  mirrored = false,
  compact = false,
  onRemove,
  onAdHocDamage,
  onMoveSeat,
  onDragStart,
  navigate,
  declaredMoves,
  sideStillDeclaring,
}) {
  const { character, dice, stances } = entry;
  // On a touch device the GM cluster is always visible — index.css's
  // `.hover-only-action` rule under `(pointer: coarse)` makes it so, because
  // a hover-only affordance is unreachable there. It is absolutely
  // positioned, so without reserving room it sits on top of the fighter's
  // name. Desktop keeps the full width: the buttons are invisible until
  // hover, so padding for them would just be a permanent gap.
  const coarse = useIsCoarsePointer();
  const src = portraitSrc(character);
  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  const pips = normaliseDice(dice);

  // Would-be Stamina after every move declared this window, purely a visual
  // preview — the real current_stamina isn't touched until this character
  // finishes declaring (see combat:character_done_declaring server-side).
  // staminaCost only ever rides a declaredMoves entry this client is
  // entitled to see (mapDeclaredMovesForViewer server-side), so an
  // opponent's pending cost stays exactly as hidden as the move's identity.
  const pendingCost = sideStillDeclaring
    ? (declaredMoves ?? [])
        .filter(
          (dm) => dm.characterId === character.id && dm.staminaCost != null && !dm.staminaCommitted
        )
        .reduce((sum, dm) => sum + dm.staminaCost, 0)
    : 0;

  // Width-only plus self-stretch, so the portrait is a full-height slab
  // down the bar's outer edge rather than a square floating in a taller
  // panel — the same edge-to-edge treatment the card it replaces used.
  const portraitSize = compact ? 'w-14 self-stretch' : 'w-20 self-stretch sm:w-24';

  // The pair drop zone is a column, so a `flex-1` here would mean "grow
  // vertically": a side with one fighter facing a side with two stretched
  // its lone bar to match, spreading name, Stamina and pips apart with dead
  // space between them. Bars size to content and stack from the top.
  return (
    <div
      draggable={role === 'gm'}
      onDragStart={onDragStart}
      onClick={() => navigate(`/character/${character.id}`)}
      title="Open full sheet"
      className={`group relative flex w-full min-w-0 shrink-0 cursor-pointer items-stretch gap-2 ink-panel-wide bg-zinc-900/80 p-2 transition-colors ${
        mirrored ? 'flex-row-reverse' : ''
      }`}
    >
      {role === 'gm' && (
        <div
          className={`hover-only-action absolute top-1 z-10 flex gap-1 opacity-0 transition group-hover:opacity-100 ${
            mirrored ? 'left-1' : 'right-1'
          }`}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveSeat(character.id, character.name);
            }}
            title="Move seat"
            className="flex h-8 w-8 items-center justify-center panel-cut-sm bg-zinc-900/90 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-brand-300"
          >
            ⇄
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAdHocDamage(character.id);
            }}
            title="Apply damage (ad-hoc)"
            className="flex h-8 w-8 items-center justify-center panel-cut-sm bg-zinc-900/90 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-300"
          >
            ✚
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove(character.id);
            }}
            title="Remove from arena"
            className="flex h-8 w-8 items-center justify-center panel-cut-sm bg-zinc-900/90 text-xs text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      )}

      {src ? (
        <img
          src={src}
          alt=""
          className={`${portraitSize} min-h-0 shrink-0 border border-zinc-700 object-cover`}
        />
      ) : (
        <div
          className={`${portraitSize} flex min-h-0 shrink-0 items-center justify-center border border-zinc-700 bg-zinc-800 font-impact text-3xl text-zinc-600`}
        >
          {character.name.slice(0, 1).toUpperCase()}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col justify-start gap-1">
        <div
          className={`flex min-w-0 items-center gap-2 ${mirrored ? 'flex-row-reverse' : ''} ${
            coarse && role === 'gm' ? (mirrored ? 'pl-24' : 'pr-24') : ''
          }`}
        >
          <span
            className={`min-w-0 truncate font-impact uppercase leading-none tracking-wide text-zinc-100 ${
              compact ? 'text-base' : 'text-xl sm:text-2xl'
            }`}
          >
            {character.name}
          </span>
          {character.character_type === 'npc' && (
            <span className="shrink-0 panel-cut-sm bg-purple-600/30 px-1 text-[10px] font-bold uppercase text-purple-300">
              NPC
            </span>
          )}
          {activeStance && (
            <span
              className="min-w-0 shrink truncate font-display text-[11px] uppercase tracking-wide text-brand-300"
              title="Active stance"
            >
              {activeStance.name}
            </span>
          )}
        </div>

        <StaminaBar
          current={character.current_stamina}
          max={character.max_stamina}
          pending={pendingCost}
          mirrored={mirrored}
        />

        <ReasonsToFight
          characterId={character.id}
          value={participant?.reasons_to_fight ?? 0}
          mirrored={mirrored}
        />

        {/* Four across, two rows — not all eight in one row. A single row
            leaves ~50px a pip inside a half-width pair panel, which is too
            narrow for any slot label to survive: full names collided with
            the neighbouring border, and abbreviating them just moved the
            failure to "S…"/"L …". Two rows is what the space actually
            affords, and it matches the cutscene's own fighter card. */}
        <div className="grid grid-cols-4 gap-1">
          {pips.map((d) => (
            <StatPip key={d.slotName} die={d} compact={compact} />
          ))}
        </div>
      </div>
    </div>
  );
}
