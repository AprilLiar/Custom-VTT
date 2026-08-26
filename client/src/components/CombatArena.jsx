import { useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import {
  getCombat,
  getCharacters,
  getCharacterFolders,
  getTells,
  getTags,
} from '../lib/api.js';
import {
  carriesBlockTag,
  carriesFeintTag,
  carriesMovementTag,
  sortTags,
  staminaModifierLabel,
} from '../lib/moveDisplay.js';
// Straight from the server's own rule module, deliberately. `declarableByHand`
// is what `move:declare` itself checks, and this picker's greying has to mean
// exactly the same thing — a card that looks draggable but gets silently
// refused is the failure mode a second copy of the rule would reintroduce.
// moveLogic.js is pure with no imports of its own (its header says so), which
// is what makes it safe to pull across; the same argument already runs the
// other way, with the server importing client/src/lib/matchups.js.
import { declarableByHand } from '../../../server/moveLogic.js';
import { portraitSrc } from '../lib/image.js';
import { dieLabel, tintFor, POOLS } from '../lib/dice.js';
import { ANATOMY } from '../lib/anatomy.js';
import { buildFolderTree } from '../lib/folders.js';
import { countRollSlot } from '../lib/diceSlots.js';
import { FRAME_PHASES, PHASE_BG, PHASE_LABEL, PHASE_ZONE, phaseBgAt, phaseAt } from '../lib/framePhaseColors.js';
import { MoveFilterChips, useMoveFilters } from '../lib/moveFilters.jsx';
import RoundCutscene from './RoundCutscene.jsx';
import DamageApplicationDialog from './DamageApplicationDialog.jsx';
import { REWARD_LABELS, REWARD_COLORS } from '../lib/counterDisplay.js';
import { setDraggingMove, onDraggingMoveChange } from '../lib/dragMoveState.js';
import {
  attackStartsByTic,
  registerLinkAnchor,
  setLinkHover,
  toggleLinkPin,
} from '../lib/attackTelegraph.js';
import useMoveLink, { useIsLinked } from '../lib/useMoveLink.js';
import MoveLinkOverlay from './MoveLinkOverlay.jsx';
import { useSocketRefresh } from '../lib/connection.js';
import FrameBar from './FrameBar.jsx';
import MoveCard from './MoveCard.jsx';
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
  // **Uneven Combat: this fighter's own matchup (decided, new).** The VS
  // divider's pair of badges only makes sense one-against-one; with several
  // fighters a side there is no single facing for a divider to describe. Passed
  // (and rendered) only when the pair is genuinely uneven, so a duel still
  // shows its number once, on the divider, exactly as before.
  matchup = null,
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
          {matchup && (
            <span className="ml-1 inline-flex items-center gap-1">
              <MatchupBadge
                value={matchup.score}
                mine={matchup.myStyleNames ?? []}
                theirs={matchup.theirStyleNames ?? []}
              />
              {matchup.opponentName && (
                <span className="text-[10px] text-zinc-500">vs {matchup.opponentName}</span>
              )}
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
                {poolDice.map((d) => {
                  // **Which Stat is this? (decided, new)** The Arena card used
                  // to show eight bare `d4` chips whose only identification was
                  // a hover title — unreadable at a glance, in the one view
                  // where glancing is the whole point. The icon is the same one
                  // the Vitruvian figure and the Damage dialog already use for
                  // that Stat (ANATOMY), so a fighter's Skull looks the same
                  // wherever you meet it.
                  //
                  // Left and Right share an icon, as they do everywhere else —
                  // the pair is always drawn in that order, and the title still
                  // names the side outright.
                  const Icon = ANATOMY[d.slot_name]?.Icon;
                  return (
                    <span
                      key={d.id}
                      title={d.slot_name}
                      className={`flex items-center gap-0.5 panel-cut-sm px-1 py-0.5 font-mono text-[10px] ${
                        d.status === 'incapacitated' ? 'text-zinc-700 line-through' : 'text-zinc-300'
                      }`}
                      style={{ backgroundColor: tintFor(d) || 'rgba(255,255,255,0.05)' }}
                    >
                      {Icon && <Icon size={10} className="shrink-0 opacity-70" aria-hidden="true" />}
                      {dieLabel(d.current_size, d.bonus)}
                    </span>
                  );
                })}
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
// One Tic square's footprint, in one place — the strip's own squares and
// the `+N` overflow marker that sits at the end of the same row, which must
// match it exactly.
//
// **Fixed at every viewport, deliberately (decided).** A responsive version
// of this was tried and reverted: scaling the squares with the window made
// the counter feel unmoored and gained nothing — a Tic is a fixed unit of
// game time, and its square should look like the same object on every
// screen. Extra window width belongs to the things that actually have more
// to say at a larger size (the roster, the lanes, the cutscene's event log),
// not to inflating a seven-square ruler.
export const TIC_SQUARE_SIZE = 'h-11 w-11';

export function TicSquare({
  relativeTic,
  isCurrent,
  footprintZone,
  declaredPhases,
  overflowNames,
  attackStarts,
  linkAnchor,
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
  // Carried-over frames from last round, as { name, phase } — drawn in their
  // own phase colours rather than as an anonymous badge (see overflowTics).
  const carried = overflowNames ?? [];

  // Attack telegraph (see attackTelegraph.js): every declared attack whose
  // Startup begins on this Tic. `linkAnchor` is what separates the Arena's
  // own counter — which has the Tell cards to draw a connector to — from
  // the header strip, where the glow is a bare marker with nothing on the
  // page to link it to.
  const starts = attackStarts ?? [];
  const startIds = starts.map((s) => s.declaredMoveId);
  const startKey = startIds.join(',');
  const { ids: linkedIds } = useMoveLink();
  const isLinked = startIds.some((id) => linkedIds.includes(id));
  const glowRef = useRef(null);
  useEffect(() => {
    if (!linkAnchor || !startIds.length || !glowRef.current) return undefined;
    const el = glowRef.current;
    const offs = startIds.map((id) => registerLinkAnchor('tic', id, el));
    return () => offs.forEach((off) => off());
    // startKey stands in for startIds, which is a fresh array every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkAnchor, startKey]);

  // One square per wind-up, so there is only ever the one sentence to write —
  // see attackStartsByTic on why the run's length is not published.
  const telegraphTitle = starts.length
    ? ` — ${starts.map((s) => s.characterName ?? 'Someone').join(', ')} start${
        starts.length === 1 ? 's' : ''
      } an attack here`
    : '';
  const title = clickTitle ?? `Tic ${relativeTic}${telegraphTitle}${
    carried.length
      ? ` — ${carried
          .map((c) => `${c.name}'s ${PHASE_LABEL[c.phase] ?? c.phase}`)
          .join(', ')} (carried over from last round)`
      : ''
  }`;
  // Tap-to-place owns the click whenever a move is mid-placement; the
  // telegraph's own tap-to-pin only takes over when it doesn't, so
  // declaring a move never gets hijacked by an informational overlay.
  const handleClick = onClick ?? (linkAnchor && startIds.length ? () => toggleLinkPin(startIds) : undefined);
  return (
    <motion.div
      ref={ref}
      key={isCurrent ? 'current' : 'idle'}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onClick={handleClick}
      onMouseEnter={linkAnchor && startIds.length ? () => setLinkHover(startIds) : undefined}
      onMouseLeave={linkAnchor && startIds.length ? () => setLinkHover([]) : undefined}
      data-move-link-anchor={linkAnchor && startIds.length ? '' : undefined}
      title={title}
      initial={isCurrent ? { scale: 1.5 } : false}
      animate={{ scale: isCurrent && !zoneStyle ? 1.1 : 1 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className={`relative flex ${TIC_SQUARE_SIZE} shrink-0 items-center justify-center panel-cut border text-sm font-bold transition-colors duration-150 ${
        handleClick ? 'cursor-pointer hover:border-brand-400 hover:shadow-[0_0_10px_rgb(var(--color-brand-rgb)/45%)]' : ''
      } ${
        zoneStyle ??
        (isCurrent
          ? 'border-brand-300 bg-brand-600 text-white shadow-[0_0_16px_rgb(var(--color-brand-rgb)/55%)]'
          : 'border-zinc-700 bg-zinc-900/80 text-zinc-400 hover:border-zinc-500')
      }`}
    >
      {/* Attack telegraph: a faint grey glow on the Tic where a declared
          attack's first Startup frame sits — public to everyone, which is
          the whole point (you cannot time a guard against a wind-up you
          can't see). Its own absolutely-positioned layer rather than a
          restyle of the square, so it composes with whatever the square
          already is — the brand-red current-Tic state, a drag footprint
          zone — instead of fighting it for the same properties.
          **The glow is drawn INWARD (inset shadows), not as an outer halo.**
          The square's own `panel-cut` clip-path clips every descendant and
          every outer box-shadow to the cut polygon, so a halo around the
          square is painted and then immediately thrown away — the first
          attempt here looked correct in the DOM and was invisible on
          screen. Inset shadows paint inside the padding box and survive
          the clip.
          Deliberately grey: it says "something begins here", not "look at
          this", and it must stay clearly subordinate to the red current
          Tic. Brightens while linked so hovering a Tell picks it out. */}
      {starts.length > 0 && (
        <span
          ref={glowRef}
          aria-hidden
          className={`pointer-events-none absolute inset-0 transition-all duration-200 ${
            isLinked
              ? 'bg-zinc-100/15 shadow-[inset_0_0_0_2px_rgb(228_228_231_/_95%),inset_0_0_16px_3px_rgb(228_228_231_/_55%)]'
              : 'bg-zinc-100/[0.06] shadow-[inset_0_0_0_1.5px_rgb(228_228_231_/_65%),inset_0_0_12px_2px_rgb(228_228_231_/_28%)]'
          }`}
        />
      )}
      {relativeTic}
      {/* A carried-over move paints the top edge of the square in its own
          frame colour — the same phase palette as everywhere else, so a
          carried Recovery is the same blue here as in the cutscene. Shown to
          everyone: this is public board state ("these Tics are spoken for"),
          which is why it is drawn as the thing it is rather than as a grey
          marker that it exists. */}
      {carried.length > 0 && (
        <div className="absolute inset-x-0 top-0 flex h-1.5 overflow-hidden">
          {carried.slice(0, 3).map((c, i) => (
            <span key={i} className={`h-full flex-1 ${PHASE_BG[c.phase] ?? 'bg-zinc-500'}`} />
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
  attackStarts, // Attack telegraph: Map<absoluteTic, marks> — built by the caller (see attackStartsByTic), like overflowTics
  linkAttackStarts, // only the Arena's own counter has Tell cards on screen to draw a connector to
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

  // Overflow indicator (decided, new): a move whose footprint runs past this
  // round's last Tic carries into the next one — a real and consequential
  // rule (it floors where that character may place next round) that the
  // strip gave no sign of at all, because the strip stops at the round
  // boundary. When the move currently being placed would overflow, a `+N`
  // appears at the end; hovering it previews the next round with exactly the
  // frames that spill into it.
  const overflowPreview = (() => {
    if (!draggingMove || hoverTic == null) return null;
    const minTic = draggingMove.minPlacementTic ?? roundStartTic;
    const effectiveTic = Math.max(hoverTic, minTic);
    const { startupTics, activeTics, recoveryTics } = draggingMove;
    const recoveryEnd = effectiveTic + startupTics + activeTics + recoveryTics;
    const nextRoundStart = roundStartTic + roundLength;
    if (recoveryEnd <= nextRoundStart) return null;
    // Same phase math as zoneFor, walked across the NEXT round's own window.
    const startupEnd = effectiveTic + startupTics;
    const activeEnd = startupEnd + activeTics;
    const phaseAt = (t) => {
      if (t >= effectiveTic && t < startupEnd) return 'startup';
      if (t >= startupEnd && t < activeEnd) return 'active';
      if (t >= activeEnd && t < recoveryEnd) return 'recovery';
      return null;
    };
    return {
      tics: recoveryEnd - nextRoundStart,
      squares: Array.from({ length: roundLength }, (_, i) => ({
        relative: i + 1,
        zone: phaseAt(nextRoundStart + i),
      })),
    };
  })();

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
          "start/end fade") without a second scroll-position-tracking effect.
          It needs horizontal padding wider than its own 12px fade: without
          it the gradient lands on the first and last Tic squares and fades
          them out, which reads as the counter being cut off at both edges
          rather than as a scroll hint. The padding gives the fade its own
          empty space to happen in. */}
      <div
        className="flex max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain px-4 py-1 [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)]"
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
              attackStarts={attackStarts?.get(sq.absoluteTic)}
              linkAnchor={linkAttackStarts}
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
        {overflowPreview && (
          <div className="group relative shrink-0">
            <span
              className={`flex ${TIC_SQUARE_SIZE} items-center justify-center panel-cut border border-amber-500/70 bg-amber-950/40 font-display text-sm font-bold text-amber-300`}
              title={`Runs ${overflowPreview.tics} Tic${
                overflowPreview.tics === 1 ? '' : 's'
              } into the next round`}
            >
              +{overflowPreview.tics}
            </span>
            {/* Hover reveals the next round with the spilled frames in
                place, so "how much of my next round does this eat?" is
                answerable before committing rather than after. */}
            <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 panel-cut border border-amber-700/60 bg-zinc-950 p-2 shadow-2xl shadow-black/80 group-hover:block">
              <div className="mb-1 whitespace-nowrap font-display text-[10px] uppercase tracking-widest text-amber-300">
                Next round
              </div>
              <div className="flex gap-1">
                {overflowPreview.squares.map((sq) => (
                  <span
                    key={sq.relative}
                    className={`flex h-7 w-7 items-center justify-center panel-cut-sm border text-[10px] font-bold ${
                      sq.zone
                        ? `${PHASE_ZONE[sq.zone]} text-zinc-950`
                        : 'border-zinc-700 bg-zinc-900 text-zinc-600'
                    }`}
                  >
                    {sq.relative}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
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
          <span className="flex h-1.5 w-4 overflow-hidden">
            <span className="h-full flex-1 bg-blue-500" />
          </span>{' '}
          top edge = a move carried over from last round is still running here (hover for whose)
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
  // Tell names were being cut off (decided, fix): the card was a fixed w-28
  // with a `truncate` name, which left anything past about eight characters
  // as an ellipsis — in a panel that had plenty of unused width beside it.
  // The card is wider now and the name **wraps** rather than truncating, so
  // a long Tell is readable at any length instead of readable up to a
  // guess. `break-words` covers a single long unbroken word, which wrapping
  // alone would still overflow.
  return (
    <div className="flex w-44 items-center gap-2 panel-cut border border-zinc-800 bg-zinc-900/60 p-2 opacity-60 grayscale">
      {showBoth ? (
        <>
          <Thumb record={rightTell} name={rightTell?.name} size="h-7 w-7" />
          <Thumb record={leftTell} name={leftTell?.name} size="h-7 w-7" />
        </>
      ) : (
        <Thumb record={shown} name={shown?.name} size="h-7 w-7" />
      )}
      <span className="min-w-0 flex-1 break-words text-[11px] font-semibold uppercase leading-tight text-zinc-400">
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
// A declared move you're allowed to see, with its full card one hover (or
// one tap) away. The compact card is deliberately tiny — it has to sit in a
// lane beside several others — so "what does this actually do again?" had no
// answer without leaving the Arena. The full card renders as an overlay
// above everything rather than expanding in place, because expanding one
// card reflows the whole lane underneath it.
// Where to put a declared move's full card so it sits fully on screen.
//
// **Why this is measured rather than done in CSS.** The card used to be an
// `absolute … z-50` child of the compact card, and it was covered by other
// Arena UI anyway: its own parent sets `perspective` for the flip animation,
// and a non-`none` perspective establishes a stacking context, so that z-50
// only ever competed with its siblings *inside* one small card. No z-index
// there can beat a later stacking context — the layer has to leave the
// subtree entirely, which means a portal, which means viewport coordinates.
// (Exactly the failure mode DialogShell hit when a transformed ancestor
// re-parented its `fixed`; MoveLinkOverlay and MovePickerDialog already
// portal for the same reason.)
//
// Clamping is what makes it work on a phone: a fixed-width card centred on a
// lane card near the screen edge would otherwise hang off it, and the lane
// strip scrolls horizontally, so "near the edge" is the normal case there.
const HOVER_CARD_WIDTH = 288; // w-72, and the max-w below keeps CSS in step
const HOVER_CARD_GAP = 8;

function useHoverCardPosition(anchorRef, open) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return undefined;
    }
    let frame = 0;
    const measure = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(HOVER_CARD_WIDTH, vw - HOVER_CARD_GAP * 2);
      // Centred on the anchor, then pulled back inside the viewport.
      const left = Math.min(
        Math.max(HOVER_CARD_GAP, r.left + r.width / 2 - width / 2),
        vw - width - HOVER_CARD_GAP
      );
      // Above by preference — the compact card sits low in a lane and the
      // space above it is usually empty. Flip below when it won't fit, which
      // on a short mobile viewport is most of the time.
      const spaceAbove = r.top;
      const below = spaceAbove < vh / 2;
      setPos({ left, width, below, top: below ? r.bottom + HOVER_CARD_GAP : undefined,
        bottom: below ? undefined : vh - r.top + HOVER_CARD_GAP });
    };
    const remeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture phase: the lane strip and the page shell are their own scroll
    // containers and neither bubbles scroll to window (same reason
    // MoveLinkOverlay listens this way).
    window.addEventListener('scroll', remeasure, true);
    window.addEventListener('resize', remeasure);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', remeasure, true);
      window.removeEventListener('resize', remeasure);
    };
  }, [anchorRef, open]);
  return pos;
}

function CompactDeclaredMoveCard({ dm, move, tellById, allMoves = [] }) {
  const revealed = dm.isRevealed && move;
  const [showCard, setShowCard] = useState(false);

  // Move telegraph (see attackTelegraph.js): this card is the Tell end of the
  // connector drawn to the glowing Tic where the move's Startup begins. Every
  // move that has not gone public yet glows — guards included, since the
  // absence of a glow was itself a free read that the opponent was turtling —
  // and the same condition drives both ends, so they can never disagree about
  // which moves participate.
  const telegraphed = !dm.publiclyRevealed;
  const isLinked = useIsLinked(telegraphed ? dm.id : null);
  const cardRef = useRef(null);
  useEffect(() => {
    if (!telegraphed || !cardRef.current) return undefined;
    return registerLinkAnchor('tell', dm.id, cardRef.current);
  }, [telegraphed, dm.id]);

  // Hover drives the link only from the **Tell** face. On a face this
  // viewer can already read, hover is spoken for — it pops the full
  // MoveCard, which renders upward, straight across the path the line
  // would take to the Tic Counter above. The anchor stays registered
  // either way, so hovering the *Tic* still points back at an
  // already-revealed card; only the card->Tic direction defers.
  const linkOnHover = telegraphed && !revealed;
  const cardPos = useHoverCardPosition(cardRef, showCard && revealed);

  // Feint Tag: this declaration is concealed from everyone but its owner
  // until it reveals. `publiclyRevealed` is what ends the concealment, not
  // `isRevealed` — the owner's own view is always revealed, so keying off
  // that would mean the badge never appeared at all.
  const hiddenByFeint = Boolean(dm.feintMasked) && !dm.publiclyRevealed;

  // **How it was opened decides how it closes**, and this is the whole reason
  // tapping appeared to do nothing on a phone. A tap emits (measured, not
  // assumed): pointerdown → mouseenter → click → mouseout → **mouseleave**.
  // Touch browsers synthesize a hover and then immediately drop it, so an
  // unconditional `onMouseLeave` close fired a few milliseconds after the tap
  // had correctly opened the card — it opened and shut inside one gesture.
  //
  // A ref, not state: it is read by handlers firing within the same gesture
  // as the write, so it has to update synchronously rather than at the next
  // render.
  const openedByTouch = useRef(false);

  // Touch gets no usable mouseleave, so the way out is tapping elsewhere —
  // the same escape hatch MoveLinkOverlay gives a pinned connector.
  useEffect(() => {
    if (!showCard) return undefined;
    const onPointerDown = (e) => {
      if (cardRef.current?.contains(e.target)) return;
      openedByTouch.current = false;
      setShowCard(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showCard]);

  return (
    <div
      ref={cardRef}
      data-move-link-anchor={telegraphed ? '' : undefined}
      style={{ perspective: 1000 }}
      className={`relative transition-shadow duration-200 ${
        isLinked ? 'shadow-[0_0_16px_3px_rgb(228_228_231_/_30%)]' : ''
      }`}
      onMouseEnter={() => {
        // Skipped after a tap: the synthesized hover isn't a second intent.
        if (revealed && !openedByTouch.current) setShowCard(true);
        if (linkOnHover) setLinkHover([dm.id]);
      }}
      onMouseLeave={() => {
        // The link half still runs either way — only the card's close is
        // modality-dependent.
        if (!openedByTouch.current) setShowCard(false);
        if (linkOnHover) setLinkHover([]);
      }}
      // **Open, never toggle**, and the touch path is `pointerdown` rather
      // than `click`: pointerdown is the first event of the gesture, so the
      // card is up before the synthesized mouse events arrive to confuse it.
      // A toggling `onClick` was the original defect — the hover had already
      // opened the card, so the click closed it again.
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch' || !revealed) return;
        openedByTouch.current = true;
        setShowCard(true);
      }}
      onClick={() => {
        // Tap-to-pin is the touch path for the connector — there is no hover
        // on a phone, so without this the line would simply not exist there
        // (see toggleLinkPin). Only reachable on a card whose face this
        // viewer can't read, which is exactly when there is no card to show.
        if (!revealed && telegraphed) toggleLinkPin([dm.id]);
      }}
    >
      {createPortal(
        <AnimatePresence>
          {showCard && revealed && cardPos && (
            <motion.div
              initial={{ opacity: 0, y: cardPos.below ? -6 : 6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: cardPos.below ? -6 : 6, scale: 0.96 }}
              transition={{ duration: 0.14 }}
              style={{
                left: cardPos.left,
                top: cardPos.top,
                bottom: cardPos.bottom,
                width: cardPos.width,
              }}
              // z-[80]: above the Tell↔Tic connector line (z-[70]) — this
              // card renders straight across the path that line takes, and
              // it is the thing being read — but below the drag ghost
              // (z-[100]), which should stay on top of everything mid-drag.
              //
              // pointer-events-none is deliberate: portalled out of the
              // anchor's subtree, hovering onto the card would fire the
              // anchor's own mouseleave and close it. It is a description to
              // read, not a surface to click, so it simply doesn't take the
              // pointer — which also means it can never swallow a click on
              // whatever it happens to be covering.
              className="pointer-events-none fixed z-[80] max-w-[calc(100vw-1rem)] panel-cut border border-brand-700/60 bg-zinc-950 p-2 shadow-2xl shadow-black/80"
            >
              <MoveCard
                move={move}
                allMoves={allMoves}
                tell={tellById.get(move.tell_id)}
                rightTell={move.right_tell_id ? tellById.get(move.right_tell_id) : undefined}
                leftTell={move.left_tell_id ? tellById.get(move.left_tell_id) : undefined}
              />
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
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
              className={`flex w-44 items-center gap-2 panel-cut border p-2 text-left ${
                hiddenByFeint
                  ? 'border-violet-700/60 bg-violet-950/25'
                  : 'border-brand-800/60 bg-brand-950/30'
              }`}
            >
              <Thumb record={move} name={move.name} size="h-7 w-7" />
              <div className="min-w-0 flex-1">
                {/* Same width and wrapping as the Tell face above, so a lane
                    doesn't visibly jump when a move reveals. */}
                <div className="break-words text-xs font-semibold leading-tight text-zinc-100">{move.name}</div>
                {/* Feint Tag: only this card's owner ever sees this face at
                    all before the reveal — the row itself is withheld from
                    everyone else (mapDeclaredMovesForViewer) — so the badge
                    is a reassurance rather than a leak: "they cannot see
                    this one." */}
                {hiddenByFeint && (
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-violet-300">
                    ◌ hidden — feinted into
                  </div>
                )}
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


// One side's Stance matchup modifier, shown either side of the Arena's VS
// divider so both fighters can see what they are up against before anyone
// commits (see getPairStanceMatchup server-side, which is also what feeds the
// real roll bonus — this is the same number, not a second calculation).
//
// Stance-only by design: it is a standing fact about the two fighters, true
// during Declaration when nothing has revealed. A move's own Combat Style
// adds to it on that move's roll, which the tooltip says rather than trying
// to animate a number that would change every reveal.
function MatchupBadge({ value, mine, theirs }) {
  const tone =
    value > 0
      ? 'border-emerald-600/60 bg-emerald-950/60 text-emerald-300'
      : value < 0
        ? 'border-rose-600/60 bg-rose-950/60 text-rose-300'
        : 'border-zinc-700 bg-zinc-900 text-zinc-500';
  const sign = value > 0 ? `+${value}` : `${value}`;
  return (
    <span
      title={`Stance matchup: ${mine.join(' + ')} vs ${theirs.join(' + ')} — ${sign} on this fighter's rolls. A move's Combat Style adds to this on that move's own roll.`}
      className={`font-display panel-cut-sm border px-1.5 py-0.5 text-[11px] font-bold leading-none tabular-nums ${tone}`}
    >
      {sign}
    </span>
  );
}

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
  // Flattened so a Grappling move's four directions can be named in the
  // hover card. Default moves appear on every character, so this has
  // duplicates — harmless, since it is only ever looked up by id.
  const allMoves = Object.values(characters).flatMap((e) => e?.moves ?? []);
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
              className={`max-w-44 truncate text-[10px] ${
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
                  <CompactDeclaredMoveCard
                    key={dm.id}
                    dm={dm}
                    move={move}
                    tellById={tellById}
                    allMoves={allMoves}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
  // Full width, not max-w-3xl (decided, fix): the Arena around this panel
  // takes the whole window, and the lanes were the one thing still squeezed
  // into a column — which is exactly the unused space the Tell cards needed.
  return (
    <div className="w-full space-y-1.5">
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
// The move this character would be declaring right after — the queued one
// whose footprint ends latest, which is exactly what the server's Requirement
// gate compares against (see move:declare). Null when they have nothing
// queued.
//
// `moveId` is only non-null on entries the viewer is entitled to see, but the
// declare picker only ever renders for a character the viewer owns, and an
// owner sees their own moves from the instant they declare them — so this is
// never guessing at a hidden id.
function lastQueuedMoveId(characterId, declaredMoves) {
  const mine = declaredMoves.filter((dm) => dm.characterId === characterId);
  if (!mine.length) return null;
  return mine.reduce((a, b) => (b.recoveryEndTic > a.recoveryEndTic ? b : a)).moveId ?? null;
}

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
    // The cost after this character's own Perks (Perfect Player discounts a
    // Dodge) — the server resolves it per character in getMovesFor and the
    // affordability check and the commit both use the same figure, so quoting
    // the raw column here would show a number nobody is ever charged. Falls
    // back for a payload built from a move fetched somewhere that has not
    // resolved it.
    staminaCost: move.effective_stamina_cost ?? move.stamina_cost,
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
// The full MoveCard for a move in the declare picker, on the front-most
// layer (decided, new). Reading what a move actually does used to require
// leaving the Arena for the Compendium — the picker showed a name, a Stamina
// figure and a frame glyph and nothing else, which is not enough to choose
// with.
//
// **Opened only by the ⓘ, on every device (decided, revised).** Hover was
// tried as a mouse shortcut and removed: the card covers the Tic Counter you
// are aiming at, the pointer that opened it is already on the chip you are
// about to drag, and it stays up until the pointer leaves — so reaching for a
// move hid the thing you needed to see to place it. Tap was never available
// either, since tapping a chip is how a move gets picked up for tap-to-place.
// Reading and aiming are separate intentions; they get separate controls, and
// starting to aim (drag or tap) closes the card. Same portal, same z-[80],
// and the same reason as CompactDeclaredMoveCard's: an ancestor with
// `perspective` establishes a stacking context no z-index inside it escapes.
function DeclareMoveInfo({ move, anchorRef, open, onClose, tellById, allMoves, tags }) {
  const pos = useHoverCardPosition(anchorRef, open);
  const moveTags = sortTags((tags ?? []).filter((t) => (move.tag_ids ?? []).includes(t.id)));
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e) => {
      if (anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onClose, anchorRef]);
  return createPortal(
    <AnimatePresence>
      {open && pos && (
        <motion.div
          initial={{ opacity: 0, y: pos.below ? -6 : 6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: pos.below ? -6 : 6, scale: 0.96 }}
          transition={{ duration: 0.14 }}
          style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}
          className="pointer-events-none fixed z-[80] max-w-[calc(100vw-1rem)] panel-cut border border-brand-700/60 bg-zinc-950 p-2 shadow-2xl shadow-black/80"
        >
          <MoveCard
            move={move}
            allMoves={allMoves}
            tags={moveTags}
            tell={tellById?.get(move.tell_id)}
            rightTell={move.right_tell_id ? tellById?.get(move.right_tell_id) : undefined}
            leftTell={move.left_tell_id ? tellById?.get(move.left_tell_id) : undefined}
          />
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

function DeclareMoveCard({ character, move, roundStartTic, declaredMoves, tags, tellById, allMoves, styleDeltas, held = false, legsBroken = false, unarmed = false }) {
  const chipRef = useRef(null);
  const [showCard, setShowCard] = useState(false);
  // Block Tag (the first Tag automation): a Block has no up-front cost to
  // quote — what it will cost depends on what it ends up absorbing — so the
  // card advertises its multiplier instead of a number that would always
  // read "0 Stamina" and mean "free".
  const isBlock = carriesBlockTag(move.tag_ids, tags);
  // See buildDeclarePayload: the per-character figure, not the template's.
  const effectiveCost = move.effective_stamina_cost ?? move.stamina_cost;
  const cost = effectiveCost > 0 ? `-${effectiveCost}` : effectiveCost < 0 ? `+${-effectiveCost}` : '0';
  // Worth pointing at when a Perk actually moved it — a Dodge quoting 1 when
  // the Compendium says 3 reads as a bug unless the card says why.
  const discounted = effectiveCost !== move.stamina_cost;
  const payload = buildDeclarePayload(character, move, roundStartTic, declaredMoves);
  // Requirement (decided, new): this move may only be declared immediately
  // after the one it names. The server enforces it — this only stops the
  // player dragging something that would be silently refused, which is the
  // same reason an unaffordable move isn't simply left to fail.
  //
  // **Secondary (decided, new)** rides the same gate. A Secondary move with no
  // Requirement can never be declared by hand at all — it exists to be reached
  // off a grapple's cross, and the engine puts it there. One shared pure rule
  // (`declarableByHand`) decides both here and in the server's own gate, so a
  // card that looks draggable and an event that gets refused cannot disagree.
  const requiredId = move.requirement_move_id ?? null;
  const blockedByRequirement = !declarableByHand({
    isSecondary: Boolean(move.is_secondary),
    requirementMoveId: requiredId,
    previousMoveId: lastQueuedMoveId(character.id, declaredMoves),
  });
  const requiredName = requiredId != null ? (move.requirement_move_name ?? 'another move') : null;
  // A second, independent reason a card can be closed: footwork on a broken
  // leg. Checked after the Requirement gate so a move that is blocked by both
  // reports the one the player can actually do something about first.
  const blockedByLeg = legsBroken && carriesMovementTag(move.tag_ids, tags);
  // A third: a Move whose Roll names the Weapon slot, in the hands of somebody
  // carrying nothing. Refused server-side for the same reason it is greyed
  // here — such a move would otherwise roll one die fewer than it advertises
  // and quietly be worth less than it says.
  const blockedByWeapon = unarmed && (move.roll_slots ?? []).includes('Weapon');
  const blocked = blockedByRequirement || blockedByLeg || blockedByWeapon;
  const blockedReason = blockedByRequirement
    ? requiredId != null
      ? `Can only be declared immediately after ${requiredName}.`
      : 'Secondary — this move is reached from a grapple, never declared by hand.'
    : blockedByLeg
      ? 'A broken Leg — this move is Movement, and you cannot move on it.'
      : 'No weapon in hand — this move rolls one, so there is nothing to swing.';
  // Combat Style (decided, new): a move carrying its own style joins it to its
  // user's stance for the matchup, which is worth a flat modifier on the roll —
  // a real, sometimes decisive number that the picker used to keep to itself.
  // It is shown here rather than only on the full card because this is where
  // the choice is actually made. Null whenever the matchup rule doesn't apply
  // to this fighter at all (no single opponent, a missing stance), in which
  // case the style still exists but is worth nothing to show.
  const styleMod =
    move.combat_style_attribute_id != null
      ? (styleDeltas ?? []).find((d) => d.attributeId === move.combat_style_attribute_id) ?? null
      : null;
  return (
    // **`min-w-0 max-w-full` or a long name walks out of the panel (fix).**
    // A flex item defaults to `min-width: auto`, which means it refuses to
    // shrink below its content's own width — so a move called "Descending
    // Thunderclap of the Iron Mountain School" made this chip wider than the
    // declare panel and the Stamina cost was clipped off at the panel's edge,
    // with the ⓘ badge left floating out in the margin.
    <div ref={chipRef} className="relative min-w-0 max-w-full">
      <DeclareMoveInfo
        move={move}
        anchorRef={chipRef}
        open={showCard}
        onClose={() => setShowCard(false)}
        tellById={tellById}
        allMoves={allMoves}
        tags={tags}
      />
      {/* Outside the draggable button on purpose: nested inside it, a press
          on the ⓘ starts the drag instead of opening the card. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShowCard((v) => !v);
        }}
        title={`Read ${move.name}`}
        aria-label={`Read ${move.name}`}
        className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-[10px] font-bold text-zinc-400 hover:border-brand-500 hover:text-brand-300"
      >
        i
      </button>
    <button
      type="button"
      // **The ⓘ is the only way in (decided, fix).** Hovering the chip used to
      // open the card too, which sounded like a free shortcut and was not: the
      // card pops over the Tic Counter, the pointer is already on the chip you
      // are about to drag, and it does not close until the pointer leaves —
      // so the moment you reached for a move you lost sight of where to put
      // it. Reading a move and aiming it are two different intentions and now
      // take two different actions.
      draggable={!blocked}
      disabled={blocked}
      onDragStart={(e) => {
        // Picking the move up dismisses whatever you were reading,
        // unconditionally — the card and the drop target occupy the same
        // screen, so one has to give way, and the drag is the deliberate act.
        setShowCard(false);
        e.dataTransfer.setData('application/x-vtt-move', JSON.stringify(payload));
        e.dataTransfer.effectAllowed = 'copy';
        setDraggingMove(payload);
      }}
      onDragEnd={() => setDraggingMove(null)}
      // The tap-to-place half of the same gesture: selecting a move to aim is
      // the same intention as dragging one, so it closes the card too.
      onClick={() => {
        setShowCard(false);
        if (blocked) return;
        // Tapping the one you are already holding puts it down. Without this
        // the only way out of a mis-tap is the banner's Cancel, which sits at
        // the other end of the screen on a phone.
        setDraggingMove(held ? null : payload);
      }}
      title={
        blocked
          ? blockedReason
          : 'Drag onto the Tic Counter, or tap then tap a Tic, to declare'
      }
      // `text-left` because a <button> centres its text by default, which only
      // showed once a name was long enough to wrap onto a second line — a
      // centred fragment under a left-aligned one reads as a broken card.
      // `pr-6` reserves the top-right corner for two things that were sitting
      // on top of the text: the ⓘ badge (absolutely positioned half outside
      // this button) and `panel-cut-sm`'s own bevel, which shaves the last few
      // pixels of whatever reaches the corner. The chip is content-sized, so
      // the first line always ran right up to that corner — every name lost
      // its closing bracket, and a long one lost more.
      className={`flex min-h-11 min-w-0 max-w-full select-none flex-col items-start gap-1 panel-cut-sm border py-1.5 pl-2 pr-6 text-left text-xs transition-colors ${
        blocked
          ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-600'
          : held
            ? 'cursor-grab border-brand-400 bg-brand-800/50 text-white ring-1 ring-brand-400/60'
            : 'cursor-grab border-zinc-700 bg-zinc-800 text-zinc-200 hover:border-brand-600 active:cursor-grabbing'
      }`}
    >
      <span className="block min-w-0 break-words">
        {move.name}{' '}
        <span
          className={isBlock ? 'text-sky-400/80' : discounted ? 'text-emerald-400/90' : 'text-zinc-500'}
          title={discounted ? `A Perk of yours is moving this: normally ${move.stamina_cost} Stamina.` : undefined}
        >
          {isBlock ? `(Block ${staminaModifierLabel(move.stamina_modifier)} Stamina)` : `(${cost} Stamina)`}
        </span>
        {/* Named, not just greyed. A card that is dimmed with no word on it
            reads as broken rather than as a rule — the same reason an
            unaffordable grapple follow-up says "no Stamina" on its arrow. */}
        {Boolean(move.is_secondary) && (
          <span className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            secondary
          </span>
        )}
      </span>
      {/* Small (decided, reverted). Drawing this at Tic-square scale was
          tried — the idea being that a move in your hand should be the size
          of the slot it drops into — and it made every card in the picker
          enormous for no gain: you are choosing a move here, not aiming it,
          and the Tic Counter's own live footprint preview is what shows you
          where it lands. A compact glyph of the frame shape is all this
          needs to be. */}
      {styleMod && (
        <span
          className={`text-[10px] font-semibold uppercase tracking-wide ${
            styleMod.delta > 0
              ? 'text-emerald-400'
              : styleMod.delta < 0
                ? 'text-red-400'
                : 'text-zinc-500'
          }`}
        >
          {styleMod.name} {styleMod.delta > 0 ? `+${styleMod.delta}` : styleMod.delta} vs their stance
        </span>
      )}
      <FrameBar
        startup={move.effective_startup_tics ?? move.startup_tics}
        active={move.effective_active_tics ?? move.active_tics}
        recovery={move.effective_recovery_tics ?? move.recovery_tics}
        defensePositions={move.defense_frame_positions}
        size="h-2 w-2"
      />
    </button>
    </div>
  );
}

// Declaration Phase's declare-a-move picker for whichever single character
// currently has the floor — Default/Unique tabs split the character's move
// list the same way Tab 3 does; a styled move is left out of either tab
// unless it matches one of the two styles in the character's active stance.
function DeclareMovePicker({ entry, roundStartTic, declaredMoves, tags, tellById, styleDeltas, heldMove }) {
  const { character, stances, moves, dice, weapon } = entry;
  // **A Movement move needs both Legs (decided, new).** The server refuses one
  // outright (movementBlockedByLegs); this is the same rule read client-side so
  // the card greys and says why, rather than looking draggable and being
  // silently ignored — the same treatment a Requirement already gets.
  const legsBroken = (dice ?? []).some(
    (d) => (d.slot_name === 'Left Leg' || d.slot_name === 'Right Leg') && d.status === 'incapacitated'
  );
  const [tab, setTab] = useState('default');
  const activeStance = stances.find((s) => s.id === character.active_stance_id);
  const activeStyles = activeStance ? [activeStance.attribute_a_id, activeStance.attribute_b_id] : [];
  const usable = (move) => move.style_attribute_id == null || activeStyles.includes(move.style_attribute_id);
  const inTab = (moves ?? []).filter((m) => Boolean(m.is_default) === (tab === 'default') && usable(m));
  // **The same Tell/Tag filters the sheet has, on the declare picker (decided,
  // new).** Mid-round is exactly when "which of these opens with the shoulder
  // drop" is worth answering fastest, and this list can be long — a Default tab
  // is every default move in the world.
  //
  // Built from the CURRENT TAB, not the whole list: switching tabs re-derives
  // the chips, so the picker never offers a Tell that returns nothing on the
  // tab you are looking at. The picks themselves survive the switch, which is
  // the useful behaviour — narrowing to a Tag and then checking both tabs for
  // it is a real thing to want.
  const filters = useMoveFilters(inTab);
  const shown = inTab.filter(filters.matches);
  const tellList = useMemo(
    () => [...tellById.values()].filter((t) => filters.presentTellIds.has(t.id)),
    [tellById, filters.presentTellIds]
  );
  const tagList = (tags ?? []).filter((t) => filters.presentTagIds.has(t.id));
  // Feint Tag (decided, new): if the move this character just queued carries
  // the Feint Tag, whatever goes on next — on the first free Tic — is dealt
  // out of everyone else's view entirely until it reveals. Said out loud
  // here rather than left to be discovered, because the concealment is
  // invisible from the declaring side by construction: their own board looks
  // exactly the same either way. Nothing is greyed out — declaring later, or
  // declaring nothing, are both perfectly legal, they just aren't hidden.
  const lastId = lastQueuedMoveId(character.id, declaredMoves);
  const feintQueued =
    lastId != null && carriesFeintTag((moves ?? []).find((m) => m.id === lastId)?.tag_ids, tags);
  return (
    <div className="panel-cut-sm border border-zinc-800 bg-zinc-950 p-2">
      {feintQueued && (
        <p className="mb-1.5 panel-cut-sm border border-violet-800/60 bg-violet-950/30 px-2 py-1 text-[11px] leading-tight text-violet-300">
          <b>Feint queued.</b> Whatever you declare on the very next free Tic goes on
          hidden — no Tell, no wind-up — until it reveals.
        </p>
      )}
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex shrink-0 overflow-hidden panel-cut-sm border border-zinc-700 text-[11px] font-semibold uppercase">
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
      {/* **Tag on the left, Tell on the right**, on their own row under the
          tabs rather than sharing one with them. Sharing was the first attempt
          and it looked right with three chips and wrong with ten: the two
          filters and the tab toggle all compete for the same line, so the Tells
          ended up in a one-per-line column down the right edge. A row of their
          own lets each side wrap into its own half. */}
      {(tagList.length > 0 || tellList.length > 0) && (
        <div className="mb-1.5 flex items-start justify-between gap-3">
          <MoveFilterChips
            label="Tag:"
            items={tagList}
            selected={filters.tagFilter}
            onToggle={filters.toggleTag}
            onClear={filters.clearTag}
            labelFor={(t) => t.name}
            titleFor={(t) => t.description}
            compact
            className="min-w-0 flex-1"
          />
          <MoveFilterChips
            label="Tell:"
            items={tellList}
            selected={filters.tellFilter}
            onToggle={filters.toggleTell}
            onClear={filters.clearTell}
            labelFor={(t) => t.name}
            compact
            className="min-w-0 flex-1 justify-end"
          />
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {shown.length ? (
          shown.map((m) => (
            <DeclareMoveCard
              key={m.id}
              character={character}
              move={m}
              roundStartTic={roundStartTic}
              declaredMoves={declaredMoves}
              tags={tags}
              tellById={tellById}
              // This character's own list, which is all a Grappling move's
              // four direction arrows ever need to be named from.
              allMoves={moves ?? []}
              styleDeltas={styleDeltas}
              // Tap-to-declare holds a move until a Tic is tapped; without
              // this the chip gave no sign it was the one being held, which on
              // a phone (where there is no drag to watch) left the whole
              // gesture invisible.
              held={heldMove?.characterId === character.id && heldMove?.moveId === m.id}
              legsBroken={legsBroken}
              unarmed={!weapon}
            />
          ))
        ) : (
          <span className="text-xs text-zinc-600">
            {filters.anyActive ? `No ${tab} moves match these filters.` : `No ${tab} moves.`}
          </span>
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
function ActiveDeclarePanel({ entry, roundStartTic, declaredMoves, tags, tellById, styleDeltas, heldMove, opponents = [], aimId = null, onAim }) {
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
      {/* **Uneven Combat: pick who you are coming for (decided, new).** Only
          shown when there is genuinely a choice — with one opponent opposite
          there is nothing to ask, and the engine's own rule already names them.
          The pick rides on every move declared after it, so a round can be
          split between two enemies by changing it between declarations. */}
      {opponents.length > 1 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs font-semibold uppercase text-zinc-500">Coming for:</span>
          {opponents.map((opponent) => (
            <button
              key={opponent.id}
              type="button"
              onClick={() => onAim?.(opponent.id)}
              className={`min-h-11 panel-cut-sm border px-2 py-1 text-xs md:min-h-0 ${
                aimId === opponent.id
                  ? 'border-brand-500 bg-brand-600/30 text-brand-300'
                  : 'border-zinc-700 text-zinc-500 hover:border-zinc-500'
              }`}
            >
              {opponent.name}
            </button>
          ))}
        </div>
      )}
      <DeclareMovePicker
        entry={entry}
        roundStartTic={roundStartTic}
        declaredMoves={declaredMoves}
        tags={tags}
        tellById={tellById}
        styleDeltas={styleDeltas}
        heldMove={heldMove}
      />
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
  // **Why the Arena has an error state at all (bugfix).**
  //
  // Every one of the four fetches below used to end in `.catch(console.error)`,
  // and the render gate below is `if (!combat || !roster || !folders || !tells)`
  // — so any failing fetch left its state null forever and the page sat on
  // "Loading…" with no indication that anything had gone wrong, no error, and
  // no way to retry short of a reload that would do exactly the same thing.
  //
  // That is how a server-side exception in `/api/combat` presented in
  // production: an Arena stuck loading while every other page was fine, and
  // nothing on screen to say why. The bug that caused it is one thing; a UI
  // that cannot report its own failure is a separate and worse one, because it
  // makes every future failure just as opaque. Keyed by source so the message
  // names *which* endpoint broke — that alone narrows a diagnosis enormously.
  const [loadErrors, setLoadErrors] = useState({});
  const [reloadNonce, setReloadNonce] = useState(0);
  // Tag rows, for the Block Tag's own display rule (see moveDisplay.js).
  const [tags, setTags] = useState([]);
  const [dropTarget, setDropTarget] = useState(null); // `${side}-${pairIndex}` | null
  const [counterName, setCounterName] = useState('');
  const [counterTarget, setCounterTarget] = useState(6);
  const [collapsedFolders, setCollapsedFolders] = useState(new Set()); // roster folder ids, collapsed
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMoveLocal] = useState(null);
  // **Uneven Combat: who each fighter is aiming at (decided, new).** Held here
  // rather than inside the declare panel because two very distant things read
  // it — the declaration itself, and the matchup badge on the fighter's card —
  // and a selection that only the panel knew would leave the badge guessing.
  // characterId -> chosen opponent id; absent means "the default", which is the
  // first opponent seated opposite and also what the server falls back to.
  const [aimByChar, setAimByChar] = useState({});
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
    // Records the failure instead of swallowing it, and clears it again once
    // that same source succeeds — a blip during a fight must not leave a stale
    // error banner up once the next broadcast has refetched cleanly.
    const load = (source, promise, set) =>
      promise
        .then((value) => {
          set(value);
          setLoadErrors((prev) => {
            if (!(source in prev)) return prev;
            const next = { ...prev };
            delete next[source];
            return next;
          });
        })
        .catch((err) => {
          console.error(`${source} failed:`, err);
          setLoadErrors((prev) => ({ ...prev, [source]: err?.message || String(err) }));
        });

    const refresh = () => {
      // REST has no socket to carry identity, so it rides as query params
      // instead (see viewerFromQuery server-side) — same info the socket
      // itself was already told via identity:set in roleContext.jsx.
      load('/api/combat', getCombat(role === 'gm' ? { role } : { role, characterId }), setCombat);
      load('/api/characters', getCharacters(), setRoster);
      load('/api/character-folders', getCharacterFolders(), setFolders);
      load('/api/tells', getTells(), setTells);
      // Tags are not in the render gate below — the Arena draws without them —
      // so a tag failure must not put the whole page behind an error screen.
      getTags().then(setTags).catch(console.error);
    };
    refresh();
    const events = [
      'combat:updated',
      'character:created', 'character:deleted',
      'counter:created', 'counter:updated', 'counter:deleted',
      'stance:created', 'stance:updated', 'stance:deleted',
      // Switching stance changes the VS divider's matchup, which is computed
      // server-side — the local active_stance_id patch further down keeps the
      // card instant, but only a refetch brings the new number with it.
      'stance:activated',
      'character_folder:created', 'character_folder:updated', 'character_folder:deleted',
      'tell:created', 'tell:updated', 'tell:deleted',
    ];
    for (const ev of events) socket.on(ev, refresh);
    return () => {
      for (const ev of events) socket.off(ev, refresh);
    };
  }, [role, characterId, reloadNonce]);

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
    // Picked up, put down, worn out or broken — all one event carrying the new
    // state (or null). The Arena cares because a Move whose Roll names the
    // Weapon is closed to anyone carrying nothing.
    const onWeaponUpdated = ({ characterId, weapon }) => {
      setCombat((prev) => {
        const entry = prev?.characters[characterId];
        if (!entry) return prev;
        return {
          ...prev,
          characters: { ...prev.characters, [characterId]: { ...entry, weapon } },
        };
      });
    };
    socket.on('character:updated', onCharacterUpdated);
    socket.on('die:updated', onDieUpdated);
    socket.on('stance:activated', onStanceActivated);
    socket.on('weapon:updated', onWeaponUpdated);
    return () => {
      socket.off('weapon:updated', onWeaponUpdated);
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
    const failures = Object.entries(loadErrors);
    if (failures.length) {
      return (
        <div className="p-4">
          <div role="alert" className="max-w-xl border border-red-900 bg-red-950/50 p-4 text-sm">
            <p className="font-display text-base font-semibold uppercase tracking-wide text-red-200">
              The Arena could not load
            </p>
            <ul className="mt-2 space-y-1 text-red-200/90">
              {failures.map(([source, message]) => (
                <li key={source}>
                  <code className="text-red-100">{source}</code> — {message}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-zinc-400">
              The rest of the app is unaffected. If this keeps happening, the message above is the
              one worth reporting.
            </p>
            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="font-display mt-3 border border-red-700 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-100 hover:bg-red-900/50"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return <p className="text-zinc-500">Loading…</p>;
  }

  const { unevenCombatEnabled, freshStart, participants, characters, counters, pairs } = combat;
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
    socket.emit('move:declare', {
      characterId: draggedCharId,
      moveId,
      placementTic: absoluteTic,
      targetCharacterId: aimOf(draggedCharId),
    });
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
      targetCharacterId: aimOf(pendingDeclare.characterId),
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

  // What each Combat Style would be worth to this fighter, from their own
  // side of their own pair (see getPairStanceMatchup's leftStyleDeltas). Empty
  // whenever the matchup rule doesn't apply to that pair at all — the same
  // condition that leaves the VS divider's badge off — so a move's style row
  // simply doesn't render rather than claiming a misleading 0.
  // Everyone seated opposite this fighter, in seating order — the list the
  // target picker offers and the default is taken from.
  const opponentsOf = (charId) => {
    const seat = participants.find((p) => p.character_id === charId);
    if (!seat) return [];
    const otherSide = seat.side === 'left' ? 'right' : 'left';
    return participants.filter((p) => p.pair_index === seat.pair_index && p.side === otherSide);
  };
  // Who this fighter is currently coming for: their own pick if it is still
  // someone they face, otherwise the first opponent — which is also what the
  // engine falls back to, so the badge never claims a facing the round will
  // not use.
  const aimOf = (charId) => {
    const opponents = opponentsOf(charId);
    const picked = aimByChar[charId];
    if (picked != null && opponents.some((p) => p.character_id === picked)) return picked;
    return opponents[0]?.character_id ?? null;
  };
  // What this fighter's facing is worth, and what each Combat Style would add
  // to it. Read per-opponent (see getPairStanceMatchup's byCharacter), so it
  // answers in an uneven fight as well as a duel.
  const matchupFor = (charId) => {
    const seat = participants.find((p) => p.character_id === charId);
    if (!seat) return null;
    const pairMatchup = (combat.stanceMatchups ?? []).find((m) => m.pairIndex === seat.pair_index);
    const against = aimOf(charId);
    if (!pairMatchup || against == null) return null;
    return pairMatchup.byCharacter?.[charId]?.[against] ?? null;
  };
  const styleDeltasFor = (charId) => {
    return matchupFor(charId)?.styleDeltas ?? [];
  };
  // The same facing, with the opponent named — a badge on a card has to say
  // WHO the number is against, which the divider never had to.
  const matchupNamedFor = (charId) => {
    const m = matchupFor(charId);
    if (!m) return null;
    const against = aimOf(charId);
    return { ...m, opponentName: characters[against]?.character.name ?? null };
  };

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
  // A carryover is drawn as what it actually is (decided, revised): the
  // move's own frames in their own phase colours, exactly as anyone else's
  // move on the strip. It used to be a grey initialled badge in the corner —
  // a marker that *something* was there rather than a picture of it, which
  // made the one part of the board every player can legitimately see read as
  // an anonymous smudge. The identity was never secret in the first place
  // (its Tell has been visible since it was declared, and it revealed last
  // round), so there is nothing to protect by greying it out.
  const overflowTics = new Map(); // absoluteTic -> [{ name, phase }]
  if (displayPair) {
    const pairIndexByChar = new Map(participants.map((p) => [p.character_id, p.pair_index]));
    for (const dm of declaredMoves) {
      if (pairIndexByChar.get(dm.characterId) !== displayPairIndex) continue;
      if (dm.roundNumber >= displayPair.roundNumber) continue;
      const name = characters[dm.characterId]?.character.name;
      if (!name) continue;
      for (let t = displayPair.roundStartTic; t < dm.recoveryEndTic; t++) {
        // Same phase classification the cutscene and the chat snapshots use,
        // so a carried-over Recovery is the same blue everywhere.
        const phase = phaseAt(
          {
            placementTic: dm.placementTic,
            revealTic: dm.revealTic,
            activeEndTic: dm.activeEndTic,
            recoveryEndTic: dm.recoveryEndTic,
            defenseFramePositions: dm.defenseFramePositions ?? [],
          },
          t
        );
        if (!phase) continue;
        const at = overflowTics.get(t) ?? [];
        at.push({ name, phase });
        overflowTics.set(t, at);
      }
    }
  }

  // Attack telegraph (decided, new): which declared attacks begin on each
  // Tic of the displayed pair's round window. Public to every viewer — the
  // point of the rule is that an opponent can time a guard against a
  // wind-up they can see coming (see attackTelegraph.js for the full
  // reasoning and for what it deliberately does and doesn't disclose).
  // Built here and passed down, matching how overflowTics above is already
  // handled, so the strip stays a renderer rather than a place that reasons
  // about who may see what.
  const attackStarts = attackStartsByTic({
    declaredMoves,
    pairIndexByChar: new Map(participants.map((p) => [p.character_id, p.pair_index])),
    pairIndex: displayPairIndex,
    roundStartTic: displayPair?.roundStartTic,
    roundLength: combat.roundLength,
    nameOf: (id) => characters[id]?.character.name ?? null,
  });

  return (
    // The Arena is a board, not prose: it was capped at max-w-6xl (1152px),
    // which left most of a normal desktop window empty while the Tic strip
    // and the seating rows squeezed into a column. It now takes the width it
    // is given, with everything inside it sized fluidly rather than fixed.
    <div className="w-full">
      {/* Attack telegraph: draws the Tell <-> glowing-Tic connector. Renders
          nothing at all until something is hovered/tapped, and portals to
          <body>, so where it sits in this tree doesn't matter. */}
      <MoveLinkOverlay />
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
          {/* "Fresh" (decided, new): only with this on does Start Combat
              restore everyone to full Stamina. Off for every new fight, and
              reset to off when one ends, so back-to-back fights wear people
              down unless the GM deliberately says otherwise. Sits beside
              Start Combat because that is the press it changes; it does
              nothing once a fight is already running, so it hides then
              rather than sitting there inert. */}
          {role === 'gm' && hasUnstartedPair && participants.length > 0 && (
            <label
              className="flex items-center gap-1.5 text-sm text-zinc-300"
              title="Start this fight at full Stamina. Off by default — otherwise everyone starts with whatever Stamina they still had."
            >
              <input
                type="checkbox"
                checked={freshStart}
                onChange={() => socket.emit('combat:toggle_fresh', {})}
              />
              Fresh
            </label>
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
            attackStarts={attackStarts}
            linkAttackStarts
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
              tags={tags}
              tellById={tellById}
              styleDeltas={styleDeltasFor(entry.character.id)}
              heldMove={draggingMove}
              opponents={opponentsOf(entry.character.id).map((p) => characters[p.character_id]?.character).filter(Boolean)}
              aimId={aimOf(entry.character.id)}
              onAim={(id) => setAimByChar((prev) => ({ ...prev, [entry.character.id]: id }))}
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
            // Absent whenever the matchup rule doesn't apply at all (Uneven
            // Combat, a side that isn't exactly one fighter, a fighter with
            // no active stance) — the server drops those rather than sending
            // a 0 that would read as "even".
            const matchup = (combat.stanceMatchups ?? []).find((m) => m.pairIndex === rowIdx);
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
                          matchup={
                            leftOccupants.length > 1 || rightOccupants.length > 1
                              ? matchupNamedFor(p.character_id)
                              : null
                          }
                          onDragStart={(e) => e.dataTransfer.setData('text/character-id', String(p.character_id))}
                        />
                      )
                  )}
                </div>
                {/* The VS badge used to be mobile-only, with desktop getting a
                    bare hairline — but it reads better than the line does, so
                    it now shows at every size with the line running behind it
                    on wider screens. */}
                <div
                  className="relative flex shrink-0 items-center justify-center sm:w-auto"
                  title="Pair divider"
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-2 left-1/2 hidden w-px -translate-x-1/2 bg-zinc-700/50 sm:block"
                  />
                  {/* Column on mobile (where the two panels stack, so top =
                      left side) and a row on desktop (where they sit side by
                      side, so left = left side) — the readout has to point at
                      the right fighter at both sizes, and one order can't do
                      that for both layouts. */}
                  <div className="relative flex flex-col items-center gap-1 sm:flex-row sm:gap-1.5">
                    {matchup && (
                      <MatchupBadge
                        value={matchup.left}
                        mine={matchup.leftStyleNames ?? []}
                        theirs={matchup.rightStyleNames ?? []}
                      />
                    )}
                    <span className="font-display panel-cut-sm bg-zinc-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                      VS
                    </span>
                    {matchup && (
                      <MatchupBadge
                        value={matchup.right}
                        mine={matchup.rightStyleNames ?? []}
                        theirs={matchup.leftStyleNames ?? []}
                      />
                    )}
                  </div>
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
                          matchup={
                            leftOccupants.length > 1 || rightOccupants.length > 1
                              ? matchupNamedFor(p.character_id)
                              : null
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
