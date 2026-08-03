import { motion } from 'framer-motion';
import { socket } from '../socket.js';

// Combat Automation (Phase 9, sub-phase 4 — 4.3's Forfeit/Postpone prompt).
// Fires whenever a Block's Recovery extension runs into a character's own
// already-declared move (combat:move_conflict — see CombatHeaderBar.jsx,
// which queues these the same way it already queues the reveal-time
// auto-Roll dialog, scoped to whoever actually controls this character).
// No "current footprint" preview is shown here — the choice itself doesn't
// depend on exactly where things land, just Forfeit-it-outright vs.
// Postpone-it-past-the-blocker, so the dialog stays this simple. Closing
// without choosing is deliberately not offered (unlike a Roll dialog, which
// can just be skipped for later): the conflict is real game state that
// needs *a* resolution before the round can keep making sense, so both
// buttons that update state, no bare dismiss button.
export default function MoveConflictDialog({
  declaredMoveId,
  blockerDeclaredMoveId,
  moveName,
  characterName,
  onResolve,
}) {
  const resolve = (choice) => {
    socket.emit('combat:resolve_move_conflict', { declaredMoveId, blockerDeclaredMoveId, choice });
    onResolve();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <motion.div
        initial={{ scale: 0.85, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        className="flex w-full max-w-sm flex-col gap-3 panel-cut-lg border border-amber-700/50 bg-zinc-900 p-4"
      >
        <h3 className="font-display font-bold uppercase tracking-wide text-amber-300">Move Blocked</h3>
        <p className="text-sm text-zinc-300">
          A Block's extended Recovery has run into {characterName ? `${characterName}'s ` : ''}
          {moveName ? `declared "${moveName}"` : 'another declared move'}. Forfeit it, or postpone it
          until after the block clears?
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => resolve('forfeit')}
            className="flex-1 panel-cut-sm border border-red-700/50 bg-red-950/40 py-2 font-semibold text-red-300 hover:bg-red-900/40"
          >
            Forfeit
          </button>
          <button
            type="button"
            onClick={() => resolve('postpone')}
            className="flex-1 panel-cut-sm bg-brand-600 py-2 font-semibold text-white hover:bg-brand-500"
          >
            Postpone
          </button>
        </div>
      </motion.div>
    </div>
  );
}
