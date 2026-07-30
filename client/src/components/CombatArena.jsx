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
import { REWARD_LABELS, REWARD_COLORS } from '../lib/counterDisplay.js';
import { setDraggingMove, onDraggingMoveChange } from '../lib/dragMoveState.js';
import FrameBar from './FrameBar.jsx';
import RollDialog from './RollDialog.jsx';
import Thumb from './Thumb.jsx';
import DropSlamGhost from './DropSlamGhost.jsx';

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
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(character.id);
          }}
          title="Remove from arena"
          className="absolute right-1 top-1 z-10 panel-cut-sm px-1 text-xs text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:bg-red-900/40 hover:text-red-400"
        >
          ✕
        </button>
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
          Stamina {pendingCost !== 0 ? previewStamina : character.current_stamina}/{character.max_stamina}
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
          className="h-8 w-8 shrink-0 panel-cut-sm border border-zinc-700 text-lg text-red-400 hover:bg-zinc-800 disabled:opacity-30"
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
          className="h-8 w-8 shrink-0 panel-cut-sm border border-zinc-700 text-lg text-green-400 hover:bg-zinc-800 disabled:opacity-30"
        >
          +
        </button>
        <button
          onClick={() => socket.emit('counter:delete', { counterId: counter.id })}
          title="Delete"
          className="panel-cut-sm px-1.5 text-zinc-600 hover:bg-red-900/40 hover:text-red-400"
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

// ---------- Tic Counter (combat redesign: now the Arena's centerpiece) ----------

// One square on the Tic Counter strip. `footprint` (startup/active/recovery
// tic ranges, relative to the square's own absolute Tic) is only non-null
// while something is being dragged and this square is the hovered drop
// point — it drives the live width preview described in the plan: the
// footprint grows/shrinks across neighboring squares as the move's own
// Startup/Active/Recovery length dictates, without ever revealing which
// square any *other* declared move actually landed on (that stays hidden
// until reveal).
const DECLARED_PHASE_COLOR = {
  startup: 'bg-yellow-500',
  active: 'bg-red-500',
  recovery: 'bg-blue-500',
  defense: 'bg-green-500',
};

// Which phase (if any) each already-declared move occupies at this absolute
// Tic — used for the small footprint-preview squares below, shown only to
// whoever currently has the declare floor, and only for **their own**
// previously-declared moves this round (see showDeclaredPreview and the
// declaredMoves filtering at the call site) — never another character's,
// declared or not. This is purely a self-service planning aid (don't
// double-book your own Tics), not a window into the opponent's timing.
function declaredPhasesAt(absoluteTic, declaredMoves) {
  const colors = [];
  for (const dm of declaredMoves) {
    if (absoluteTic < dm.placementTic || absoluteTic >= dm.recoveryEndTic) continue;
    const offset = absoluteTic - dm.placementTic;
    if (dm.defenseFramePositions?.includes(offset)) colors.push(DECLARED_PHASE_COLOR.defense);
    else if (absoluteTic < dm.revealTic) colors.push(DECLARED_PHASE_COLOR.startup);
    else if (absoluteTic < dm.activeEndTic) colors.push(DECLARED_PHASE_COLOR.active);
    else colors.push(DECLARED_PHASE_COLOR.recovery);
  }
  return colors;
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
  const zoneStyle = {
    startup: 'border-amber-300 bg-amber-500/80 shadow-[0_0_10px_rgba(251,191,36,0.45)]',
    active: 'border-rose-300 bg-rose-500/80 shadow-[0_0_10px_rgba(244,63,94,0.45)]',
    recovery: 'border-blue-300 bg-blue-500/80 shadow-[0_0_10px_rgba(59,130,246,0.45)]',
    blocked: 'border-zinc-600 bg-zinc-800 text-zinc-600',
  }[footprintZone];
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
function TicCounterCentral({
  phase,
  currentTic,
  roundStartTic,
  roundLength,
  draggingMove,
  hoverTic,
  setHoverTic,
  onDrop,
  declaredMoves,
  showDeclaredPreview,
  overflowTics,
  role,
}) {
  const squares = Array.from({ length: roundLength }, (_, i) => ({
    absoluteTic: roundStartTic + i,
    relative: i + 1,
  }));
  // Tic navigation redesign (decided): the GM steps the Tic Countdown by
  // left-clicking the square immediately before/after the current one,
  // instead of the header's old ◀/▶ buttons (removed — see
  // CombatHeaderBar.jsx). Only those two immediate neighbors are ever
  // clickable — combat:tic_forward/backward always step by exactly one Tic
  // server-side, there's no "jump to Tic N". At the round's last Tic there's
  // no next square to click, so a small "Next Round" button takes its place
  // in the row instead (see below).
  const currentIndex = squares.findIndex((sq) => sq.absoluteTic === currentTic);
  const canStepTic = role === 'gm' && phase === 'tic_countdown';
  const atLastTic = currentIndex === squares.length - 1;
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
        {phase === 'declaration' ? 'Drag a move here to declare' : 'Tic Counter'}
      </span>
      <div className="flex flex-wrap items-center justify-center gap-1.5 py-1">
        {squares.map((sq, i) => {
          const isNextTic = canStepTic && i === currentIndex + 1;
          const isPrevTic = canStepTic && i === currentIndex - 1;
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
              onClick={
                isNextTic
                  ? () => socket.emit('combat:tic_forward', {})
                  : isPrevTic
                    ? () => socket.emit('combat:tic_backward', {})
                    : undefined
              }
              clickTitle={
                isNextTic
                  ? `Click to advance to Tic ${sq.relative}`
                  : isPrevTic
                    ? `Click to go back to Tic ${sq.relative}`
                    : undefined
              }
            />
          );
        })}
        {canStepTic && atLastTic && (
          <button
            onClick={() => socket.emit('combat:next_round', {})}
            title="No more Tics this round — start the next one"
            className="panel-cut-sm h-11 shrink-0 bg-emerald-700 px-2 text-[10px] font-semibold uppercase leading-tight hover:bg-emerald-600"
          >
            Next
            <br />
            Round
          </button>
        )}
      </div>
      {showDeclaredPreview && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-[9px] text-zinc-600">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 bg-yellow-500" /> Startup
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 bg-red-500" /> Active
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 bg-blue-500" /> Recovery
          </span>
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 bg-green-500" /> Defense
          </span>
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

// A tight row of small declared-move cards flanking the Tic Counter — one
// band for Player-controlled characters (above), one for NPCs (below), per
// the combat redesign. Each card sits under its declaring character's name.
function MoveBand({ entries, tellById }) {
  if (!entries.length) return null;
  return (
    <div className="flex flex-wrap items-start justify-center gap-2">
      {entries.map(({ dm, move, characterName }) => (
        <div key={dm.id} className="flex flex-col items-center gap-0.5">
          <CompactDeclaredMoveCard dm={dm} move={move} tellById={tellById} />
          <span className="max-w-28 truncate text-[9px] text-zinc-600">{characterName}</span>
        </div>
      ))}
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
  const pair = pairs.find((p) => p.pair_index === participant.pair_index);
  if (participant.declared_this_round) {
    const sideFullyDeclared = participants
      .filter((p) => p.pair_index === participant.pair_index && p.side === participant.side)
      .every((p) => p.declared_this_round);
    return sideFullyDeclared ? 'waiting' : 'declared';
  }
  return pair && pair.declaring_side === participant.side ? 'declaring' : 'not_yet';
}

// GM-only glance at every seated participant's declaration progress across
// every pair at once (decided, combat redesign) — since declaration now runs
// independently per pair, this is the one place the GM sees the whole
// picture instead of piecing it together pair by pair. Clicking an NPC whose
// turn it currently is makes it the "active" NPC for the declare picker
// below — a Player never needs this, they only ever declare for their own
// single character. Only rendered during phase === 'declaration'; the whole
// table disappears once every pair finishes and the Tic Countdown starts.
function DeclarationStatusTable({ participants, characters, pairs, activeNpcId, onActivateNpc }) {
  return (
    <div className="w-full max-w-sm panel-cut-lg border border-zinc-800 bg-zinc-900/80 p-3">
      <h3 className="mb-2 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
        Declaration status
      </h3>
      <div className="space-y-1">
        {participants.map((p) => {
          const character = characters[p.character_id]?.character;
          const status = characterDeclareStatus(p, participants, pairs);
          const isNpc = character?.character_type === 'npc';
          const clickable = isNpc && status === 'declaring';
          const active = activeNpcId === p.character_id;
          return (
            <div
              key={p.character_id}
              onClick={clickable ? () => onActivateNpc(p.character_id) : undefined}
              className={`flex items-center justify-between gap-2 panel-cut-sm px-2 py-1 text-xs transition-colors ${
                clickable ? 'cursor-pointer hover:bg-zinc-800' : ''
              } ${active ? 'bg-brand-950/50 ring-1 ring-brand-600' : ''}`}
            >
              <span className="flex min-w-0 items-center gap-1 truncate text-zinc-200">
                <span className="truncate">{character?.name ?? '—'}</span>
                {isNpc && (
                  <span className="shrink-0 panel-cut-sm bg-purple-600/30 px-1 text-[9px] font-bold uppercase text-purple-300">
                    NPC
                  </span>
                )}
              </span>
              <span className={STATUS_META[status].className}>{STATUS_META[status].label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A single draggable move chip in the declare picker — dragging it onto the
// Tic Counter (see TicCounterCentral above) is how it actually gets
// declared; see dragMoveState.js for why the live-drag footprint preview
// needs that extra bit of shared state alongside the native dataTransfer
// payload used for the eventual drop.
function DeclareMoveCard({ character, move, roundStartTic, declaredMoves }) {
  const cost =
    move.stamina_cost > 0 ? `-${move.stamina_cost}` : move.stamina_cost < 0 ? `+${-move.stamina_cost}` : '0';
  return (
    <div
      draggable
      onDragStart={(e) => {
        // Matches computePlacementTic server-side exactly: no earlier than
        // the round's start, or the end of this character's own last-queued
        // move's full footprint (Startup+Active+Recovery, not just
        // Startup/reveal) if later — recoveryEndTic rides every
        // declaredMoves entry regardless of whether its identity is
        // revealed to this client (see server/index.js), so this is
        // accurate even for a still-secret prior declare.
        const priorBlockedUntil = declaredMoves
          .filter((dm) => dm.characterId === character.id)
          .map((dm) => dm.recoveryEndTic);
        const minPlacementTic = priorBlockedUntil.length
          ? Math.max(roundStartTic, ...priorBlockedUntil)
          : roundStartTic;
        const payload = {
          characterId: character.id,
          moveId: move.id,
          moveName: move.name,
          startupTics: move.startup_tics,
          activeTics: move.active_tics,
          recoveryTics: move.recovery_tics,
          minPlacementTic,
          staminaCost: move.stamina_cost,
          // right_tell_id/left_tell_id are only ever set together, exactly
          // when this move's Roll has an ambiguous Hand/Leg slot (see
          // db.js) — the drop handler uses this to decide whether to ask
          // Left/Right before declaring at all.
          ambiguous: move.right_tell_id != null,
          appendageSlot: move.roll_slots?.find((s) => s === 'Hand' || s === 'Leg') ?? null,
        };
        e.dataTransfer.setData('application/x-vtt-move', JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'copy';
        setDraggingMove(payload);
      }}
      onDragEnd={() => setDraggingMove(null)}
      title="Drag onto the Tic Counter to declare"
      className="cursor-grab select-none panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 transition-colors hover:border-brand-600 active:cursor-grabbing"
    >
      {move.name} <span className="text-zinc-500">({cost} Stamina)</span>
    </div>
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

// The declare panel for whichever single character currently has the floor
// — a Player's own character when it's their turn, or the GM's "active" NPC
// (picked from DeclarationStatusTable above). Each character presses their
// own Done Declaring individually now (decided, combat redesign) — there's
// no shared per-side button anymore.
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
  // GM-only: which NPC's declare picker is currently shown (see
  // DeclarationStatusTable above) — client-only convenience state, reset
  // whenever it's no longer that NPC's turn.
  const [activeNpcId, setActiveNpcId] = useState(null);
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

  // Clears the GM's "active NPC" selection once it's no longer that NPC's
  // turn (they finished declaring, the round moved on, etc.) — purely a UI
  // tidiness thing, the actual gating already lives server-side.
  useEffect(() => {
    if (!combat || activeNpcId == null) return;
    const p = combat.participants.find((pp) => pp.character_id === activeNpcId);
    const pair = p && (combat.pairs ?? []).find((pr) => pr.pair_index === p.pair_index);
    const stillTheirTurn = combat.phase === 'declaration' && p && !p.declared_this_round && pair?.declaring_side === p.side;
    if (!stillTheirTurn) setActiveNpcId(null);
  }, [combat, activeNpcId]);

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

  // Auto-open the same Roll dialog a manual "Roll" click would, the moment
  // a declared move actually reaches its reveal Tic — for whichever
  // character this viewer actually controls (their own PC, or any NPC for
  // the GM — same ownership rule as isRevealedToViewer server-side), and
  // only when the move has a Roll at all. dm.isRevealed can't drive this: it
  // goes true for the owner the instant they declare (see
  // mapDeclaredMovesForViewer), long before the real reveal Tic — this
  // instead mirrors the server's own postMoveReveals timing (phase must
  // have reached Tic Countdown, currentTic >= revealTic) so the prompt
  // never fires early during Declaration Phase.
  const seenRevealedRef = useRef(new Set());
  const autoRollInitializedRef = useRef(false);
  const [autoRollQueue, setAutoRollQueue] = useState([]);

  useEffect(() => {
    if (!combat) return;
    const currentRoundMoves = (combat.declaredMoves ?? []).filter(
      (dm) => dm.roundNumber === combat.roundNumber
    );
    const reallyRevealedNow =
      combat.phase === 'tic_countdown'
        ? currentRoundMoves.filter((dm) => dm.revealTic <= combat.currentTic)
        : [];
    if (!autoRollInitializedRef.current) {
      // First load (including a mid-fight page refresh): don't retroactively
      // prompt for moves that already revealed before this tab was open.
      for (const dm of reallyRevealedNow) seenRevealedRef.current.add(dm.id);
      autoRollInitializedRef.current = true;
      return;
    }
    const newlyRevealed = reallyRevealedNow.filter((dm) => !seenRevealedRef.current.has(dm.id));
    if (!newlyRevealed.length) return;
    for (const dm of newlyRevealed) seenRevealedRef.current.add(dm.id);
    const isMine = (dm) => {
      const entry = combat.characters[dm.characterId];
      if (!entry) return false;
      return role === 'player'
        ? dm.characterId === characterId
        : role === 'gm'
          ? entry.character.character_type === 'npc'
          : false;
    };
    const eligible = newlyRevealed.filter((dm) => {
      if (!isMine(dm)) return false;
      const move = combat.characters[dm.characterId]?.moves?.find((m) => m.id === dm.moveId);
      return move && (move.roll_dice?.length > 0 || move.roll_choice);
    });
    if (eligible.length) setAutoRollQueue((prev) => [...prev, ...eligible]);
  }, [combat, role, characterId]);

  // Defensive pruning for the rare case the queued character/move can't be
  // found by the time it's up (e.g. deleted mid-fight) — without this a
  // stale entry would block every prompt behind it forever.
  useEffect(() => {
    if (!autoRollQueue.length || !combat) return;
    const dm = autoRollQueue[0];
    const entry = combat.characters[dm.characterId];
    const move = entry?.moves?.find((m) => m.id === dm.moveId);
    if (!entry || !move) setAutoRollQueue((q) => q.slice(1));
  }, [autoRollQueue, combat]);

  if (!combat || !roster || !folders || !tells) {
    return <p className="text-zinc-500">Loading…</p>;
  }

  const { unevenCombatEnabled, participants, characters, counters, pairs, phase } = combat;
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

  // Whether THIS character currently has the floor: their own pair's
  // declaring_side matches their own side, and they haven't already pressed
  // Done Declaring this round (Phase 9 combat redesign — see combat_pairs).
  const isCharacterTurn = (charId) => {
    const p = participants.find((pp) => pp.character_id === charId);
    if (!p || p.declared_this_round) return false;
    const pair = (pairs ?? []).find((pr) => pr.pair_index === p.pair_index);
    return Boolean(pair && pair.declaring_side === p.side);
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
            <img src={src} alt="" className="h-full w-full object-cover" />
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

  const handleTicDrop = (absoluteTic) => (e) => {
    e.preventDefault();
    setHoverTic(null);
    const raw = e.dataTransfer.getData('application/x-vtt-move');
    if (!raw) return;
    const { characterId: draggedCharId, moveId, moveName, staminaCost, ambiguous, appendageSlot } = JSON.parse(raw);
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
        x: e.clientX,
        y: e.clientY,
      });
      return;
    }
    spawnDropGhost(
      e.clientX,
      e.clientY,
      <div className="panel-cut-sm border border-brand-400 bg-brand-600 px-3 py-1.5 font-display text-xs font-bold uppercase tracking-wide text-white shadow-lg">
        {moveName}
      </div>
    );
    socket.emit('move:declare', { characterId: draggedCharId, moveId, placementTic: absoluteTic });
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

  // ---------- Declared-move bands flanking the Tic Counter ----------

  const currentRoundMoves = declaredMoves.filter((dm) => dm.roundNumber === combat.roundNumber);
  // Tics at the start of THIS round already occupied by a previous round's
  // overflowing Recovery — general board-state awareness, broadcast to
  // everyone regardless of role/turn. Attributed by character name: which
  // character still has something recovering here isn't secret (their Tell
  // card is already visible in the Move Band the whole time), only the
  // move's own identity/details are — same distinction the rest of Combat
  // Timing already draws. Only ever built from prior rounds, so it can
  // never leak this round's own still-secret placements.
  const overflowTics = new Map(); // absoluteTic -> character names occupying it
  for (const dm of declaredMoves) {
    if (dm.roundNumber >= combat.roundNumber) continue;
    const name = characters[dm.characterId]?.character.name;
    if (!name) continue;
    for (let t = combat.roundStartTic; t < dm.recoveryEndTic; t++) {
      const names = overflowTics.get(t) ?? [];
      if (!names.includes(name)) names.push(name);
      overflowTics.set(t, names);
    }
  }
  const bandEntries = (predicate) =>
    currentRoundMoves
      .filter((dm) => {
        const entry = characters[dm.characterId];
        return entry && predicate(entry.character);
      })
      .sort((a, b) => a.placementTic - b.placementTic)
      .map((dm) => ({
        dm,
        move: characters[dm.characterId]?.moves?.find((m) => m.id === dm.moveId),
        characterName: characters[dm.characterId]?.character.name ?? '—',
      }));
  const playerBandEntries = bandEntries((c) => c.character_type === 'pc');
  const npcBandEntries = bandEntries((c) => c.character_type === 'npc');

  // ---------- Who currently has the declare-picker floor ----------

  let activeDeclareEntry = null;
  if (phase === 'declaration') {
    if (role === 'player' && isCharacterTurn(characterId)) {
      activeDeclareEntry = characters[characterId] ?? null;
    } else if (role === 'gm' && activeNpcId != null && isCharacterTurn(activeNpcId)) {
      activeDeclareEntry = characters[activeNpcId] ?? null;
    }
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Combat Arena</h1>
        <div className="flex items-center gap-3">
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
          {role === 'gm' && phase == null && participants.length > 0 && (
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

      {phase != null && (
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

          <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-600">Player moves</span>
          <MoveBand entries={playerBandEntries} tellById={tellById} />

          <TicCounterCentral
            phase={phase}
            currentTic={combat.currentTic}
            roundStartTic={combat.roundStartTic}
            roundLength={combat.roundLength}
            draggingMove={draggingMove}
            hoverTic={hoverTic}
            setHoverTic={setHoverTic}
            onDrop={handleTicDrop}
            declaredMoves={
              activeDeclareEntry
                ? currentRoundMoves.filter((dm) => dm.characterId === activeDeclareEntry.character.id)
                : []
            }
            showDeclaredPreview={Boolean(activeDeclareEntry)}
            overflowTics={overflowTics}
            role={role}
          />

          <MoveBand entries={npcBandEntries} tellById={tellById} />
          <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-600">NPC moves</span>
        </div>
      )}

      {phase === 'declaration' && (
        <div className="mb-4 flex flex-wrap items-start justify-center gap-3">
          {role === 'gm' && (
            <DeclarationStatusTable
              participants={participants}
              characters={characters}
              pairs={pairs ?? []}
              activeNpcId={activeNpcId}
              onActivateNpc={setActiveNpcId}
            />
          )}
          {activeDeclareEntry && (
            <ActiveDeclarePanel
              entry={activeDeclareEntry}
              roundStartTic={combat.roundStartTic}
              declaredMoves={declaredMoves}
            />
          )}
          {role === 'gm' && !activeDeclareEntry && (
            <div className="flex max-w-md items-center panel-cut-lg border border-dashed border-zinc-800 px-4 py-6 text-sm text-zinc-600">
              Click an NPC above whose turn it is to declare for them.
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
              <div key={rowIdx} className="flex items-stretch gap-3">
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
                          navigate={navigate}
                          declaredMoves={declaredMoves}
                          sideStillDeclaring={
                            phase === 'declaration' &&
                            (pairs ?? []).find((pr) => pr.pair_index === p.pair_index)?.declaring_side === p.side
                          }
                          onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(p.character_id))}
                        />
                      )
                  )}
                </div>
                <div className="w-px shrink-0 bg-zinc-700/50" title="Pair divider" />
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
                          navigate={navigate}
                          declaredMoves={declaredMoves}
                          sideStillDeclaring={
                            phase === 'declaration' &&
                            (pairs ?? []).find((pr) => pr.pair_index === p.pair_index)?.declaring_side === p.side
                          }
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

      {autoRollQueue.length > 0 && (() => {
        const dm = autoRollQueue[0];
        const entry = characters[dm.characterId];
        const move = entry?.moves?.find((m) => m.id === dm.moveId);
        if (!entry || !move) return null; // pruned by the effect above on the next render
        const sideDice = dm.appendageChoice ? (move.roll_choice?.[dm.appendageChoice] ?? []) : [];
        const dieIds = [...(move.roll_dice ?? []), ...sideDice].map((d) => d.dieId);
        return (
          <RollDialog
            title={`Roll ${move.name}${
              dm.appendageChoice ? ` (${dm.appendageChoice === 'right' ? 'Right' : 'Left'})` : ''
            } — ${entry.character.name}`}
            initialModifier={move.effective_roll_modifier ?? 0}
            onRoll={(modifier) =>
              socket.emit('pool:roll', { characterId: dm.characterId, dieIds, modifier })
            }
            onClose={() => setAutoRollQueue((q) => q.slice(1))}
          />
        );
      })()}

      <AnimatePresence>
        {dropGhosts.map((g) => (
          <DropSlamGhost key={g.id} x={g.x} y={g.y} onDone={() => removeDropGhost(g.id)}>
            {g.content}
          </DropSlamGhost>
        ))}
      </AnimatePresence>
    </div>
  );
}
