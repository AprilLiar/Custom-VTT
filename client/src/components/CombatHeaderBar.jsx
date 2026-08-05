import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';
import { TicCounterCentral } from './CombatArena.jsx';
import { onDraggingMoveChange } from '../lib/dragMoveState.js';
import { useIsDesktop } from '../lib/useMediaQuery.js';
import RollDialog from './RollDialog.jsx';
import MoveConflictDialog from './MoveConflictDialog.jsx';

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
// same cross-round overflow badges, same GM click-to-step/Next Round — so
// the GM can advance the countdown from any page, not just the Arena, and
// both counters visibly stay in lockstep (they're both just reading the same
// combat:updated broadcast). The only thing that doesn't apply here is the
// drag-and-drop declare target: there's no roster/move picker on every page
// to drag from, so onDrop is a harmless no-op — dragging while ON the Arena
// page (where both counters are visible at once) still shows the live
// footprint preview via the same dragMoveState.js pub/sub the Arena uses,
// just without a working drop. **Decided (bugfix):** the strip's own
// separate, always-visible "Next Round" button (shown whenever not
// mid-Declaration) is gone — it let the GM jump to the next round from any
// Tic, not just the last one, unlike the embedded TicCounterCentral's own
// Next Round button (which only ever appears once the counter reaches the
// round's actual last Tic). Advancing rounds now only ever happens the one
// way the Arena itself allows it, matching everywhere else in the app.
export default function CombatHeaderBar() {
  const { role, characterId } = useRole();
  const location = useLocation();
  const isDesktop = useIsDesktop();
  const [combat, setCombat] = useState(null);
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMove] = useState(null);

  useEffect(() => onDraggingMoveChange(setDraggingMove), []);

  // Set only once the real GET /api/combat snapshot has actually landed —
  // see the auto-roll-queue effect below for why this matters (bugfix): a
  // combat:updated broadcast arriving before that first fetch resolves
  // would otherwise make `combat` go non-null early from an incomplete
  // merge onto `null` (`{...null, ...c}` is just `c`), letting the auto-roll
  // effect run its "seed already-revealed as seen" step against that
  // unreliable snapshot instead of the real one.
  const initialLoadDoneRef = useRef(false);

  useEffect(() => {
    getCombat(role === 'gm' ? { role } : { role, characterId })
      .then((c) => {
        initialLoadDoneRef.current = true;
        setCombat(c);
      })
      .catch(console.error);
    // combat:updated is deliberately narrower than GET /api/combat (see its
    // own comment server-side) — it never carries characters/counters, to
    // avoid re-sending every seated character's full sheet (portraits
    // included) on every minor combat action. Merging onto the previous
    // state (bugfix) instead of replacing it wholesale keeps characters/
    // counters from the initial REST load intact; overwriting outright left
    // combat.characters undefined the moment the first broadcast landed,
    // crashing the auto-roll-queue effect below the next time a move
    // revealed.
    const onUpdated = (c) => setCombat((prev) => ({ ...prev, ...c }));
    socket.on('combat:updated', onUpdated);
    return () => socket.off('combat:updated', onUpdated);
  }, [role, characterId]);

  // Auto-open the same Roll dialog a manual "Roll" click would, the moment
  // a declared move actually reaches its reveal Tic — for whichever
  // character this viewer actually controls (their own PC, or any NPC for
  // the GM — same ownership rule as isRevealedToViewer server-side), and
  // only when the move has a Roll at all. dm.isRevealed can't drive this: it
  // goes true for the owner the instant they declare (see
  // mapDeclaredMovesForViewer), long before the real reveal Tic — this
  // instead mirrors the server's own postMoveReveals timing (phase must
  // have reached Tic Countdown, currentTic >= revealTic) so the prompt
  // never fires early during Declaration Phase. Lives here rather than in
  // CombatArena.jsx (bugfix, moved) — this component stays mounted on every
  // page for as long as a fight is active, unlike the Arena, so a GM who
  // steps away to roll an NPC's dice from its own sheet (or just browses the
  // Compendium mid-fight) still gets prompted the instant they're owed a
  // roll, instead of that reveal silently going unprompted forever because
  // the watcher's "already seen" tracking used to reset on remount.
  const seenRevealedRef = useRef(new Set());
  const autoRollInitializedRef = useRef(false);
  const [autoRollQueue, setAutoRollQueue] = useState([]);

  useEffect(() => {
    if (!combat) return;
    // Bugfix: wait for the real initial snapshot (see initialLoadDoneRef
    // above) before ever seeding or checking "already seen" — a premature
    // partial `combat` from a socket broadcast racing ahead of the REST
    // fetch could otherwise get treated as the initial baseline, silently
    // marking a move "already seen" the instant it revealed live, with no
    // prompt ever shown, exactly as if this tab had missed it before
    // opening (it hadn't).
    if (!initialLoadDoneRef.current) return;
    // Not scoped to a declared move's own roundNumber: a carried-over move
    // declared last round can have a revealTic that only arrives after this
    // round already started (long Startup) — round-scoping this would
    // exclude exactly those moves from ever auto-opening their Roll dialog.
    // revealTic is an absolute Tic value regardless of which round declared
    // the move. Combat Automation overhaul: "revealed" is now a per-pair
    // question (each pair has its own phase/currentTic) rather than one
    // shared clock, so each declared move is checked against its OWN pair's
    // state, not a single global one.
    const pairsByIndexForReveal = new Map((combat.pairs ?? []).map((p) => [p.pairIndex, p]));
    const pairIndexByCharForReveal = new Map(
      (combat.participants ?? []).map((p) => [p.character_id, p.pair_index])
    );
    const reallyRevealedNow = (combat.declaredMoves ?? []).filter((dm) => {
      const pairIdx = pairIndexByCharForReveal.get(dm.characterId);
      const pair = pairIdx != null ? pairsByIndexForReveal.get(pairIdx) : null;
      return pair?.phase === 'resolving' && dm.revealTic <= pair.currentTic;
    });
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
      return (
        move &&
        (move.roll_dice?.length > 0 ||
          move.roll_choice ||
          (move.roll_type === 'custom' && move.custom_roll_size != null))
      );
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

  // Combat Automation (Phase 9, sub-phase 4): queues combat:move_conflict
  // events (4.3's Forfeit/Postpone prompt) the same way autoRollQueue above
  // queues reveal-time Roll prompts — scoped to whoever actually controls
  // the affected character (own PC for a Player, own NPCs for the GM), so
  // this doesn't interrupt an unrelated viewer's screen with someone else's
  // decision to make.
  const [conflictQueue, setConflictQueue] = useState([]);
  useEffect(() => {
    const onConflict = (payload) => {
      const entry = combat?.characters?.[payload.characterId];
      if (!entry) return;
      const isMine =
        role === 'player'
          ? payload.characterId === characterId
          : role === 'gm'
            ? entry.character.character_type === 'npc'
            : false;
      if (isMine) setConflictQueue((q) => [...q, payload]);
    };
    socket.on('combat:move_conflict', onConflict);
    return () => socket.off('combat:move_conflict', onConflict);
  }, [combat, role, characterId]);

  const autoRollDialog = (() => {
    if (!autoRollQueue.length || !combat) return null;
    const dm = autoRollQueue[0];
    const entry = combat.characters[dm.characterId];
    const move = entry?.moves?.find((m) => m.id === dm.moveId);
    if (!entry || !move) return null; // pruned by the effect above on the next render
    const sideDice = dm.appendageChoice ? (move.roll_choice?.[dm.appendageChoice] ?? []) : [];
    const dieIds = [...(move.roll_dice ?? []), ...sideDice].map((d) => d.dieId);
    const isCustomRoll = move.roll_type === 'custom' && move.custom_roll_size != null;
    return (
      <RollDialog
        title={`Roll ${move.name}${
          dm.appendageChoice ? ` (${dm.appendageChoice === 'right' ? 'Right' : 'Left'})` : ''
        } — ${entry.character.name}`}
        initialModifier={move.effective_roll_modifier ?? 0}
        onRoll={(modifier) =>
          isCustomRoll
            ? socket.emit('dice:roll_custom', {
                characterId: dm.characterId,
                size: move.custom_roll_size,
                modifier,
                declaredMoveId: dm.id,
              })
            : socket.emit('pool:roll', { characterId: dm.characterId, dieIds, modifier, declaredMoveId: dm.id })
        }
        onClose={() => setAutoRollQueue((q) => q.slice(1))}
      />
    );
  })();

  // Combat Automation (Phase 9, sub-phase 4 — 4.3's Forfeit/Postpone
  // prompt). Same "whoever actually controls this character" ownership
  // gate as the auto-roll queue above (own PC for a Player, own NPCs for
  // the GM — see isMine there), and the same queue-one-at-a-time pattern:
  // combat:resolve_move_conflict's own recursive re-emit (see server-side)
  // just appends another entry here, no special recursion handling needed
  // client-side.
  const conflictDialog = (() => {
    if (!conflictQueue.length || !combat) return null;
    const conflict = conflictQueue[0];
    const entry = combat.characters?.[conflict.characterId];
    if (!entry) return null; // pruned below on the next render
    const dm = (combat.declaredMoves ?? []).find((d) => d.id === conflict.declaredMoveId);
    return (
      <MoveConflictDialog
        declaredMoveId={conflict.declaredMoveId}
        blockerDeclaredMoveId={conflict.blockerDeclaredMoveId}
        moveName={dm?.moveName}
        characterName={entry.character.name}
        onResolve={() => setConflictQueue((q) => q.slice(1))}
      />
    );
  })();

  const pairs = combat?.pairs ?? [];
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

  if (!combat || !activePair) return autoRollDialog ?? conflictDialog;

  const { pairIndex, phase, roundNumber, currentTic, roundStartTic } = activePair;
  const { roundLength } = combat;
  const onArena = location.pathname === '/combat';
  // Mobile readiness (Change 002) §7.5: the global strip's own Tic Counter
  // would otherwise duplicate the Arena page's own big centerpiece one on a
  // narrow screen — collapses to a compact "Tic N/L" badge below `md`
  // whenever the Arena's own counter is already on screen; every other
  // mobile page still gets the full interactive counter (it's the only Tic
  // Counter visible there), same as desktop always does everywhere.
  const showFullCounter = isDesktop || !onArena;
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

  return (
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
      {showFullCounter ? (
        <TicCounterCentral
          pairIndex={pairIndex}
          phase={phase}
          currentTic={currentTic}
          roundStartTic={roundStartTic}
          roundLength={roundLength}
          draggingMove={draggingMove}
          hoverTic={hoverTic}
          setHoverTic={setHoverTic}
          onDrop={() => (e) => e.preventDefault()}
          declaredMoves={[]}
          showDeclaredPreview={false}
          overflowTics={overflowTics}
          role={role}
          label="Tic Counter"
        />
      ) : (
        <span className="font-display panel-cut-sm border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs font-bold text-zinc-300">
          Tic {activePair.relativeTic}/{roundLength}
        </span>
      )}
      {!onArena && (
        <Link
          to="/combat"
          className="panel-cut-sm border border-brand-700/50 bg-brand-950/40 px-2 py-1 text-xs font-semibold text-brand-300 hover:bg-brand-900/40"
        >
          Go to Arena →
        </Link>
      )}
      {role === 'gm' && everyoneReady && (
        <button
          onClick={() => socket.emit('combat:start_tic_countdown', { pairIndex })}
          className="panel-cut-sm bg-brand-600 px-2 py-1 text-xs font-semibold hover:bg-brand-500"
        >
          Start Tic Countdown
        </button>
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
      {autoRollDialog}
      {conflictDialog}
    </div>
  );
}
