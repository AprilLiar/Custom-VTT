import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';
import { TicCounterCentral } from './CombatArena.jsx';
import { onDraggingMoveChange } from '../lib/dragMoveState.js';
import { attackStartsByTic } from '../lib/attackTelegraph.js';
import { useIsDesktop } from '../lib/useMediaQuery.js';
import MoveConflictDialog from './MoveConflictDialog.jsx';
import DodgePromptDialog from './DodgePromptDialog.jsx';
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
  const isDesktop = useIsDesktop();
  const [combat, setCombat] = useState(null);
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMove] = useState(null);

  useEffect(() => onDraggingMoveChange(setDraggingMove), []);

  // Set only once the real GET /api/combat snapshot has actually landed, so
  // effects that need `combat.characters` don't run against an incomplete
  // merge onto `null` (`{...null, ...c}` is just `c`) from a combat:updated
  // broadcast that raced ahead of the first fetch.
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
    // crashing the conflict-queue effect below.
    const onUpdated = (c) => setCombat((prev) => ({ ...prev, ...c }));
    socket.on('combat:updated', onUpdated);
    return () => socket.off('combat:updated', onUpdated);
  }, [role, characterId]);

  // Combat Automation overhaul §5: the reveal-time auto-Roll dialog queue
  // that used to live here is gone. Every roll in a round is now rolled
  // server-side by the resolution engine the instant a move reveals, and
  // pushed as a `roll` round_event for the cutscene to animate — prompting
  // a human to roll would double-roll it. Rolling by hand still exists
  // outside the automated flow (a character sheet's own dice, the chat
  // Dice Tray).

  // Combat Automation (Phase 9, sub-phase 4): queues combat:move_conflict
  // events (4.3's Forfeit/Postpone prompt) — scoped to whoever actually controls
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

  // Combat Automation overhaul §3/§4.1 — the Dodge prompt, the one human
  // decision left in an automatic round. Unlike the conflict prompt above
  // (scoped to whoever controls the affected character), this goes to the
  // GM unconditionally, regardless of which pair they're viewing: the
  // paused pair's round cannot continue until they answer, so it has to
  // reach them wherever they are in the app. Mounted here rather than in
  // the Arena for exactly that reason.
  const [dodgeQueue, setDodgeQueue] = useState([]);
  // **The Stat is part of the identity (multi-target attacks).** An attack
  // naming several Stats now asks one question per Stat, so two prompts can
  // legitimately share a pair and an attacking move — keying on those alone
  // deduped the second question away and left the round paused on a prompt
  // nobody was ever shown.
  const dodgeKey = (d) => `${d.pairIndex}:${d.attackerDeclaredMoveId}:${d.targetSlotName ?? ''}`;
  useEffect(() => {
    if (role !== 'gm') return undefined;
    const onDodge = (payload) =>
      setDodgeQueue((q) => (q.some((d) => dodgeKey(d) === dodgeKey(payload)) ? q : [...q, payload]));
    socket.on('combat:dodge_prompt', onDodge);
    return () => socket.off('combat:dodge_prompt', onDodge);
  }, [role]);

  // §2.4 — a GM who connects (or reconnects) while a pair is already paused
  // picks the prompt up from the regular combat snapshot, since the live
  // push above only reached sockets connected at the moment it fired. Same
  // dedupe key, so a socket that got both doesn't queue it twice.
  useEffect(() => {
    if (role !== 'gm' || !combat) return;
    const pending = (combat.pairs ?? [])
      .filter((p) => p.pendingDodge)
      .map((p) => ({
        ...p.pendingDodge,
        pairIndex: p.pairIndex,
        roundNumber: p.roundNumber,
        // The snapshot carries the raw pause state, which names the Stats still
        // to be called rather than the one being asked about right now — the
        // live push spells that out and this has to agree with it, or a
        // reconnecting GM re-queues a question they already answered.
        targetSlotName: p.pendingDodge.remainingStats?.[0] ?? null,
      }));
    if (!pending.length) return;
    setDodgeQueue((q) => {
      const seen = new Set(q.map(dodgeKey));
      const added = pending.filter((d) => !seen.has(dodgeKey(d)));
      return added.length ? [...q, ...added] : q;
    });
  }, [combat, role]);

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

  const dodgeDialog = (() => {
    if (!dodgeQueue.length) return null;
    const d = dodgeQueue[0];
    return (
      <DodgePromptDialog
        pairIndex={d.pairIndex}
        attackerDeclaredMoveId={d.attackerDeclaredMoveId}
        attackerCharacterName={d.attackerCharacterName}
        attackerMoveName={d.attackerMoveName}
        defenderCharacterName={d.defenderCharacterName}
        defenderMoveName={d.defenderMoveName}
        attackerResult={d.attackerResult}
        targetSlotName={d.targetSlotName}
        remainingStats={d.remainingStats}
        onResolve={() => setDodgeQueue((q) => q.slice(1))}
      />
    );
  })();

  // Grappling's mini-game. Unlike the Dodge prompt there is no live push to
  // listen for and no queue: the server already computes, per viewer, whether
  // THIS person has a prompt and what they are allowed to see of it
  // (mapPendingGrappleForViewer), and hangs it on the pair in the ordinary
  // combat snapshot. That makes reconnect recovery free — a reload just picks
  // the prompt back up — and it makes the secrecy structural rather than
  // something this component has to remember to honour.
  const grappleDialog = (() => {
    const pair = (combat?.pairs ?? []).find(
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

  if (!combat || !activePair) return conflictDialog ?? dodgeDialog;

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
          attackStarts={attackStarts}
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
      {conflictDialog}
      {dodgeDialog}
      {grappleDialog}
    </div>
  );
}
