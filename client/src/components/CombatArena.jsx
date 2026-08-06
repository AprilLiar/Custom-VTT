import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import {
  getCombat,
  getCharacters,
  getCharacterFolders,
  getTells,
} from '../lib/api.js';
import { portraitSrc } from '../lib/image.js';
import { dieLabel, tintFor, POOLS } from '../lib/dice.js';
import { buildFolderTree } from '../lib/folders.js';
import { countRollSlot } from '../lib/diceSlots.js';
import { FRAME_PHASES, PHASE_BG, PHASE_LABEL, PHASE_ZONE, phaseBgAt } from '../lib/framePhaseColors.js';
import RoundCutscene from './RoundCutscene.jsx';
import DamageApplicationDialog from './DamageApplicationDialog.jsx';
import { REWARD_LABELS, REWARD_COLORS } from '../lib/counterDisplay.js';
import { setDraggingMove, onDraggingMoveChange } from '../lib/dragMoveState.js';
import { useSocketRefresh } from '../lib/connection.js';
import FrameBar from './FrameBar.jsx';
import Thumb from './Thumb.jsx';
import DropSlamGhost from './DropSlamGhost.jsx';
import PopNumber from './PopNumber.jsx';
import DialogShell from './DialogShell.jsx';

const MIN_TARGET = 2;
const MAX_TARGET = 20;

// Read-only glance at a seated character: portrait, active stance, dice
// pools, stamina — not the full sheet. Click through to the sheet to
// actually roll/step; everything shown here stays live via the same
// character:updated/die:updated/stance:activated broadcasts the sheet
// itself listens to. Stance is shown because it's the one thing the plan
// already calls strategically visible to opponents mid-fight.
function ParticipantCard({
  entry,
  participant,
  role,
  onRemove,
  onAdHocDamage,
  onMoveSeat,
  onDragStart,
  navigate,
  declaredMoves,
  sideStillDeclaring,
}) {
  const { character, dice, stances } = entry;
  const src = portraitSrc(character);
  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  // Would-be Stamina after every move declared this window, purely a
  // visual preview — the real current_stamina isn't touched until this
  // character actually finishes declaring (see
  // combat:character_done_declaring server-side). staminaCost only ever
  // rides a declaredMoves entry this client is actually entitled to see
  // (see mapDeclaredMovesForViewer server-side) — an opponent's pending
  // cost stays exactly as hidden as the move's identity, same secrecy
  // boundary.
  const pendingCost = sideStillDeclaring
    ? declaredMoves
        .filter((dm) => dm.characterId === character.id && dm.staminaCost != null && !dm.staminaCommitted)
        .reduce((sum, dm) => sum + dm.staminaCost, 0)
    : 0;
  const previewStamina = character.current_stamina - pendingCost;
  return (
    <div
      draggable={role === 'gm'}
      onDragStart={onDragStart}
      onClick={() => navigate(`/character/${character.id}`)}
      title="Open full sheet"
      className="group relative flex min-h-40 min-w-64 flex-1 cursor-pointer overflow-hidden panel-cut border border-zinc-800 bg-zinc-900 transition-colors hover:border-brand-600"
    >
      {role === 'gm' && (
        <div className="hover-only-action absolute right-1 top-1 z-10 flex gap-1 opacity-0 transition group-hover:opacity-100">
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
          {/* Combat Automation overhaul §5: in-combat damage is applied by
              the resolution engine now, so DamageApplicationDialog lost its
              old chat-roll-card entry point. It's still the right tool for
              genuinely ad-hoc GM damage outside the automated flow
              (environmental damage, a house rule) — this is that entry
              point, opening it in its unrestricted mode (no attacking
              declared move, so no Attack Target restriction applies). */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAdHocDamage(character.id);
            }}
            title="Apply ad-hoc damage (outside the automated flow)"
            className="flex h-8 w-8 items-center justify-center panel-cut-sm bg-zinc-900/90 text-xs text-zinc-500 hover:bg-red-900/40 hover:text-red-300"
          >
            ⚕
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

      {/* Portrait fills the card's full height edge-to-edge, no padding/gaps */}
      {src ? (
        <img src={src} alt="" className="h-full w-28 shrink-0 object-cover sm:w-32" />
      ) : (
        <div className="flex h-full w-28 shrink-0 items-center justify-center bg-zinc-800 text-3xl font-bold text-zinc-600 sm:w-32">
          {character.name.slice(0, 1).toUpperCase()}
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">{character.name}</div>
          {character.character_type === 'npc' && (
            <span className="panel-cut-sm bg-purple-600/30 px-1 text-[10px] font-bold uppercase text-purple-300">
              NPC
            </span>
          )}
        </div>
        {activeStance && (
          <div className="truncate text-xs text-brand-300" title="Active stance">
            {activeStance.name}
          </div>
        )}
        <div
          className={`text-xs ${
            pendingCost === 0
              ? 'text-zinc-400'
              : pendingCost > 0
                ? 'font-semibold text-red-400'
                : 'font-semibold text-emerald-400'
          }`}
          title={
            pendingCost !== 0
              ? `Pending, not yet confirmed: ${pendingCost > 0 ? '-' : '+'}${Math.abs(pendingCost)} Stamina`
              : undefined
          }
        >
          Stamina {pendingCost !== 0 ? previewStamina : <PopNumber value={character.current_stamina} />}/
          {character.max_stamina}
        </div>
        <div className="flex items-center gap-1 text-xs text-zinc-400" title="Reasons to Fight: +1 to all rolls per point, during combat">
          <span className="shrink-0">Reasons to Fight</span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              socket.emit('combat:adjust_reasons_to_fight', { characterId: character.id, delta: -1 });
            }}
            disabled={(participant?.reasons_to_fight ?? 0) <= 0}
            className="px-1 leading-none text-red-400 hover:bg-zinc-800 disabled:opacity-30"
          >
            ▼
          </button>
          <span className="w-3 text-center font-mono font-semibold text-zinc-200">
            {participant?.reasons_to_fight ?? 0}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              socket.emit('combat:adjust_reasons_to_fight', { characterId: character.id, delta: 1 });
            }}
            disabled={(participant?.reasons_to_fight ?? 0) >= 3}
            className="px-1 leading-none text-green-400 hover:bg-zinc-800 disabled:opacity-30"
          >
            ▲
          </button>
        </div>
        <div className="space-y-1">
          {POOLS.map((pool) => {
            const poolDice = dice.filter((d) => d.pool === pool.key);
            if (!poolDice.length) return null;
            return (
              <div key={pool.key} className="flex flex-wrap gap-1">
                {poolDice.map((d) => (
                  <span
                    key={d.id}
                    title={d.slot_name}
                    className={`panel-cut-sm px-1 py-0.5 text-[10px] font-mono ${
                      d.status === 'incapacitated' ? 'text-zinc-700 line-through' : 'text-zinc-300'
                    }`}
                    style={{ backgroundColor: tintFor(d) || 'rgba(255,255,255,0.05)' }}
                  >
                    {dieLabel(d.current_size, d.bonus)}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// Same pips look as the character sheet's Counters tab, adapted for the
// Arena: standalone counters show just their name, character-owned ones
// show "{CharacterName} - {CounterName}" per the plan's decided labeling.
function ArenaCounterRow({ counter, characterName }) {
  const label = characterName ? `${characterName} - ${counter.name}` : counter.name;
  return (
    <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-3">
      <span className="font-bold text-zinc-100">{label}</span>
      {/* Character-owned counters only ever carry a reward — a standalone
          counter never has one — but this stays read-only display here
          either way; editing it happens on the character's own sheet. */}
      {counter.reward_type && (
        <span
          className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${REWARD_COLORS[counter.reward_type]}`}
        >
          {REWARD_LABELS[counter.reward_type]}
        </span>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: -1 })}
          disabled={counter.current_pips <= 0}
          className="h-11 w-11 shrink-0 panel-cut-sm border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800 disabled:opacity-30 md:h-8 md:w-8"
        >
          −
        </button>
        <div
          className="flex flex-1 flex-wrap items-center justify-center gap-1.5"
          title={`${counter.current_pips} / ${counter.target_pips}`}
        >
          {Array.from({ length: counter.target_pips }, (_, i) => (
            <span
              key={i}
              className={`h-4 w-4 rounded-full border ${
                i < counter.current_pips
                  ? 'border-brand-400 bg-brand-500'
                  : 'border-zinc-700 bg-zinc-800'
              }`}
            />
          ))}
        </div>
        <button
          onClick={() => socket.emit('counter:adjust', { counterId: counter.id, delta: 1 })}
          disabled={counter.current_pips >= counter.target_pips}
          className="h-11 w-11 shrink-0 panel-cut-sm border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800 disabled:opacity-30 md:h-8 md:w-8"
        >
          +
        </button>
        <button
          onClick={() => socket.emit('counter:delete', { counterId: counter.id })}
          title="Delete"
          className="flex h-11 w-11 shrink-0 items-center justify-center panel-cut-sm text-zinc-600 hover:bg-red-900/40 hover:text-red-400 md:h-auto md:w-auto md:px-1.5"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

// Every available (unseated) character inside this folder, including all
// descendant folders — what the roster's per-folder count shows, and what
// decides whether an empty subtree hides itself entirely.
function countAvailable(node, charsByFolder) {
  const direct = charsByFolder.get(node.id)?.length ?? 0;
  const childSum = node.children.reduce((sum, child) => sum + countAvailable(child, charsByFolder), 0);
  return direct + childSum;
}

// One folder row in the roster's recursive, collapsible tree. Clicking the
// header toggles collapse for its whole subtree (tracked as a Set of folder
// ids in the parent); a folder whose complete subtree has no available
// characters hides itself rather than showing an always-empty row. Direct
// characters render before child folders once expanded, per spec.
function FolderRosterNode({ node, charsByFolder, collapsed, onToggle, depth, rosterCard }) {
  const count = countAvailable(node, charsByFolder);
  if (count === 0) return null;
  const isCollapsed = collapsed.has(node.id);
  const directChars = charsByFolder.get(node.id) ?? [];
  return (
    <div>
      <button
        onClick={() => onToggle(node.id)}
        style={{ paddingLeft: `${depth * 12}px` }}
        className="flex w-full items-center gap-1 panel-cut-sm py-1 text-left text-[10px] font-bold uppercase tracking-wide text-zinc-500 hover:text-zinc-300"
      >
        <span className="shrink-0">{isCollapsed ? '▸' : '▾'}</span>
        <span className="min-w-0 flex-1 truncate">📁 {node.name}</span>
        <span className="shrink-0 normal-case text-zinc-600">({count})</span>
      </button>
      {!isCollapsed && directChars.length > 0 && (
        <div className="space-y-2 pb-1" style={{ paddingLeft: `${depth * 12 + 10}px` }}>
          {directChars.map(rosterCard)}
        </div>
      )}
      {!isCollapsed &&
        node.children.map((child) => (
          <FolderRosterNode
            key={child.id}
            node={child}
            charsByFolder={charsByFolder}
            collapsed={collapsed}
            onToggle={onToggle}
            depth={depth + 1}
            rosterCard={rosterCard}
          />
        ))}
    </div>
  );
}

// Mobile readiness (Change 002) §7.3: the tap alternative to dropping a
// roster card onto a pair's left/right zone, or an already-seated
// ParticipantCard's own drag-to-a-different-zone move — same two server
// events either way (combat:add_participant for a not-yet-seated character,
// combat:move_participant for one already seated), picked by whether this
// character currently appears in `participants`. Lists every existing pair
// plus a trailing "New pair" row, mirroring the desktop drop-zone layout's
// own row-per-pair-index shape (see the `rows` array at the call site).
function SeatPicker({ characterId, characterName, pairIndices, participants, onClose }) {
  const isSeated = participants.some((p) => p.character_id === characterId);
  const eventName = isSeated ? 'combat:move_participant' : 'combat:add_participant';
  const seatAt = (side, pairIndex) => {
    socket.emit(eventName, { characterId, side, pairIndex });
    onClose();
  };
  const nextPairIndex = pairIndices.length ? pairIndices[pairIndices.length - 1] + 1 : 0;
  const rowClass =
    'min-h-11 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 text-sm font-semibold text-zinc-200 hover:border-brand-500 hover:bg-zinc-700';
  return (
    <DialogShell title={`Seat ${characterName}`} onClose={onClose} maxWidth="max-w-sm">
      <div className="space-y-2">
        {pairIndices.map((pairIndex) => (
          <div key={pairIndex} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs text-zinc-500">Pair {pairIndex + 1}</span>
            <button type="button" onClick={() => seatAt('left', pairIndex)} className={rowClass}>
              Left
            </button>
            <button type="button" onClick={() => seatAt('right', pairIndex)} className={rowClass}>
              Right
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2 border-t border-zinc-800 pt-2">
          <span className="w-16 shrink-0 text-xs text-zinc-500">New pair</span>
          <button
            type="button"
            onClick={() => seatAt('left', nextPairIndex)}
            className="min-h-11 flex-1 panel-cut-sm bg-brand-600 text-sm font-semibold text-white hover:bg-brand-500"
          >
            Left
          </button>
          <button
            type="button"
            onClick={() => seatAt('right', nextPairIndex)}
            className="min-h-11 flex-1 panel-cut-sm bg-brand-600 text-sm font-semibold text-white hover:bg-brand-500"
          >
            Right
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

// ---------- Tic Counter (combat redesign: now the Arena's centerpiece) ----------

// One square on the Tic Counter strip. `footprint` (startup/active/recovery
// tic ranges, relative to the square's own absolute Tic) is only non-null
// while something is being dragged and this square is the hovered drop
// point — it drives the live width preview described in the plan: the
// footprint grows/shrinks across neighboring squares as the move's own
// Startup/Active/Recovery length dictates, without ever revealing which
// square any *other* declared move actually landed on (that stays hidden
// until reveal).
// Which phase (if any) each already-declared move occupies at this absolute
// Tic — used for the small footprint-preview squares below, shown only to
// whoever currently has the declare floor, and only for **their own**
// previously-declared moves this round (see showDeclaredPreview and the
// declaredMoves filtering at the call site) — never another character's,
// declared or not. This is purely a self-service planning aid (don't
// double-book your own Tics), not a window into the opponent's timing.
//
// phaseBgAt (framePhaseColors.js, Combat Automation overhaul §4.3) is the
// shared client-side mirror of the server's phaseAtTic; this file used to
// hand-roll both the phase walk and its own copy of the palette.
function declaredPhasesAt(absoluteTic, declaredMoves) {
  return declaredMoves.map((dm) => phaseBgAt(dm, absoluteTic)).filter(Boolean);
}

// Combat Automation overhaul §4.1 — the GM's "switch between fights"
// control. Each pair runs its own independent round clock now (decision
// #12: fight A can be on round 5 while fight B is still on round 3), so
// there has to be a way to say which one you're looking at. GM-only: a
// Player only ever has one seat, and only ever watches their own pair
// live.
//
// Only the selected tab mounts a live RoundCutscene — the others are a
// cheap status badge read straight off the pair summary, rather than N
// simultaneous GSAP timelines animating fights nobody is watching.
function PairTabStrip({ pairIndices, pairs, participants, characters, activeIndex, onSelect }) {
  if (pairIndices.length < 2) return null;
  const pairsByIdx = new Map((pairs ?? []).map((p) => [p.pairIndex, p]));

  const statusOf = (pair) => {
    if (!pair?.phase) return { label: 'Not started', tone: 'text-zinc-600' };
    if (pair.pendingDodge) return { label: 'Dodge?', tone: 'text-amber-300' };
    if (pair.pendingConflict) return { label: 'Conflict?', tone: 'text-amber-300' };
    if (pair.phase === 'resolving') return { label: 'Resolving…', tone: 'text-brand-300' };
    return { label: 'Declaring', tone: 'text-zinc-400' };
  };

  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
      {pairIndices.map((idx) => {
        const pair = pairsByIdx.get(idx);
        const names = (participants ?? [])
          .filter((p) => p.pair_index === idx)
          .map((p) => characters[p.character_id]?.character.name)
          .filter(Boolean);
        const status = statusOf(pair);
        const active = activeIndex === idx;
        return (
          <button
            key={idx}
            type="button"
            onClick={() => onSelect(idx)}
            title={`${names.join(' vs ') || `Pair ${idx + 1}`} — round ${pair?.roundNumber ?? '?'}, ${status.label}`}
            className={`panel-cut-sm border px-2 py-1 text-left font-display text-[11px] leading-tight ${
              active
                ? 'border-brand-500 bg-brand-950/50 text-zinc-100'
                : 'border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            <span className="block truncate uppercase tracking-wide">
              {names.length ? names.join(' vs ') : `Pair ${idx + 1}`}
            </span>
            <span className={`block ${status.tone}`}>
              R{pair?.roundNumber ?? '?'} · {status.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Exported so CombatHeaderBar can render the exact same square visuals in
// its own compact strip (see the plan's Tic navigation redesign) — passing
// only relativeTic/isCurrent there and leaving every Arena-only extra
// (footprint preview, declared-phase dots, overflow badges, drag/drop,
// click-to-step) undefined, which each already degrade to a plain
// non-interactive square.
export function TicSquare({
  relativeTic,
  isCurrent,
  footprintZone,
  declaredPhases,
  overflowNames,
  onDragOver,
  onDrop,
  onClick,
  clickTitle,
}) {
  // Mobile readiness §7.1: the current Tic scrolls itself into view inside
  // the row's own horizontal scroller (see the overflow-x-auto wrapper in
  // TicCounterCentral below) — 'nearest' so it's a no-op once already
  // visible, not a jarring re-center on every render.
  const ref = useRef(null);
  useEffect(() => {
    if (isCurrent) ref.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [isCurrent]);
  const zoneStyle = PHASE_ZONE[footprintZone];
  // Capped at 2 badges so they never crowd a 44px square — the tooltip
  // still lists everyone if there are more.
  const shownNames = (overflowNames ?? []).slice(0, 2);
  const title = clickTitle ?? `Tic ${relativeTic}${
    overflowNames?.length
      ? ` — occupied by ${overflowNames.join(', ')} (carryover from last round)`
      : ''
  }`;
  return (
    <motion.div
      ref={ref}
      key={isCurrent ? 'current' : 'idle'}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={onClick}
      title={title}
      initial={isCurrent ? { scale: 1.5 } : false}
      animate={{ scale: isCurrent && !zoneStyle ? 1.1 : 1 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className={`relative flex h-11 w-11 shrink-0 items-center justify-center panel-cut border text-sm font-bold transition-colors duration-150 ${
        onClick ? 'cursor-pointer hover:border-brand-400 hover:shadow-[0_0_10px_rgb(var(--color-brand-rgb)/45%)]' : ''
      } ${
        zoneStyle ??
        (isCurrent
          ? 'border-brand-300 bg-brand-600 text-white shadow-[0_0_16px_rgb(var(--color-brand-rgb)/55%)]'
          : 'border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-zinc-500')
      }`}
    >
      {relativeTic}
      {shownNames.length > 0 && (
        <div className="absolute -right-0.5 -top-0.5 flex">
          {shownNames.map((name, i) => (
            <span
              key={name}
              className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-zinc-500 text-[8px] font-bold leading-none text-zinc-100 ring-1 ring-zinc-900"
              style={i > 0 ? { marginLeft: '-4px' } : undefined}
            >
              {name.slice(0, 1).toUpperCase()}
            </span>
          ))}
        </div>
      )}
      {declaredPhases?.length > 0 && (
        <div className="absolute inset-x-0 bottom-1 flex flex-wrap items-center justify-center gap-0.5">
          {declaredPhases.slice(0, 4).map((color, i) => (
            <span key={i} className={`h-1 w-1 ${color}`} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

// The centerpiece (decided, combat redesign): large, prominent, and always
// front-and-center on the Arena page — the single shared timeline for the
// whole fight, and the drag-and-drop declare target. Declaration itself now
// runs independently per pair (see combat_pairs server-side), but the
// countdown that follows stays one global strip, since there's still only
// one Tic Counter.
//
// Exported (Tic navigation redesign, item 3) so CombatHeaderBar can mount
// the exact same widget — same size, same overflow badges, same GM
// click-to-step/Next Round — instead of the old read-only mini strip, so
// the GM can advance the countdown from any page, not just the Arena.
// `label` overrides the default "Drag a move here to declare"/"Tic Counter"
// caption: the header has no move source to drag from (no roster/declare
// picker lives there), so it always passes a fixed "Tic Counter" instead.
export function TicCounterCentral({
  pairIndex, // Combat Automation overhaul: which pair's own independent round/phase/Tic clock this instance is showing.
  phase,
  currentTic,
  roundStartTic,
  roundLength,
  draggingMove,
  hoverTic,
  setHoverTic,
  onDrop,
  onTapPlace, // mobile readiness (Change 002) §7.2: tap-to-declare alternative to onDrop, same curried (absoluteTic) => (e) => void shape; undefined wherever there's no move source to place from (e.g. CombatHeaderBar)
  declaredMoves,
  showDeclaredPreview,
  overflowTics,
  role,
  label,
}) {
  const squares = Array.from({ length: roundLength }, (_, i) => ({
    absoluteTic: roundStartTic + i,
    relative: i + 1,
  }));
  // Combat Automation overhaul §5: click-to-step and the in-strip "Next
  // Round" button are gone. A round now resolves itself the moment both
  // sides finish declaring, and its playback is RoundCutscene's job — the
  // strip is a Declaration-phase drag/drop target and a read-only display,
  // never a control that moves the clock. Nothing may advance a pair's Tic
  // but the engine.
  const zoneFor = (absoluteTic) => {
    if (!draggingMove) return null;
    const minTic = draggingMove.minPlacementTic ?? roundStartTic;
    if (absoluteTic < minTic) return 'blocked';
    if (hoverTic == null) return null;
    const effectiveTic = Math.max(hoverTic, minTic);
    const { startupTics, activeTics, recoveryTics } = draggingMove;
    const startupEnd = effectiveTic + startupTics;
    const activeEnd = startupEnd + activeTics;
    const recoveryEnd = activeEnd + recoveryTics;
    if (absoluteTic >= effectiveTic && absoluteTic < startupEnd) return 'startup';
    if (absoluteTic >= startupEnd && absoluteTic < activeEnd) return 'active';
    if (absoluteTic >= activeEnd && absoluteTic < recoveryEnd) return 'recovery';
    return null;
  };
  const canDrop = phase === 'declaration';
  return (
    <div className="flex flex-col items-center gap-1.5 panel-cut-lg border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-950 px-4 py-3 shadow-2xl shadow-black/40">
      <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">
        {label ?? (phase === 'declaration' ? 'Drag a move here to declare' : 'Tic Counter')}
      </span>
      {/* Mobile readiness §7.1: one non-wrapping scrollable row instead of
          flex-wrap — 7 squares plus the Next Round button usually fit
          without ever needing to scroll on a normal phone width, but this
          keeps the timeline a single visual line regardless (matching the
          recommended §14.4 default) rather than reflowing to a second row.
          The mask-image fade is a lightweight scroll affordance (§7.1's
          "start/end fade") without a second scroll-position-tracking effect. */}
      <div
        className="flex max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain py-1 [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]"
      >
        {squares.map((sq, i) => {
          // A pending tap-to-declare placement (see onTapPlace) makes every
          // square a valid destination.
          const tapPlacing = Boolean(onTapPlace && draggingMove && canDrop);
          return (
            <TicSquare
              key={sq.absoluteTic}
              relativeTic={sq.relative}
              isCurrent={sq.absoluteTic === currentTic}
              footprintZone={zoneFor(sq.absoluteTic)}
              declaredPhases={
                showDeclaredPreview ? declaredPhasesAt(sq.absoluteTic, declaredMoves) : undefined
              }
              overflowNames={overflowTics.get(sq.absoluteTic)}
              onDragOver={
                canDrop
                  ? (e) => {
                      e.preventDefault();
                      setHoverTic(sq.absoluteTic);
                    }
                  : undefined
              }
              onDrop={canDrop ? onDrop(sq.absoluteTic) : undefined}
              onClick={tapPlacing ? onTapPlace(sq.absoluteTic) : undefined}
              clickTitle={tapPlacing ? `Place ${draggingMove.moveName} here` : undefined}
            />
          );
        })}
      </div>
      {showDeclaredPreview && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-[9px] text-zinc-600">
          {/* Driven off the shared palette so the swatches can't drift from
              the squares they describe — they had already drifted once. */}
          {FRAME_PHASES.map((phase) => (
            <span key={phase} className="flex items-center gap-1">
              <span className={`h-1.5 w-1.5 ${PHASE_BG[phase]}`} /> {PHASE_LABEL[phase]}
            </span>
          ))}
          <span>— your declared moves this round</span>
        </div>
      )}
      {overflowTics.size > 0 && (
        <div className="flex items-center gap-1 text-[9px] text-zinc-600">
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-zinc-500 text-[8px] font-bold leading-none text-zinc-100 ring-1 ring-zinc-900">
            X
          </span>{' '}
          initial = that character still has a move recovering here (carryover from last round)
        </div>
      )}
    </div>
  );
}

// ---------- Compact declared-move cards (small, flank the Tic Counter) ----------

// The secret face: just the Tell, greyed out — a move can be declared to
// land at any open Tic, so this deliberately shows no timing/length hint at
// all, only identity-via-Tell. A move with an ambiguous Left/Right Roll
// shows only the Tell for whichever appendage was actually chosen at
// declare time (both side by side only as a fallback for a legacy row
// declared before that choice existed).
function CompactTellFace({ dm, tellById }) {
  const rightTell = dm.rightTellId ? tellById.get(dm.rightTellId) : null;
  const leftTell = dm.leftTellId ? tellById.get(dm.leftTellId) : null;
  const tell = tellById.get(dm.tellId);
  const chosenTell = dm.appendageChoice === 'right' ? rightTell : dm.appendageChoice === 'left' ? leftTell : null;
  const showBoth = !chosenTell && (rightTell || leftTell);
  const shown = chosenTell ?? (showBoth ? null : tell);
  return (
    <div className="flex w-28 items-center gap-1.5 panel-cut border border-zinc-800 bg-zinc-900/60 p-1.5 opacity-60 grayscale">
      {showBoth ? (
        <>
          <Thumb record={rightTell} name={rightTell?.name} size="h-6 w-6" />
          <Thumb record={leftTell} name={leftTell?.name} size="h-6 w-6" />
        </>
      ) : (
        <Thumb record={shown} name={shown?.name} size="h-6 w-6" />
      )}
      <span className="min-w-0 truncate text-[9px] font-semibold uppercase text-zinc-500">
        {shown?.name ?? (showBoth ? `${rightTell?.name ?? '?'}/${leftTell?.name ?? '?'}` : 'Tell')}
      </span>
    </div>
  );
}

// A declared move as a small flip card. Pre-reveal: the grey Tell-only face
// above. Post-reveal (decided, combat redesign): everyone gets name + frame
// data + Tell — small and glanceable, deliberately NOT the full move card, so
// the Arena stays a fast-reading battle view. A Player wanting the full
// description/interactions goes to the Chat Log's move-reveal card instead
// (gated by the Genius Observer honor-system prompt — see ChatPanel.jsx).
// Revised (decided): the card is display-only now, not clickable at all —
// an earlier version let the GM click a revealed card to open the full
// MoveCard in an overlay, removed per the plan. A small ✕ overlays whichever
// face is showing while the move is still genuinely pending (its Stamina
// Cost hasn't left/returned to current_stamina yet) — canceling it frees the
// Tic and Stamina budget to declare something else instead. Placed outside
// the flip animation, not just on the Tell face, since the *declaring*
// player's own view already shows the revealed back face immediately.
function CompactDeclaredMoveCard({ dm, move, tellById }) {
  const revealed = dm.isRevealed && move;
  return (
    <div style={{ perspective: 1000 }} className="relative">
      {!dm.staminaCommitted && (
        <button
          onClick={() => socket.emit('move:undeclare', { declaredMoveId: dm.id })}
          title="Take this back and declare something else"
          className="absolute -right-1 -top-1 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[10px] text-zinc-400 hover:border-red-500 hover:text-red-400"
        >
          ✕
        </button>
      )}
      <AnimatePresence mode="wait" initial={false}>
        {revealed ? (
          <motion.div
            key="back"
            initial={{ rotateY: -90, opacity: 0 }}
            animate={{ rotateY: 0, opacity: 1 }}
            exit={{ rotateY: 90, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            <div
              title={move.name}
              className="flex w-28 items-center gap-1.5 panel-cut border border-brand-800/60 bg-brand-950/30 p-1.5 text-left"
            >
              <Thumb record={move} name={move.name} size="h-6 w-6" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-semibold text-zinc-100">{move.name}</div>
                <FrameBar
                  startup={move.startup_tics}
                  active={move.active_tics}
                  recovery={move.recovery_tics}
                  defensePositions={move.defense_frame_positions}
                  size="h-1.5 w-1.5"
                />
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="front"
            initial={{ rotateY: 90, opacity: 0 }}
            animate={{ rotateY: 0, opacity: 1 }}
            exit={{ rotateY: -90, opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            <CompactTellFace dm={dm} tellById={tellById} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------- Declaration status + picker ----------

const STATUS_META = {
  declaring: { label: 'Declaring', className: 'font-medium text-zinc-400' },
  declared: { label: 'Declared', className: 'font-semibold text-emerald-400' },
  waiting: { label: 'Waiting for round start', className: 'font-semibold text-sky-400' },
  not_yet: { label: 'Not yet', className: 'text-zinc-700' },
};

function characterDeclareStatus(participant, participants, pairs) {
  const pair = pairs.find((p) => p.pairIndex === participant.pair_index);
  if (participant.declared_this_round) {
    const sideFullyDeclared = participants
      .filter((p) => p.pair_index === participant.pair_index && p.side === participant.side)
      .every((p) => p.declared_this_round);
    return sideFullyDeclared ? 'waiting' : 'declared';
  }
  return pair && pair.declaringSide === participant.side ? 'declaring' : 'not_yet';
}

// A declared move stays visible across a round boundary as long as its own
// footprint is still live, instead of vanishing the instant Next Round
// increments round_number (decided, fix). Visibility for a carried-over
// (earlier-round) entry follows the same viewer-entitlement rule the rest of
// Combat Timing already draws: the owner always sees their own real frame
// data; anyone else sees the Tell-only face for as long as it's genuinely
// still unrevealed, and once it IS publicly revealed, no card renders for
// them at all — the Tic Counter's own cross-round overflow badge (see
// overflowTics above) is what conveys "something's still occupying this
// Tic" to onlookers a round later, without re-disclosing frame-type detail
// nobody but the owner needs anymore. A same-round entry is unaffected —
// unchanged "show it all round regardless of resolution state" behavior.
function isDeclaredMoveVisibleInLane(dm, currentTic, roundNumber, isOwner) {
  if (dm.roundNumber === roundNumber) return true;
  if (currentTic >= dm.recoveryEndTic) return false;
  return isOwner || !dm.isRevealed;
}

// Declaration Lanes (decided, redesign): replaces the old global Player-
// moves/NPC-moves bands and the flat declaration-status table with a
// compact 2-column table — one row per pair_index, in the same order and
// sides as the seating rows below — so several simultaneous fights stay
// readable instead of blurring into one long unsorted strip. Each cell
// lists that side's seated character(s) with their own small declared-move
// cards (see isDeclaredMoveVisibleInLane above for which ones actually
// render). GM-only: clicking anywhere on a lane selects it as "active" —
// see onSelectLane at the call site — instead of picking an individual NPC
// out of a flat list; a Player's own single-character declare panel is
// unaffected and keeps auto-showing regardless of lane selection.
function DeclarationLanes({
  pairIndices,
  participants,
  characters,
  pairs,
  tellById,
  declaredMoves,
  role,
  characterId,
  activeLaneIndex,
  onSelectLane,
}) {
  if (!pairIndices.length) return null;
  const isOwnedByViewer = (charId) => {
    const entry = characters[charId];
    if (!entry) return false;
    return role === 'player' ? charId === characterId : entry.character.character_type === 'npc';
  };
  // Combat Automation overhaul: each row is its own pair with its own
  // independent currentTic/roundNumber/phase now — laneMoveEntries/sideCell
  // used to close over one shared value for the whole table; now built
  // fresh per row, inside the pairIndices loop, from that row's own pair.
  const sideCell = (sideParticipants, pairCurrentTic, pairRoundNumber, pairPhase) => (
    <div className="flex min-w-0 flex-1 flex-wrap items-start gap-2 p-1.5">
      {sideParticipants.length === 0 && <span className="text-[10px] text-zinc-700">—</span>}
      {sideParticipants.map((p) => {
        const character = characters[p.character_id]?.character;
        if (!character) return null;
        const isOwner = isOwnedByViewer(p.character_id);
        const entries = declaredMoves
          .filter((dm) => dm.characterId === p.character_id)
          .filter((dm) => isDeclaredMoveVisibleInLane(dm, pairCurrentTic, pairRoundNumber, isOwner))
          .sort((a, b) => a.placementTic - b.placementTic)
          .map((dm) => ({ dm, move: characters[p.character_id]?.moves?.find((m) => m.id === dm.moveId) }));
        const status = characterDeclareStatus(p, participants, pairs);
        return (
          <div key={p.character_id} className="flex flex-col items-center gap-0.5">
            <span
              className={`max-w-20 truncate text-[9px] ${
                pairPhase === 'declaration' ? STATUS_META[status].className : 'text-zinc-400'
              }`}
              title={character.name}
            >
              {character.name}
            </span>
            {entries.length === 0 ? (
              <span className="text-[9px] text-zinc-700">·</span>
            ) : (
              <div className="flex flex-wrap justify-center gap-1">
                {entries.map(({ dm, move }) => (
                  <CompactDeclaredMoveCard key={dm.id} dm={dm} move={move} tellById={tellById} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
  return (
    <div className="w-full max-w-3xl space-y-1.5">
      {pairIndices.map((pairIndex) => {
        const leftParticipants = participants.filter((p) => p.side === 'left' && p.pair_index === pairIndex);
        const rightParticipants = participants.filter((p) => p.side === 'right' && p.pair_index === pairIndex);
        const clickable = role === 'gm';
        const active = activeLaneIndex === pairIndex;
        const pair = pairs.find((p) => p.pairIndex === pairIndex);
        return (
          <div
            key={pairIndex}
            onClick={clickable ? () => onSelectLane(pairIndex) : undefined}
            className={`flex flex-col items-stretch panel-cut-sm border transition-colors sm:flex-row ${
              clickable ? 'cursor-pointer hover:border-brand-500' : ''
            } ${active ? 'border-brand-500 bg-brand-950/30 ring-1 ring-brand-600' : 'border-zinc-800 bg-zinc-900/60'}`}
          >
            {sideCell(leftParticipants, pair?.currentTic, pair?.roundNumber, pair?.phase)}
            <div className="h-px bg-zinc-700/50 sm:h-auto sm:w-px sm:shrink-0" />
            {sideCell(rightParticipants, pair?.currentTic, pair?.roundNumber, pair?.phase)}
          </div>
        );
      })}
    </div>
  );
}

// A single draggable move chip in the declare picker — dragging it onto the
// Tic Counter (see TicCounterCentral above) is how it actually gets
// declared; see dragMoveState.js for why the live-drag footprint preview
// needs that extra bit of shared state alongside the native dataTransfer
// payload used for the eventual drop.
// Matches computePlacementTic server-side exactly: no earlier than the
// round's start, or the end of this character's own last-queued move's full
// footprint (Startup+Active+Recovery, not just Startup/reveal) if later —
// recoveryEndTic rides every declaredMoves entry regardless of whether its
// identity is revealed to this client (see server/index.js), so this is
// accurate even for a still-secret prior declare.
function buildDeclarePayload(character, move, roundStartTic, declaredMoves) {
  const priorBlockedUntil = declaredMoves
    .filter((dm) => dm.characterId === character.id)
    .map((dm) => dm.recoveryEndTic);
  const minPlacementTic = priorBlockedUntil.length
    ? Math.max(roundStartTic, ...priorBlockedUntil)
    : roundStartTic;
  return {
    characterId: character.id,
    moveId: move.id,
    moveName: move.name,
    startupTics: move.startup_tics,
    activeTics: move.active_tics,
    recoveryTics: move.recovery_tics,
    minPlacementTic,
    staminaCost: move.stamina_cost,
    // right_tell_id/left_tell_id are only ever set together, exactly when
    // this move's Roll has an ambiguous Hand/Leg slot (see db.js) — the
    // placement handler uses this to decide whether to ask Left/Right
    // before declaring at all.
    ambiguous: move.right_tell_id != null,
    // Only the slot taken exactly once poses the Left/Right question — one
    // taken twice already means both sides (see diceSlots.js), so it must
    // not be what the prompt asks about.
    appendageSlot:
      ['Hand', 'Leg'].find((s) => countRollSlot(move.roll_slots, s) === 1) ?? null,
  };
}

// Mobile readiness (Change 002) §7.2: a real <button>, not just a draggable
// div — native HTML5 drag-and-drop has no touch equivalent, so tapping this
// (onClick) enters the same "placement mode" a drag does: it sets the exact
// same dragMoveState.js payload a drag start would, which is what makes the
// Tic Counter's footprint-preview machinery (zoneFor in TicCounterCentral)
// and the tap-to-place handler (see CombatArena's handleTicTap) work
// without any parallel state of their own. Desktop keeps native drag too —
// the two aren't mutually exclusive, a mouse user can also just click.
function DeclareMoveCard({ character, move, roundStartTic, declaredMoves }) {
  const cost =
    move.stamina_cost > 0 ? `-${move.stamina_cost}` : move.stamina_cost < 0 ? `+${-move.stamina_cost}` : '0';
  const payload = buildDeclarePayload(character, move, roundStartTic, declaredMoves);
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-vtt-move', JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'copy';
        setDraggingMove(payload);
      }}
      onDragEnd={() => setDraggingMove(null)}
      onClick={() => setDraggingMove(payload)}
      title="Drag onto the Tic Counter, or tap then tap a Tic, to declare"
      className="min-h-11 cursor-grab select-none panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-brand-600 active:cursor-grabbing"
    >
      {move.name} <span className="text-zinc-500">({cost} Stamina)</span>
    </button>
  );
}

// Declaration Phase's declare-a-move picker for whichever single character
// currently has the floor — Default/Unique tabs split the character's move
// list the same way Tab 3 does; a styled move is left out of either tab
// unless it matches one of the two styles in the character's active stance.
function DeclareMovePicker({ entry, roundStartTic, declaredMoves }) {
  const { character, stances, moves } = entry;
  const [tab, setTab] = useState('default');
  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  const activeStyles = activeStance ? [activeStance.attribute_a_id, activeStance.attribute_b_id] : [];
  const usable = (move) => move.style_attribute_id == null || activeStyles.includes(move.style_attribute_id);
  const shown = (moves ?? []).filter((m) => Boolean(m.is_default) === (tab === 'default') && usable(m));
  return (
    <div className="panel-cut-sm border border-zinc-800 bg-zinc-950 p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex overflow-hidden panel-cut-sm border border-zinc-700 text-[11px] font-semibold uppercase">
          {['default', 'unique'].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-2 py-0.5 ${tab === t ? 'bg-brand-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.length ? (
          shown.map((m) => (
            <DeclareMoveCard
              key={m.id}
              character={character}
              move={m}
              roundStartTic={roundStartTic}
              declaredMoves={declaredMoves}
            />
          ))
        ) : (
          <span className="text-xs text-zinc-600">No {tab} moves.</span>
        )}
      </div>
    </div>
  );
}

// The declare panel for one character currently on the declare floor — a
// Player's own character when it's their turn, or (Tic navigation redesign)
// one panel per not-yet-declared NPC on the GM's currently-selected lane
// (see DeclarationLanes above) — more than one only ever stacks under
// Uneven Combat. Each character presses their own Done Declaring
// individually (decided, combat redesign) — there's no shared per-side
// button anymore.
function ActiveDeclarePanel({ entry, roundStartTic, declaredMoves }) {
  return (
    <div className="w-full max-w-md space-y-2 panel-cut-lg border border-brand-800/50 bg-brand-950/20 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-bold text-brand-200">{entry.character.name}'s turn to declare</h3>
        <button
          onClick={() => socket.emit('combat:character_done_declaring', { characterId: entry.character.id })}
          className="shrink-0 panel-cut-sm bg-emerald-700 px-3 py-1 text-xs font-semibold hover:bg-emerald-600"
        >
          ✓ Done Declaring
        </button>
      </div>
      <DeclareMovePicker entry={entry} roundStartTic={roundStartTic} declaredMoves={declaredMoves} />
    </div>
  );
}

// Phase 6 shipped structure only; Phase 7 added round/Tic timing; Phase 9's
// combat redesign made declaration itself asynchronous per pair (see
// combat_pairs server-side) and made the Tic Counter the Arena's visual
// centerpiece — see vttprojectplan.md's Combat Timing/Combat Arena sections.
// GM drags characters onto a left/right side and groups them into pairs (a
// side/pair_index can hold more than one character when Uneven Combat is
// on). Dice/stamina here are a read-only glance — rolling still happens from
// each character's own sheet, reachable by clicking their card.
export default function CombatArena() {
  const { role, characterId } = useRole();
  const navigate = useNavigate();
  const [combat, setCombat] = useState(null); // { unevenCombatEnabled, participants, characters, counters, pairs, ...Phase 7 timing state, declaredMoves }
  const [roster, setRoster] = useState(null);
  const [folders, setFolders] = useState(null);
  const [tells, setTells] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // `${side}-${pairIndex}` | null
  const [counterName, setCounterName] = useState('');
  const [counterTarget, setCounterTarget] = useState(6);
  const [collapsedFolders, setCollapsedFolders] = useState(new Set()); // roster folder ids, collapsed
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMoveLocal] = useState(null);
  const [toast, setToast] = useState(null);
  // A move with an ambiguous Left/Right Roll slot doesn't declare on drop —
  // it holds here until the popup below records a choice (or is cancelled).
  const [pendingDeclare, setPendingDeclare] = useState(null);
  // GM-only: which pair (lane) is currently selected — client-only
  // convenience state, drives both the declare picker (see
  // DeclarationLanes above) and the Tic Counter's own-move preview scoping.
  const [activeLaneIndex, setActiveLaneIndex] = useState(null);
  // Mobile readiness (Change 002) §7.3: single-pointer seating alternative
  // to the desktop-only drag-a-card-onto-a-side flow. mobileRosterOpen shows
  // the roster as a drawer (same folder tree, tap instead of drag);
  // seatTarget ({ characterId, characterName }) then shows the Left/Right/
  // New-pair picker — reused for both "seat a new character" (from the
  // drawer) and "move an already-seated one" (ParticipantCard's ⇄ action).
  const [mobileRosterOpen, setMobileRosterOpen] = useState(false);
  const [seatTarget, setSeatTarget] = useState(null);
  // Combat Automation overhaul §5: which character (if any) the GM is
  // applying ad-hoc, outside-the-automated-flow damage to.
  const [adHocDamageCharId, setAdHocDamageCharId] = useState(null);
  // Transient "linger then slam" impact effects for a successful drop —
  // declaring a move onto the Tic Counter, or seating a character — see
  // DropSlamGhost.jsx. Keyed so more than one can be in flight at once.
  const [dropGhosts, setDropGhosts] = useState([]);
  const spawnDropGhost = (x, y, content) => {
    const id = `${Date.now()}-${Math.random()}`;
    setDropGhosts((prev) => [...prev, { id, x, y, content }]);
  };
  const removeDropGhost = (id) => setDropGhosts((prev) => prev.filter((g) => g.id !== id));

  useEffect(() => onDraggingMoveChange(setDraggingMoveLocal), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Clears the GM's "active lane" selection once that pair no longer has
  // anyone seated (fully cleared) — purely a UI tidiness thing; the
  // selection otherwise persists across rounds/phases so the GM can keep
  // watching a lane without it being yanked out from under them.
  useEffect(() => {
    if (!combat || activeLaneIndex == null) return;
    const stillExists = combat.participants.some((p) => p.pair_index === activeLaneIndex);
    if (!stillExists) setActiveLaneIndex(null);
  }, [combat, activeLaneIndex]);

  useEffect(() => {
    const refresh = () => {
      // REST has no socket to carry identity, so it rides as query params
      // instead (see viewerFromQuery server-side) — same info the socket
      // itself was already told via identity:set in roleContext.jsx.
      getCombat(role === 'gm' ? { role } : { role, characterId }).then(setCombat).catch(console.error);
      getCharacters().then(setRoster).catch(console.error);
      getCharacterFolders().then(setFolders).catch(console.error);
      getTells().then(setTells).catch(console.error);
    };
    refresh();
    const events = [
      'combat:updated',
      'character:created', 'character:deleted',
      'counter:created', 'counter:updated', 'counter:deleted',
      'stance:created', 'stance:updated', 'stance:deleted',
      'character_folder:created', 'character_folder:updated', 'character_folder:deleted',
      'tell:created', 'tell:updated', 'tell:deleted',
    ];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, [role, characterId]);

  // Mobile readiness (Change 002) §11.2: a reconnect or a resumed-from-
  // background tab isn't guaranteed to also fire one of the broadcasts the
  // effect above already listens to — this re-fetches the same REST
  // snapshot directly so combat/roster state can't go stale after either.
  useSocketRefresh(() =>
    getCombat(role === 'gm' ? { role } : { role, characterId }).then(setCombat).catch(console.error)
  );

  // Live dice/stamina patching for whoever's currently seated — same
  // fine-grained approach as CharacterSheet.jsx, so a die click anywhere
  // doesn't force a full re-fetch of every seated character.
  useEffect(() => {
    const onCharacterUpdated = (character) => {
      setCombat((prev) =>
        prev?.characters[character.id]
          ? {
              ...prev,
              characters: {
                ...prev.characters,
                [character.id]: { ...prev.characters[character.id], character },
              },
            }
          : prev
      );
    };
    const onDieUpdated = (die) => {
      setCombat((prev) => {
        const entry = prev?.characters[die.characterId];
        if (!entry) return prev;
        return {
          ...prev,
          characters: {
            ...prev.characters,
            [die.characterId]: {
              ...entry,
              dice: entry.dice.map((d) =>
                d.id === die.dieId
                  ? {
                      ...d,
                      current_size: die.current_size,
                      bonus: die.bonus,
                      status: die.status,
                      locked_size: die.locked_size,
                      locked_bonus: die.locked_bonus,
                      locked_status: die.locked_status,
                    }
                  : d
              ),
            },
          },
        };
      });
    };
    const onStanceActivated = ({ characterId, stanceId }) => {
      setCombat((prev) => {
        const entry = prev?.characters[characterId];
        if (!entry) return prev;
        return {
          ...prev,
          characters: {
            ...prev.characters,
            [characterId]: { ...entry, character: { ...entry.character, active_stance_id: stanceId } },
          },
        };
      });
    };
    socket.on('character:updated', onCharacterUpdated);
    socket.on('die:updated', onDieUpdated);
    socket.on('stance:activated', onStanceActivated);
    return () => {
      socket.off('character:updated', onCharacterUpdated);
      socket.off('die:updated', onDieUpdated);
      socket.off('stance:activated', onStanceActivated);
    };
  }, []);

  // The auto-open-Roll-on-reveal watcher used to live here, but it only ran
  // while this component was mounted — a GM who navigated away from the
  // Arena (e.g. to roll an NPC's dice from its own sheet, or just to check
  // the Compendium) missed every reveal that happened while they were gone,
  // since the watcher's "already seen" tracking reset on remount instead of
  // ever getting a chance to queue those prompts (bugfix). It now lives in
  // CombatHeaderBar.jsx, which stays mounted across the whole app for as
  // long as a fight is active — see that file for the actual logic.

  if (!combat || !roster || !folders || !tells) {
    return <p className="text-zinc-500">Loading…</p>;
  }

  const { unevenCombatEnabled, participants, characters, counters, pairs } = combat;
  // Combat Automation overhaul: there's no single arena-wide `phase`
  // anymore — every pair has its own independent round/phase/Tic clock
  // (see combat_pairs in db.js). This map is the shared lookup every
  // per-pair-scoped computation below uses instead of one global value.
  const pairsByIndex = new Map((pairs ?? []).map((p) => [p.pairIndex, p]));
  const tellById = new Map(tells.map((t) => [t.id, t]));
  // combat:updated/GET /api/combat already come back tailored to this
  // client's own identity (see server's mapDeclaredMovesForViewer) — a
  // declaredMoves entry this client is entitled to see early already has
  // isRevealed/moveId/moveName/staminaCost filled in, no client-side merge
  // needed.
  const declaredMoves = combat.declaredMoves;
  const seatedIds = new Set(participants.map((p) => p.character_id));
  const visibleRoster = role === 'gm' ? roster : roster.filter((c) => c.character_type === 'pc');
  const availableCharacters = visibleRoster.filter((c) => !seatedIds.has(c.id));
  // Folders render first (recursive, collapsible, alphabetical at every
  // level, hidden entirely when their whole subtree has nobody available),
  // then folderless characters last under their own heading.
  const rootCharacters = availableCharacters.filter((c) => c.folder_id == null);
  const availableByFolder = new Map();
  for (const c of availableCharacters) {
    if (c.folder_id == null) continue;
    if (!availableByFolder.has(c.folder_id)) availableByFolder.set(c.folder_id, []);
    availableByFolder.get(c.folder_id).push(c);
  }
  const rosterFolderTree = buildFolderTree(folders);
  const toggleFolderCollapse = (folderId) =>
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });

  const pairIndices = [...new Set(participants.map((p) => p.pair_index))].sort((a, b) => a - b);
  const rows = [...pairIndices, pairIndices.length ? pairIndices[pairIndices.length - 1] + 1 : 0];
  // "Start Combat" shows whenever at least one currently-seated pairIndex
  // has never had a combat_pairs row seeded for it — the per-pair
  // equivalent of the old arena-wide "phase === null".
  const hasUnstartedPair = pairIndices.some((idx) => !pairsByIndex.has(idx));

  // Whether THIS character currently has the floor: their own pair's
  // declaringSide matches their own side, and they haven't already pressed
  // Done Declaring this round (Phase 9 combat redesign — see combat_pairs).
  const isCharacterTurn = (charId) => {
    const p = participants.find((pp) => pp.character_id === charId);
    if (!p || p.declared_this_round) return false;
    const pair = pairsByIndex.get(p.pair_index);
    return Boolean(pair && pair.declaringSide === p.side);
  };

  const onDrop = (e, side, pairIndex) => {
    e.preventDefault();
    setDropTarget(null);
    const characterId = Number(e.dataTransfer.getData('text/character-id'));
    if (!characterId) return;
    const seatedCharacterName =
      roster.find((c) => c.id === characterId)?.name ?? characters[characterId]?.character.name ?? 'Character';
    spawnDropGhost(
      e.clientX,
      e.clientY,
      <div className="panel-cut border border-brand-400 bg-zinc-900 px-3 py-2 font-display text-sm font-bold uppercase tracking-wide text-white shadow-lg">
        {seatedCharacterName}
      </div>
    );
    const event = seatedIds.has(characterId) ? 'combat:move_participant' : 'combat:add_participant';
    socket.emit(event, { characterId, side, pairIndex });
  };

  const remove = (characterId) => socket.emit('combat:remove_participant', { characterId });

  const rosterCard = (c) => {
    const src = portraitSrc(c);
    return (
      <div
        key={c.id}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(c.id))}
        title="Drag onto a side to seat them"
        className="flex cursor-grab items-center gap-2 panel-cut border border-zinc-800 bg-zinc-900 p-2 active:cursor-grabbing"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden panel-cut-sm bg-zinc-800 text-sm font-bold text-zinc-600">
          {src ? (
            <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            c.name.slice(0, 1).toUpperCase()
          )}
        </div>
        <span className="truncate text-sm text-zinc-300">{c.name}</span>
        {c.character_type === 'npc' && (
          <span className="ml-auto panel-cut-sm bg-purple-600/30 px-1 text-[10px] font-bold uppercase text-purple-300">
            NPC
          </span>
        )}
      </div>
    );
  };

  // Tap variant of rosterCard above, for the mobile drawer (§7.3) — opens
  // SeatPicker instead of starting a native drag.
  const mobileRosterCard = (c) => {
    const src = portraitSrc(c);
    return (
      <button
        key={c.id}
        type="button"
        onClick={() => {
          setMobileRosterOpen(false);
          setSeatTarget({ characterId: c.id, characterName: c.name });
        }}
        className="flex min-h-11 w-full items-center gap-2 panel-cut border border-zinc-800 bg-zinc-900 p-2 text-left hover:border-brand-600"
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden panel-cut-sm bg-zinc-800 text-sm font-bold text-zinc-600">
          {src ? (
            <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            c.name.slice(0, 1).toUpperCase()
          )}
        </div>
        <span className="truncate text-sm text-zinc-300">{c.name}</span>
        {c.character_type === 'npc' && (
          <span className="ml-auto panel-cut-sm bg-purple-600/30 px-1 text-[10px] font-bold uppercase text-purple-300">
            NPC
          </span>
        )}
      </button>
    );
  };

  const addCounter = (e) => {
    e.preventDefault();
    if (!counterName.trim()) return;
    socket.emit('counter:create', {
      characterId: null,
      name: counterName.trim(),
      targetPips: counterTarget,
    });
    setCounterName('');
    setCounterTarget(6);
  };

  // ---------- Tic Counter drag/drop handling ----------

  // Shared by both the native-drag drop handler and the mobile tap-to-place
  // handler below — the two input paths differ (a DragEvent's dataTransfer
  // vs. the dragMoveState.js payload already sitting in `draggingMove`), but
  // once a payload is in hand, declaring it works identically either way.
  const declareMoveAt = (absoluteTic, payload, clientX, clientY) => {
    const { characterId: draggedCharId, moveId, moveName, staminaCost, ambiguous, appendageSlot } = payload;
    // A pre-check purely for a fast, friendly "Not enough Stamina" —
    // move:declare still enforces this authoritatively server-side (a
    // silent no-op on failure), same as ever.
    const character = roster.find((c) => c.id === draggedCharId);
    if (character && Number.isInteger(staminaCost)) {
      const pending = declaredMoves
        .filter((dm) => dm.characterId === draggedCharId && dm.staminaCost != null && !dm.staminaCommitted)
        .reduce((sum, dm) => sum + dm.staminaCost, 0);
      if (character.current_stamina - pending - staminaCost < 0) {
        setToast('Not enough Stamina');
        return;
      }
    }
    if (ambiguous) {
      setPendingDeclare({
        characterId: draggedCharId,
        moveId,
        moveName,
        absoluteTic,
        appendageSlot,
        x: clientX,
        y: clientY,
      });
      return;
    }
    spawnDropGhost(
      clientX,
      clientY,
      <div className="panel-cut-sm border border-brand-400 bg-brand-600 px-3 py-1.5 font-display text-xs font-bold uppercase tracking-wide text-white shadow-lg">
        {moveName}
      </div>
    );
    socket.emit('move:declare', { characterId: draggedCharId, moveId, placementTic: absoluteTic });
  };

  const handleTicDrop = (absoluteTic) => (e) => {
    e.preventDefault();
    setHoverTic(null);
    const raw = e.dataTransfer.getData('application/x-vtt-move');
    if (!raw) return;
    declareMoveAt(absoluteTic, JSON.parse(raw), e.clientX, e.clientY);
  };

  // Mobile readiness (Change 002) §7.2: the tap-to-declare counterpart to
  // handleTicDrop above — fires once a DeclareMoveCard tap has put a
  // payload into `draggingMove` (see dragMoveState.js), on tapping ANY Tic
  // square (see TicCounterCentral's tapPlacing branch, not just the GM's
  // step neighbors). Always clears the pending placement afterward, even on
  // the ambiguous-Left/Right branch — that popup carries its own copy of
  // everything declareMoveAt needs, so there's nothing left pending here
  // once it's up.
  const handleTicTap = (absoluteTic) => (e) => {
    if (!draggingMove) return;
    declareMoveAt(absoluteTic, draggingMove, e.clientX, e.clientY);
    setDraggingMove(null);
  };

  const chooseAppendage = (side) => {
    spawnDropGhost(
      pendingDeclare.x,
      pendingDeclare.y,
      <div className="panel-cut-sm border border-brand-400 bg-brand-600 px-3 py-1.5 font-display text-xs font-bold uppercase tracking-wide text-white shadow-lg">
        {pendingDeclare.moveName}
      </div>
    );
    socket.emit('move:declare', {
      characterId: pendingDeclare.characterId,
      moveId: pendingDeclare.moveId,
      placementTic: pendingDeclare.absoluteTic,
      appendageChoice: side,
    });
    setPendingDeclare(null);
  };

  // ---------- Who currently has the declare-picker floor ----------

  // A Player always declares for their own single character, unaffected by
  // lane selection. The GM instead picks a lane (see DeclarationLanes above)
  // — every not-yet-declared NPC on that lane's currently-declaring side
  // gets its own panel (plural: Uneven Combat can have more than one), never
  // a Player-controlled character sharing that side, matching the same
  // GM-can-only-drive-NPCs boundary the old NPC-only status table enforced.
  // isCharacterTurn/lanePair.declaringSide already imply "that pair is in
  // its own Declaration phase" (declaringSide is only ever non-null then),
  // so no separate top-level phase gate is needed here anymore.
  let activeDeclareEntries = [];
  if (role === 'player' && isCharacterTurn(characterId)) {
    const entry = characters[characterId];
    if (entry) activeDeclareEntries = [entry];
  } else if (role === 'gm' && activeLaneIndex != null) {
    const lanePair = pairsByIndex.get(activeLaneIndex);
    if (lanePair && lanePair.declaringSide) {
      activeDeclareEntries = participants
        .filter(
          (p) =>
            p.pair_index === activeLaneIndex &&
            p.side === lanePair.declaringSide &&
            !p.declared_this_round
        )
        .map((p) => characters[p.character_id])
        .filter((entry) => entry && entry.character.character_type === 'npc');
    }
  }

  // Combat Automation overhaul: the page's own single Tic Counter/
  // Declaration Lanes panel below can only ever show ONE pair's own
  // independent clock at a time — a Player sees their own seat's pair; the
  // GM sees whichever pair they've selected via a lane click
  // (activeLaneIndex), defaulting to the first pair that's actually been
  // round-seeded. A full "watch every fight" multi-pair view is Phase E's
  // job (see vttprojectplan.md's Combat Automation overhaul section).
  const myPairIndex = role === 'player'
    ? participants.find((p) => p.character_id === characterId)?.pair_index
    : null;
  const displayPairIndex =
    role === 'player' ? myPairIndex : activeLaneIndex ?? pairIndices.find((idx) => pairsByIndex.has(idx)) ?? null;
  const displayPair = displayPairIndex != null ? pairsByIndex.get(displayPairIndex) : null;

  // ---------- Declared moves: current-round scoping + cross-round overflow ----------
  // Both scoped to displayPair now (that pair's own roundNumber/
  // roundStartTic), not one arena-wide clock — see displayPair above.

  const currentRoundMoves = displayPair
    ? declaredMoves.filter((dm) => dm.roundNumber === displayPair.roundNumber)
    : [];
  // Tics at the start of THIS pair's round already occupied by a previous
  // round's overflowing Recovery — general board-state awareness, broadcast
  // to everyone regardless of role/turn. Attributed by character name:
  // which character still has something recovering here isn't secret
  // (their Tell card is already visible in the Declaration Lanes the whole
  // time), only the move's own identity/details are — same distinction the
  // rest of Combat Timing already draws. Only ever built from prior rounds,
  // so it can never leak this round's own still-secret placements. Scoped
  // to just displayPair's own seated characters — a different pair's
  // carried-over move has nothing to do with the pair being shown here.
  const overflowTics = new Map(); // absoluteTic -> character names occupying it
  if (displayPair) {
    const pairIndexByChar = new Map(participants.map((p) => [p.character_id, p.pair_index]));
    for (const dm of declaredMoves) {
      if (pairIndexByChar.get(dm.characterId) !== displayPairIndex) continue;
      if (dm.roundNumber >= displayPair.roundNumber) continue;
      const name = characters[dm.characterId]?.character.name;
      if (!name) continue;
      for (let t = displayPair.roundStartTic; t < dm.recoveryEndTic; t++) {
        const names = overflowTics.get(t) ?? [];
        if (!names.includes(name)) names.push(name);
        overflowTics.set(t, names);
      }
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Combat Arena</h1>
        <div className="flex items-center gap-3">
          {/* Mobile readiness (Change 002) §7.3: below the width where the
              drag-based roster aside disappears (sm:block, see it below),
              this is the only way a GM can seat/re-seat anyone. */}
          {role === 'gm' && (
            <button
              type="button"
              onClick={() => setMobileRosterOpen(true)}
              className="min-h-11 panel-cut-sm border border-zinc-700 px-3 text-sm font-semibold text-zinc-300 hover:bg-zinc-800 sm:hidden"
            >
              Roster
            </button>
          )}
          {role === 'gm' ? (
            <label className="flex items-center gap-1.5 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={unevenCombatEnabled}
                onChange={() => socket.emit('combat:toggle_uneven', {})}
              />
              Uneven Combat
            </label>
          ) : (
            unevenCombatEnabled && (
              <span className="rounded-full bg-amber-600/30 px-2 py-0.5 text-xs font-semibold text-amber-300">
                Uneven Combat
              </span>
            )
          )}
          {role === 'gm' && hasUnstartedPair && participants.length > 0 && (
            <button
              onClick={() => socket.emit('combat:next_round', {})}
              className="panel-cut-sm bg-emerald-700 px-3 py-1 text-sm font-semibold hover:bg-emerald-600"
            >
              Start Combat
            </button>
          )}
          {role === 'gm' && participants.length > 0 && (
            <button
              onClick={() =>
                window.confirm('Clear the arena? Everyone currently seated is removed.') &&
                socket.emit('combat:clear', {})
              }
              className="panel-cut-sm border border-zinc-700 px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              Clear Arena
            </button>
          )}
        </div>
      </div>

      {(pairs ?? []).length > 0 && (
        <div className="relative mb-4 flex flex-col items-center gap-3">
          {toast && (
            <div className="absolute -top-2 left-1/2 z-50 -translate-x-1/2 -translate-y-full panel-cut-sm border border-red-700 bg-red-950/95 px-3 py-1.5 text-sm font-semibold text-red-200 shadow-lg">
              {toast}
            </div>
          )}
          {pendingDeclare && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
              onClick={() => setPendingDeclare(null)}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                className="flex w-72 flex-col gap-3 panel-cut-lg border border-zinc-700 bg-zinc-900 p-4"
              >
                <h3 className="font-bold text-zinc-100">
                  {characters[pendingDeclare.characterId]?.character.name ?? 'Character'}: {pendingDeclare.moveName}
                </h3>
                <p className="text-sm text-zinc-400">Which side is throwing this?</p>
                <div className="flex gap-2">
                  {['left', 'right'].map((side) => (
                    <button
                      key={side}
                      onClick={() => chooseAppendage(side)}
                      className="flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold capitalize hover:bg-brand-500"
                    >
                      {side}
                      {pendingDeclare.appendageSlot ? ` ${pendingDeclare.appendageSlot}` : ''}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setPendingDeclare(null)}
                  className="panel-cut-sm border border-zinc-700 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {draggingMove && (
            <div className="flex items-center gap-2 panel-cut-sm border border-brand-700/50 bg-brand-950/40 px-3 py-1.5 text-xs font-semibold text-brand-200 md:hidden">
              Choose a Tic for {draggingMove.moveName}
              <button
                type="button"
                onClick={() => setDraggingMove(null)}
                className="min-h-11 px-2 text-zinc-400 hover:text-zinc-100"
              >
                Cancel
              </button>
            </div>
          )}

          {role === 'gm' && (
            <PairTabStrip
              pairIndices={pairIndices}
              pairs={pairs ?? []}
              participants={participants}
              characters={characters}
              activeIndex={displayPairIndex}
              onSelect={setActiveLaneIndex}
            />
          )}

          {/* Combat Automation overhaul §4.1: once a pair drops into
              Resolving, its round is already computed server-side and the
              strip stops being a live/steppable control — the cutscene
              takes over and plays the round's event log back. Every other
              pair keeps rendering its own state independently below. */}
          {displayPair?.phase === 'resolving' ? (
            <RoundCutscene
              mode="live"
              pairIndex={displayPairIndex}
              roundNumber={displayPair?.roundNumber}
              roundStartTic={displayPair?.roundStartTic}
              roundLength={combat.roundLength}
              pendingDodge={displayPair?.pendingDodge}
              pendingConflict={displayPair?.pendingConflict}
            />
          ) : (
          <TicCounterCentral
            pairIndex={displayPairIndex}
            phase={displayPair?.phase}
            currentTic={displayPair?.currentTic}
            roundStartTic={displayPair?.roundStartTic}
            roundLength={combat.roundLength}
            draggingMove={draggingMove}
            hoverTic={hoverTic}
            setHoverTic={setHoverTic}
            onDrop={handleTicDrop}
            onTapPlace={handleTicTap}
            declaredMoves={
              activeDeclareEntries.length
                ? currentRoundMoves.filter((dm) =>
                    activeDeclareEntries.some((e) => e.character.id === dm.characterId)
                  )
                : []
            }
            showDeclaredPreview={activeDeclareEntries.length > 0}
            overflowTics={overflowTics}
            role={role}
          />
          )}

          <DeclarationLanes
            pairIndices={pairIndices}
            participants={participants}
            characters={characters}
            pairs={pairs ?? []}
            tellById={tellById}
            declaredMoves={declaredMoves}
            role={role}
            characterId={characterId}
            activeLaneIndex={activeLaneIndex}
            onSelectLane={setActiveLaneIndex}
          />
        </div>
      )}

      {displayPair?.phase === 'declaration' && (
        <div className="mb-4 flex flex-wrap items-start justify-center gap-3">
          {activeDeclareEntries.map((entry) => (
            <ActiveDeclarePanel
              key={entry.character.id}
              entry={entry}
              roundStartTic={displayPair?.roundStartTic}
              declaredMoves={declaredMoves}
            />
          ))}
          {role === 'gm' && activeDeclareEntries.length === 0 && (
            <div className="flex max-w-md items-center panel-cut-lg border border-dashed border-zinc-800 px-4 py-6 text-sm text-zinc-600">
              {activeLaneIndex == null
                ? 'Click a lane above to declare for its NPCs.'
                : "Nothing to declare for this lane right now — it's not an NPC's turn here."}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          {participants.length === 0 && (
            <p className="text-sm text-zinc-600">
              No one in the arena yet.
              {role === 'gm' ? ' Drag characters from the roster to start a fight.' : ''}
            </p>
          )}

          {rows.map((rowIdx) => {
            const leftOccupants = participants.filter((p) => p.side === 'left' && p.pair_index === rowIdx);
            const rightOccupants = participants.filter((p) => p.side === 'right' && p.pair_index === rowIdx);
            const leftKey = `left-${rowIdx}`;
            const rightKey = `right-${rowIdx}`;
            return (
              // Mobile readiness (Change 002) §7.4/14.5: Left/Right stack
              // vertically in portrait (a real pair-panel layout, not two
              // half-width scrollers) with a VS divider between them;
              // sm: and up returns to the original side-by-side row.
              <div key={rowIdx} className="flex flex-col items-stretch gap-2 sm:flex-row sm:gap-3">
                <div
                  onDragOver={(e) => {
                    if (role !== 'gm') return;
                    e.preventDefault();
                    setDropTarget(leftKey);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => role === 'gm' && onDrop(e, 'left', rowIdx)}
                  className={`flex min-h-24 flex-1 gap-2 overflow-x-auto overflow-y-hidden panel-cut border border-dashed p-2 transition-colors ${
                    dropTarget === leftKey ? 'border-brand-400 bg-brand-950/20' : 'border-zinc-800'
                  }`}
                >
                  {leftOccupants.map(
                    (p) =>
                      characters[p.character_id] && (
                        <ParticipantCard
                          key={p.character_id}
                          entry={characters[p.character_id]}
                          participant={p}
                          role={role}
                          onRemove={remove}
                          onAdHocDamage={setAdHocDamageCharId}
                          onMoveSeat={(id, name) => setSeatTarget({ characterId: id, characterName: name })}
                          navigate={navigate}
                          declaredMoves={declaredMoves}
                          sideStillDeclaring={pairsByIndex.get(p.pair_index)?.declaringSide === p.side}
                          onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(p.character_id))}
                        />
                      )
                  )}
                </div>
                <div className="flex shrink-0 items-center justify-center sm:w-px sm:flex-col sm:bg-zinc-700/50" title="Pair divider">
                  <span className="font-display panel-cut-sm bg-zinc-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500 sm:hidden">
                    VS
                  </span>
                </div>
                <div
                  onDragOver={(e) => {
                    if (role !== 'gm') return;
                    e.preventDefault();
                    setDropTarget(rightKey);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => role === 'gm' && onDrop(e, 'right', rowIdx)}
                  className={`flex min-h-24 flex-1 gap-2 overflow-x-auto overflow-y-hidden panel-cut border border-dashed p-2 transition-colors ${
                    dropTarget === rightKey ? 'border-brand-400 bg-brand-950/20' : 'border-zinc-800'
                  }`}
                >
                  {rightOccupants.map(
                    (p) =>
                      characters[p.character_id] && (
                        <ParticipantCard
                          key={p.character_id}
                          entry={characters[p.character_id]}
                          participant={p}
                          role={role}
                          onRemove={remove}
                          onAdHocDamage={setAdHocDamageCharId}
                          onMoveSeat={(id, name) => setSeatTarget({ characterId: id, characterName: name })}
                          navigate={navigate}
                          declaredMoves={declaredMoves}
                          sideStillDeclaring={pairsByIndex.get(p.pair_index)?.declaringSide === p.side}
                          onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(p.character_id))}
                        />
                      )
                  )}
                </div>
              </div>
            );
          })}

          <div className="panel-cut-lg border border-zinc-800 bg-zinc-900 p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-400">Counters</h2>
            {counters.length === 0 ? (
              <p className="text-sm text-zinc-600">No counters shown here yet.</p>
            ) : (
              <div className="space-y-2">
                {counters.map((c) => (
                  <ArenaCounterRow
                    key={c.id}
                    counter={c}
                    characterName={c.character_id ? characters[c.character_id]?.character.name : null}
                  />
                ))}
              </div>
            )}
            {role === 'gm' && (
              <form onSubmit={addCounter} className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
                <input
                  value={counterName}
                  onChange={(e) => setCounterName(e.target.value)}
                  placeholder="Standalone counter name"
                  className="min-w-0 flex-1 panel-cut-sm border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
                />
                <label className="flex items-center gap-1.5 text-xs text-zinc-500">
                  Target
                  <input
                    type="number"
                    min={MIN_TARGET}
                    max={MAX_TARGET}
                    value={counterTarget}
                    onChange={(e) =>
                      setCounterTarget(
                        Math.max(MIN_TARGET, Math.min(MAX_TARGET, Number(e.target.value) || MIN_TARGET))
                      )
                    }
                    className="w-16 panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-brand-500"
                  />
                </label>
                <button
                  type="submit"
                  disabled={!counterName.trim()}
                  className="panel-cut-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold hover:bg-brand-500 disabled:opacity-40"
                >
                  + New Arena Counter
                </button>
              </form>
            )}
          </div>
        </div>

        {role === 'gm' && (
          <aside className="hidden w-44 shrink-0 sm:block">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-zinc-500">
              Roster (drag to seat)
            </h2>
            <div className="space-y-1">
              {rosterFolderTree.map((node) => (
                <FolderRosterNode
                  key={node.id}
                  node={node}
                  charsByFolder={availableByFolder}
                  collapsed={collapsedFolders}
                  onToggle={toggleFolderCollapse}
                  depth={0}
                  rosterCard={rosterCard}
                />
              ))}
              {rootCharacters.length > 0 && (
                <div className="pt-2">
                  <h3 className="mb-1 text-[10px] font-bold uppercase tracking-wide text-zinc-600">
                    Folderless
                  </h3>
                  <div className="space-y-2">{rootCharacters.map(rosterCard)}</div>
                </div>
              )}
              {availableCharacters.length === 0 && (
                <p className="text-xs text-zinc-600">Everyone is seated.</p>
              )}
            </div>
          </aside>
        )}
      </div>

      <AnimatePresence>
        {dropGhosts.map((g) => (
          <DropSlamGhost key={g.id} x={g.x} y={g.y} onDone={() => removeDropGhost(g.id)}>
            {g.content}
          </DropSlamGhost>
        ))}
      </AnimatePresence>

      {mobileRosterOpen && (
        <DialogShell title="Roster" onClose={() => setMobileRosterOpen(false)} maxWidth="max-w-sm">
          <div className="space-y-1">
            {rosterFolderTree.map((node) => (
              <FolderRosterNode
                key={node.id}
                node={node}
                charsByFolder={availableByFolder}
                collapsed={collapsedFolders}
                onToggle={toggleFolderCollapse}
                depth={0}
                rosterCard={mobileRosterCard}
              />
            ))}
            {rootCharacters.length > 0 && (
              <div className="pt-2">
                <h3 className="mb-1 text-[10px] font-bold uppercase tracking-wide text-zinc-600">Folderless</h3>
                <div className="space-y-2">{rootCharacters.map(mobileRosterCard)}</div>
              </div>
            )}
            {availableCharacters.length === 0 && <p className="text-xs text-zinc-600">Everyone is seated.</p>}
          </div>
        </DialogShell>
      )}

      {adHocDamageCharId != null && (
        <DamageApplicationDialog
          targetCandidateIds={[adHocDamageCharId]}
          initialHalfDamageSteps={0}
          characters={new Map(Object.values(characters).map((e) => [e.character.id, e.character]))}
          onClose={() => setAdHocDamageCharId(null)}
        />
      )}
      {seatTarget && (
        <SeatPicker
          characterId={seatTarget.characterId}
          characterName={seatTarget.characterName}
          pairIndices={rows}
          participants={participants}
          onClose={() => setSeatTarget(null)}
        />
      )}
    </div>
  );
}
