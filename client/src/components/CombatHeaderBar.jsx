import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';
import { TicCounterCentral } from './CombatArena.jsx';
import { onDraggingMoveChange } from '../lib/dragMoveState.js';

// This viewer's own current standing in the fight — "waiting for
// declaration," "your turn," and so on (decided, Tic navigation redesign).
// The GM has no personal declare turn (they run every NPC), so they get the
// same administrative pair-count summary this bar always showed; a Player
// gets a status about their own seated character specifically. Only
// meaningful during Declaration — Tic Countdown is the same experience for
// everyone (watching Tics advance), so it keeps its own generic badge below
// instead of a per-viewer line.
function viewerDeclarationStatus({ pairs, participants }, role, characterId) {
  const pairsStillDeclaring = (pairs ?? []).filter((p) => p.declaring_side != null).length;
  if (role === 'gm') {
    return pairsStillDeclaring === 0
      ? 'Every pair has finished declaring'
      : `${pairsStillDeclaring} pair${pairsStillDeclaring === 1 ? '' : 's'} still declaring…`;
  }
  const participant = (participants ?? []).find((p) => p.character_id === characterId);
  if (!participant) return 'Not seated in this fight';
  if (participant.declared_this_round) return 'Waiting on other declarations…';
  const pair = (pairs ?? []).find((pr) => pr.pair_index === participant.pair_index);
  return pair?.declaring_side === participant.side ? 'Your turn to declare!' : 'Waiting for declaration…';
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
// just without a working drop.
export default function CombatHeaderBar() {
  const { role, characterId } = useRole();
  const location = useLocation();
  const [combat, setCombat] = useState(null);
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMove] = useState(null);

  useEffect(() => onDraggingMoveChange(setDraggingMove), []);

  useEffect(() => {
    getCombat(role === 'gm' ? { role } : { role, characterId }).then(setCombat).catch(console.error);
    const onUpdated = (c) => setCombat(c);
    socket.on('combat:updated', onUpdated);
    return () => socket.off('combat:updated', onUpdated);
  }, [role, characterId]);

  if (!combat || combat.phase == null) return null;

  const { phase, roundNumber, currentTic, roundStartTic, roundLength } = combat;
  const onArena = location.pathname === '/combat';
  const everyoneReady =
    phase === 'declaration' && (combat.pairs ?? []).every((p) => p.declaring_side == null);
  // Same "who still has something recovering here from last round" badge
  // math as CombatArena.jsx's own overflowTics — duplicated rather than
  // shared since it's a few lines of pure array/map building, not worth
  // threading combat state between two independently-mounted components for.
  const overflowTics = new Map();
  for (const dm of combat.declaredMoves ?? []) {
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
        {phase === 'tic_countdown' && (
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
          onClick={() => socket.emit('combat:start_tic_countdown', {})}
          className="panel-cut-sm bg-brand-600 px-2 py-1 text-xs font-semibold hover:bg-brand-500"
        >
          Start Tic Countdown
        </button>
      )}
      {role === 'gm' && phase !== 'declaration' && (
        <button
          onClick={() => socket.emit('combat:next_round', {})}
          className="panel-cut-sm bg-emerald-700 px-2 py-1 text-xs font-semibold hover:bg-emerald-600"
        >
          Next Round
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
    </div>
  );
}
