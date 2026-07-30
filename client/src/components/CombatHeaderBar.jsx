import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';
import { TicSquare } from './CombatArena.jsx';

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
// navigation itself now lives entirely in the Arena (click the next/previous
// Tic square there — see CombatArena.jsx's TicCounterCentral); this bar is a
// glanceable "combat is happening, here's the gist" strip instead: a link
// back to the Arena, the same Tic Counter squares (read-only here) so the
// round's shape is visible without leaving the page, this viewer's own
// current state, and the GM's remaining round-level controls (Start Tic
// Countdown / Next Round / End Combat) so they don't have to leave whatever
// page they're on to advance the fight in a pinch.
export default function CombatHeaderBar() {
  const { role, characterId } = useRole();
  const location = useLocation();
  const [combat, setCombat] = useState(null);

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
  const squares = Array.from({ length: roundLength }, (_, i) => ({
    absoluteTic: roundStartTic + i,
    relative: i + 1,
  }));

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
      <div className="flex flex-wrap items-center gap-1">
        {squares.map((sq) => (
          <TicSquare key={sq.absoluteTic} relativeTic={sq.relative} isCurrent={sq.absoluteTic === currentTic} />
        ))}
      </div>
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
