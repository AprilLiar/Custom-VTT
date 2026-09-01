import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';
import { TicCounterCentral } from './CombatArena.jsx';
import { setDraggingMove, onDraggingMoveChange } from '../lib/dragMoveState.js';
import {
  getTicDeclare,
  isArenaCounterVisible,
  onArenaCounterVisibility,
  onTicDeclareChange,
} from '../lib/ticDropTarget.js';
import { attackStartsByTic } from '../lib/attackTelegraph.js';
import { useSocketRefresh } from '../lib/connection.js';
import { clearSummonedPrompt, onSummonedPrompt } from '../lib/pausePrompts.js';
import MoveConflictDialog from './MoveConflictDialog.jsx';
import NonCommitDialog from './NonCommitDialog.jsx';
import DefensePromptDialog from './DefensePromptDialog.jsx';
import GrapplePromptDialog from './GrapplePromptDialog.jsx';

// This viewer's own current standing in the fight — "waiting for
// declaration," "your turn," and so on (decided, Tic navigation redesign).
// The GM has no personal declare turn (they run every NPC), so they get the
// same administrative pair-count summary this bar always showed; a Player
// gets a status about their own seated character specifically. Only
// meaningful during Declaration — Tic Countdown is the same experience for
// everyone (watching Tics advance), so it keeps its own generic badge below
// instead of a per-viewer line.
function viewerDeclarationStatus({ pairs, participants }, role, characterId) {
  const pairsStillDeclaring = (pairs ?? []).filter((p) => p.declaringSide != null).length;
  if (role === 'gm') {
    return pairsStillDeclaring === 0
      ? 'Every pair has finished declaring'
      : `${pairsStillDeclaring} pair${pairsStillDeclaring === 1 ? '' : 's'} still declaring…`;
  }
  const participant = (participants ?? []).find((p) => p.character_id === characterId);
  if (!participant) return 'Not seated in this fight';
  if (participant.declared_this_round) return 'Waiting on other declarations…';
  const pair = (pairs ?? []).find((pr) => pr.pairIndex === participant.pair_index);
  return pair?.declaringSide === participant.side ? 'Your turn to declare!' : 'Waiting for declaration…';
}

// Slim global strip, mounted once in App.jsx's Shell so round/phase state is
// reachable from any page (Phase 7's original "decided" behavior). Tic
// navigation redesign, item 3 (decided): the header's Tic Counter is now the
// exact same TicCounterCentral widget the Arena itself renders — same size,
// same cross-round overflow badges — so both counters visibly stay in
// lockstep (they're both just reading the same combat:updated broadcast).
// Combat Automation overhaul §5: nobody steps the counter by hand any more;
// a round resolves itself and RoundCutscene plays it back, so this strip is
// a status display, not a control. The only other thing that doesn't apply here is the
// drag-and-drop declare target: there's no roster/move picker on every page
// to drag from, so onDrop is a harmless no-op — dragging while ON the Arena
// page (where both counters are visible at once) still shows the live
// footprint preview via the same dragMoveState.js pub/sub the Arena uses,
// just without a working drop. Round advancement is fully automatic and
// per-pair (decision #12) — no button anywhere advances it.
export default function CombatHeaderBar() {
  const { role, characterId } = useRole();
  const location = useLocation();
  const [combat, setCombat] = useState(null);
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMoveLocal] = useState(null);
  // Whether the Arena's own Tic Counter is on screen, and whether there is an
  // Arena mounted at all to declare through. Both are published by
  // CombatArena.jsx — see ticDropTarget.js for why the registry rather than
  // props — and both are read as state so this bar re-renders when they change.
  const [arenaCounterVisible, setArenaCounterVisibleLocal] = useState(isArenaCounterVisible);
  const [canDeclare, setCanDeclare] = useState(() => Boolean(getTicDeclare()));

  useEffect(() => onDraggingMoveChange(setDraggingMoveLocal), []);
  useEffect(() => onArenaCounterVisibility(setArenaCounterVisibleLocal), []);
  useEffect(() => onTicDeclareChange((fn) => setCanDeclare(Boolean(fn))), []);

  const refresh = useCallback(() => {
    getCombat(role === 'gm' ? { role } : { role, characterId })
      .then(setCombat)
      .catch(console.error);
  }, [role, characterId]);

  useEffect(() => {
    refresh();
    // combat:updated is deliberately narrower than GET /api/combat (see its
    // own comment server-side) — it never carries characters/counters, to
    // avoid re-sending every seated character's full sheet (portraits
    // included) on every minor combat action. Merging onto the previous
    // state (bugfix) instead of replacing it wholesale keeps characters/
    // counters from the initial REST load intact; overwriting outright left
    // combat.characters undefined the moment the first broadcast landed,
    // crashing the conflict-queue effect below.
    const onUpdated = (c) => setCombat((prev) => ({ ...prev, ...c }));
    socket.on('combat:updated', onUpdated);
    return () => socket.off('combat:updated', onUpdated);
  }, [refresh]);

  // **This bar never re-read the snapshot after mount, and that is most of the
  // bug (fix).** A missed broadcast never replays on its own, and a *paused*
  // pair broadcasts nothing further by definition — so a GM whose phone locked
  // while a Dodge or Block prompt went out came back to a silent screen and a
  // fight no one could advance. Re-reads on a genuine reconnect and whenever
  // the tab returns from the background; the server covers the same ground from
  // its end by pushing a fresh snapshot the moment this socket identifies.
  useSocketRefresh(refresh);

  // Combat Automation overhaul §5: the reveal-time auto-Roll dialog queue
  // that used to live here is gone. Every roll in a round is now rolled
  // server-side by the resolution engine the instant a move reveals, and
  // pushed as a `roll` round_event for the cutscene to animate — prompting
  // a human to roll would double-roll it. Rolling by hand still exists
  // outside the automated flow (a character sheet's own dice, the chat
  // Dice Tray).

  // **Every prompt below is a function of server state, and of nothing else
  // (decided, reworked).** They used to arrive as one-shot socket pushes that
  // this component queued into local arrays, with the combat snapshot as a
  // mount-time recovery path. Three things were wrong with that, and live play
  // found all three: a one-shot event only reaches sockets connected at that
  // instant; a paused pair sends nothing afterwards to catch anyone up; and the
  // queues were shifted the moment a button was *clicked*, so an answer that
  // never reached the server took the question away with it.
  //
  // Now: the pause is read off `combat.pairs`, already shaped into the question
  // by the server (see defensePromptPayload). It survives a reload and a
  // reconnect because it was never held here in the first place, and it goes
  // away when the server says the pause is answered.
  const [summoned, setSummoned] = useState(null);
  useEffect(() => onSummonedPrompt(setSummoned), []);

  // The conflict prompt is the affected *fighter's* call, not the GM's at large
  // — their own PC for a Player, their own NPCs for the GM.
  //
  // **Read off `participants`, not `characters` (bugfix).** This used to look
  // the fighter up in `combat.characters` — which the REST snapshot carries but
  // the `combat:updated` socket broadcast does NOT (see combatUpdateFor: it
  // sends pairs/participants/declaredMoves and no per-character detail). So the
  // moment any combat broadcast landed, the map went empty and every live
  // conflict prompt was silently dropped. `participants` is in both payloads and
  // already carries `character_type`, which is the only field this needs.
  const ownsConflict = (payload) => {
    const seat = (combat?.participants ?? []).find((p) => p.character_id === payload.characterId);
    if (!seat) return false;
    if (role === 'player') return payload.characterId === characterId;
    if (role === 'gm') return seat.character_type === 'npc';
    return false;
  };

  const pairs = combat?.pairs ?? [];

  // One defence question at a time. Two pairs can be paused at once on
  // different guards, and stacking two modals would leave the GM answering the
  // one they cannot see; the other is asked as soon as this one is answered.
  // Withheld from Players by the server, not just hidden here — the payload
  // carries the attacker's roll total.
  const snapshotDefense = (() => {
    if (role !== 'gm') return null;
    const pair = pairs.find((p) => p.pendingDodge || p.pendingDefense);
    if (!pair) return null;
    return { ...(pair.pendingDodge ?? pair.pendingDefense), pairIndex: pair.pairIndex };
  })();

  const snapshotConflict = (() => {
    const pair = pairs.find((p) => p.pendingConflict && ownsConflict(p.pendingConflict));
    return pair ? { ...pair.pendingConflict, pairIndex: pair.pairIndex } : null;
  })();

  // **Non-Committed's window.** No ownership test here, unlike the conflict
  // prompt: the server has already filtered the payload down to the entries
  // this socket controls (see nonCommitForViewer), so anything that arrives is
  // by definition ours to answer. Filtering again on the client would be a
  // second, weaker copy of a rule that has to hold server-side anyway.
  const snapshotNonCommit = (() => {
    const pair = pairs.find((p) => p.pendingNonCommit);
    return pair ? { ...pair.pendingNonCommit, pairIndex: pair.pairIndex } : null;
  })();

  // A hand-summoned prompt steps aside the moment the ordinary path produces
  // the same question — it exists for when that path is silent, not to compete
  // with it, and leaving it up would strand a stale copy after the answer lands.
  const summonedIsConflict = summoned?.kind === 'conflict';
  useEffect(() => {
    if (!summoned) return;
    if (summonedIsConflict ? snapshotConflict : snapshotDefense) clearSummonedPrompt();
  }, [summoned, summonedIsConflict, snapshotDefense, snapshotConflict]);

  // Spread rather than named through prop by prop: the server authors this
  // shape (defensePromptPayload) precisely so the live question and the
  // recovered one cannot be worded differently, and re-listing the fields here
  // would put a third copy of that shape in the codebase.
  const defenseEntry =
    snapshotDefense ??
    (summoned && !summonedIsConflict ? { ...summoned.prompt, pairIndex: summoned.pairIndex } : null);

  const defenseDialog = defenseEntry ? (
    <DefensePromptDialog
      // Re-keyed per question, so answering one Stat of a multi-Stat attack
      // hands the next one a dialog with its own fresh submit state.
      key={`defense:${defenseEntry.pairIndex}:${defenseEntry.attackerDeclaredMoveId}:${
        defenseEntry.targetSlotName ?? ''
      }`}
      {...defenseEntry}
      onAnswered={clearSummonedPrompt}
    />
  ) : null;

  const nonCommitDialog = snapshotNonCommit ? (
    <NonCommitDialog
      key={`noncommit:${snapshotNonCommit.pairIndex}`}
      pairIndex={snapshotNonCommit.pairIndex}
      entries={snapshotNonCommit.entries ?? []}
    />
  ) : null;

  const conflictEntry =
    snapshotConflict ??
    (summoned && summonedIsConflict ? { ...summoned.conflict, pairIndex: summoned.pairIndex } : null);

  const conflictDialog = conflictEntry ? (
    <MoveConflictDialog
      key={`conflict:${conflictEntry.blockerDeclaredMoveId}:${conflictEntry.declaredMoveId}`}
      declaredMoveId={conflictEntry.declaredMoveId}
      blockerDeclaredMoveId={conflictEntry.blockerDeclaredMoveId}
      blockerMoveName={conflictEntry.blockerMoveName}
      // The whole cascade, named and priced by the server — the dialog lists
      // it rather than re-deriving it from `combat`, so what the player is
      // shown is exactly the plan resolveMoveConflict will apply.
      shifts={conflictEntry.shifts ?? []}
      characterName={conflictEntry.characterName}
      onAnswered={clearSummonedPrompt}
    />
  ) : null;

  // Grappling's mini-game, which has read off the snapshot from the day it was
  // built — the server works out per viewer whether THIS person has a prompt
  // and what they are allowed to see of it (mapPendingGrappleForViewer). That
  // is the shape everything above has now been rebuilt into: reconnect recovery
  // comes free, and the secrecy is structural rather than something this
  // component has to remember to honour.
  const grappleDialog = (() => {
    const pair = pairs.find(
      (p) => p.pendingGrapple && p.pendingGrapple.role !== 'observer' && !p.pendingGrapple.answered
    );
    if (!pair) return null;
    return (
      <GrapplePromptDialog
        key={`${pair.pairIndex}:${pair.pendingGrapple.grapplerDeclaredMoveId}`}
        pairIndex={pair.pairIndex}
        pending={pair.pendingGrapple}
      />
    );
  })();

  // Combat Automation overhaul: each pair now runs its own independent
  // round/phase/Tic clock — this global strip can only ever show ONE of
  // them at a time. A Player sees their own seat's pair; the GM (who has no
  // personal seat) sees whichever pair happens to be seated first — a real
  // per-pair switcher is Phase E's job (see vttprojectplan.md's Combat
  // Automation overhaul section), this is a deliberately simple placeholder
  // until then.
  const myParticipant =
    role === 'player' ? (combat?.participants ?? []).find((p) => p.character_id === characterId) : null;
  const activePair =
    role === 'player' ? pairs.find((p) => p.pairIndex === myParticipant?.pair_index) : pairs[0];

  if (!combat || !activePair) {
    // Still render whatever prompts we do have — a pause can be open before
    // this viewer has a pair to show (a Player not seated in this fight, a GM
    // on a page with no active pair), and the answer is what unsticks it.
    return (
      <>
        {conflictDialog}
        {defenseDialog}
        {nonCommitDialog}
        {grappleDialog}
      </>
    );
  }

  const { pairIndex, phase, roundNumber, currentTic, roundStartTic } = activePair;
  const { roundLength } = combat;
  const onArena = location.pathname === '/combat';

  // **Declaring by dropping on THIS counter (decided, new).** The handler is
  // the Arena's own `declareMoveAt`, lent through ticDropTarget.js rather than
  // reimplemented — see that module on why. Undefined when no Arena is mounted,
  // which is every other page and which restores exactly the inert
  // `e.preventDefault()` this counter has always had there: without a move
  // source on screen there is nothing to drop anyway.
  const handleTicDrop = canDeclare
    ? (absoluteTic) => (e) => {
        e.preventDefault();
        setHoverTic(null);
        const raw = e.dataTransfer.getData('application/x-vtt-move');
        if (!raw) return;
        getTicDeclare()?.(absoluteTic, JSON.parse(raw), e.clientX, e.clientY);
      }
    : () => (e) => e.preventDefault();
  // The touch half, matching the Arena's own tap-to-place: a tapped
  // DeclareMoveCard puts its payload into dragMoveState, and the next Tic tap
  // places it. A phone has no drag at all, so without this the header's counter
  // would be a declare target only for people using a mouse.
  const handleTicTap =
    canDeclare && draggingMove
      ? (absoluteTic) => (e) => {
          getTicDeclare()?.(absoluteTic, draggingMove, e.clientX, e.clientY);
          setDraggingMove(null);
        }
      : undefined;
  // **The full counter, always (decided, revised).** Mobile readiness §7.5 used
  // to collapse this to a compact "Tic N/L" badge below `md` on the Arena,
  // because it would otherwise duplicate that page's own centrepiece on a narrow
  // screen. The duplication is now answered at the root — the whole strip stands
  // down while that counter is on screen (see `stripHidden` below) — so by the
  // time this renders on the Arena it is the ONLY Tic Counter there is, and a
  // badge you cannot tap a move onto is the wrong thing to leave in its place.
  // "Ready to start" is now specific to the pair being shown — Start Tic
  // Countdown is a per-pair action now, not an arena-wide gate.
  const everyoneReady = phase === 'declaration' && activePair.declaringSide == null;
  // Same "who still has something recovering here from last round" badge
  // math as CombatArena.jsx's own overflowTics — duplicated rather than
  // shared since it's a few lines of pure array/map building, not worth
  // threading combat state between two independently-mounted components
  // for. Scoped to just this pair's own seated characters (via
  // participants[].pair_index), since a different pair's carried-over move
  // has nothing to do with the pair actually being shown here.
  const pairIndexByChar = new Map((combat.participants ?? []).map((p) => [p.character_id, p.pair_index]));
  const overflowTics = new Map();
  for (const dm of combat.declaredMoves ?? []) {
    if (pairIndexByChar.get(dm.characterId) !== pairIndex) continue;
    if (dm.roundNumber >= roundNumber) continue;
    const name = combat.characters?.[dm.characterId]?.character.name;
    if (!name) continue;
    for (let t = roundStartTic; t < dm.recoveryEndTic; t++) {
      const names = overflowTics.get(t) ?? [];
      if (!names.includes(name)) names.push(name);
      overflowTics.set(t, names);
    }
  }

  // Attack telegraph (decided, new): the same grey start-of-Startup glow the
  // Arena's own counter paints, so a fight stays readable from whatever page
  // you happen to be on — the strip already exists precisely so it does. The
  // connector line is not repeated here: its other end is a Tell card in the
  // Arena's Declaration Lanes, and there is no move source or lane on a
  // Compendium or character-sheet page to point at, so this counter passes
  // no linkAttackStarts and renders the glow as a bare marker.
  const attackStarts = attackStartsByTic({
    declaredMoves: combat.declaredMoves,
    pairIndexByChar,
    pairIndex,
    roundStartTic,
    roundLength,
    nameOf: (id) => combat.characters?.[id]?.character.name ?? null,
  });

  // **The strip stands down while the Arena's own counter is on screen (decided,
  // new).** Two Tic Counters one above the other, showing the same seven
  // numbers, is a duplicate that costs a row of the Arena's height and says
  // nothing new. Scroll past the centrepiece — which is what you do to reach the
  // declare picker — and it comes back, now as the only Tic strip in reach and a
  // live drop target for the move you are dragging.
  //
  // **Collapsed, not unmounted.** Every pause prompt in the game hangs off this
  // component (defence, conflict, Non-Committed, grapple), and a bar that
  // unmounted itself would take the GM's open question with it. The dialogs are
  // rendered outside the collapsing wrapper, so they are unaffected either way.
  //
  // Animated rather than snapped: a row appearing under your cursor without
  // warning is how you mis-click the thing that was there a frame ago.
  const stripHidden = onArena && arenaCounterVisible;

  return (
    <>
      <AnimatePresence initial={false}>
        {!stripHidden && (
          <motion.div
            key="strip"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 px-4 py-2 text-sm">
      <motion.span
        key={roundNumber}
        initial={{ scale: 1.6, filter: 'brightness(2)' }}
        animate={{ scale: 1, filter: 'brightness(1)' }}
        transition={{ type: 'spring', stiffness: 500, damping: 18 }}
        className="rounded-full bg-brand-600/20 px-2.5 py-0.5 font-bold text-brand-300"
      >
        Round {roundNumber}
      </motion.span>
      <AnimatePresence mode="wait">
        {phase === 'declaration' && (
          <motion.span
            key="declaration"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.2 }}
            className="text-zinc-400"
          >
            {viewerDeclarationStatus(combat, role, characterId)}
          </motion.span>
        )}
        {phase === 'resolving' && (
          <motion.span
            key="tic_countdown"
            initial={{ opacity: 0, scale: 0.8, filter: 'brightness(2)' }}
            animate={{ opacity: 1, scale: 1, filter: 'brightness(1)' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="font-display font-bold uppercase tracking-wide text-brand-300"
          >
            Tic Countdown
          </motion.span>
        )}
      </AnimatePresence>
      <TicCounterCentral
          pairIndex={pairIndex}
          phase={phase}
          currentTic={currentTic}
          roundStartTic={roundStartTic}
          roundLength={roundLength}
          draggingMove={draggingMove}
          hoverTic={hoverTic}
          setHoverTic={setHoverTic}
          onDrop={handleTicDrop}
          onTapPlace={handleTicTap}
          declaredMoves={[]}
          showDeclaredPreview={false}
          overflowTics={overflowTics}
          attackStarts={attackStarts}
          role={role}
          label="Tic Counter"
        />
      {!onArena && (
        <Link
          to="/combat"
          className="panel-cut-sm border border-brand-700/50 bg-brand-950/40 px-2 py-1 text-xs font-semibold text-brand-300 hover:bg-brand-900/40"
        >
          Go to Arena →
        </Link>
      )}
      {role === 'gm' && (
        <button
          onClick={() =>
            window.confirm('End combat? Everyone stays seated, but the round/Tic state resets.') &&
            socket.emit('combat:end', {})
          }
          className="ml-auto panel-cut-sm border border-zinc-700 px-3 py-1 text-xs font-semibold text-zinc-400 hover:bg-zinc-800"
        >
          End Combat
        </button>
      )}
    </div>
          </motion.div>
        )}
      </AnimatePresence>
      {conflictDialog}
      {defenseDialog}
      {nonCommitDialog}
      {grappleDialog}
    </>
  );
}
