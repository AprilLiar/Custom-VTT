import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { useRole } from '../roleContext.jsx';

// Slim global strip, mounted once in App.jsx's Shell so round/phase state is
// reachable from any page (Phase 7's original "decided" behavior) — but
// since the combat redesign (Phase 9), this bar itself stays deliberately
// minimal: the prominent Tic Counter, the drag-and-drop declare target, and
// the per-character declaration status table are all Arena-only now (see
// CombatArena.jsx) — "the Tic Counter is the centerpiece of the Arena," not
// something duplicated in miniature on every page. This bar is just a
// glanceable "combat is happening, here's the gist" strip, plus the GM's
// round-level controls (Next Round / Start Tic Countdown / Tic step / End
// Combat) so they don't have to leave whatever page they're on to advance
// the fight in a pinch.
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

  const { phase, roundNumber, pairs } = combat;
  const pairsStillDeclaring = (pairs ?? []).filter((p) => p.declaring_side != null).length;
  const everyoneReady = phase === 'declaration' && pairsStillDeclaring === 0;
  const onArena = location.pathname === '/combat';

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 px-4 py-2 text-sm">
      <span className="rounded-full bg-indigo-600/20 px-2.5 py-0.5 font-bold text-indigo-300">
        Round {roundNumber}
      </span>
      {phase === 'declaration' && (
        <span className="text-zinc-400">
          {pairsStillDeclaring === 0
            ? 'Every pair has finished declaring'
            : `${pairsStillDeclaring} pair${pairsStillDeclaring === 1 ? '' : 's'} still declaring…`}
        </span>
      )}
      {phase === 'tic_countdown' && <span className="text-zinc-400">Tic Countdown</span>}
      {!onArena && (
        <Link
          to="/combat"
          className="rounded-md border border-indigo-700/50 bg-indigo-950/40 px-2 py-1 text-xs font-semibold text-indigo-300 hover:bg-indigo-900/40"
        >
          Go to Arena →
        </Link>
      )}
      {role === 'gm' && phase === 'tic_countdown' && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => socket.emit('combat:tic_backward', {})}
            title="Tic back"
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            ◀
          </button>
          <button
            onClick={() => socket.emit('combat:tic_forward', {})}
            title="Tic forward"
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            ▶
          </button>
        </div>
      )}
      {role === 'gm' && everyoneReady && (
        <button
          onClick={() => socket.emit('combat:start_tic_countdown', {})}
          className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold hover:bg-indigo-500"
        >
          Start Tic Countdown
        </button>
      )}
      {role === 'gm' && phase !== 'declaration' && (
        <button
          onClick={() => socket.emit('combat:next_round', {})}
          className="rounded-md bg-emerald-700 px-2 py-1 text-xs font-semibold hover:bg-emerald-600"
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
          className="ml-auto rounded-md border border-zinc-700 px-3 py-1 text-xs font-semibold text-zinc-400 hover:bg-zinc-800"
        >
          End Combat
        </button>
      )}
    </div>
  );
}
