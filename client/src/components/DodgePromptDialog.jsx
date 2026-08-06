import { socket } from '../socket.js';
import DialogShell from './DialogShell.jsx';

// Combat Automation overhaul §4.1 — the one human decision left in an
// otherwise fully automatic round (decision #2).
//
// This replaces ResolveDefenseDialog's old 4-tile grid (Block/Dodge ×
// Successful/Failed) with a 2-tile picker, because three of those four axes
// stopped being human choices: Block now resolves entirely from dice math,
// "which move is defending" is auto-selected from frame overlap, and a
// Dodge that doesn't fully cover the attack's Active window auto-fails
// without asking. Only a full-coverage Dodge reaches a person, and the only
// question left is whether it landed.
//
// Delivered through CombatHeaderBar's global dialog queue rather than
// mounted inside the Arena, so it reaches the GM wherever they are in the
// app — the paused pair's round cannot continue until they answer, and
// they may well be looking at a different fight (or a character sheet).
// dismissible={false} for the same reason MoveConflictDialog is: the pause
// is real game state that needs *an* answer, not a dialog to wave away.
export default function DodgePromptDialog({
  pairIndex,
  attackerDeclaredMoveId,
  attackerCharacterName,
  attackerMoveName,
  defenderCharacterName,
  defenderMoveName,
  attackerResult,
  onResolve,
}) {
  const resolve = (outcome) => {
    socket.emit('combat:resolve_dodge', { pairIndex, outcome, attackerDeclaredMoveId });
    onResolve();
  };

  return (
    <DialogShell
      title="Dodge — did it land?"
      dismissible={false}
      maxWidth="max-w-sm"
      panelClassName="border-emerald-700/50"
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => resolve('failed')}
            className="min-h-11 flex-1 panel-cut-sm border border-red-700/50 bg-red-950/40 py-2 font-semibold text-red-300 hover:bg-red-900/40"
          >
            Failed
          </button>
          <button
            type="button"
            onClick={() => resolve('successful')}
            className="min-h-11 flex-1 panel-cut-sm bg-emerald-700 py-2 font-semibold text-white hover:bg-emerald-600"
          >
            Successful
          </button>
        </div>
      }
    >
      <p className="text-sm text-zinc-300">
        <span className="font-semibold text-zinc-100">{defenderCharacterName ?? 'The defender'}</span>
        {defenderMoveName ? ` is dodging with "${defenderMoveName}"` : ' is dodging'}, fully covering{' '}
        <span className="font-semibold text-zinc-100">{attackerCharacterName ?? 'the attacker'}</span>
        {attackerMoveName ? `'s "${attackerMoveName}"` : "'s attack"}.
      </p>
      {attackerResult != null && (
        <p className="mt-2 text-xs text-zinc-500">
          Attacker rolled <span className="font-semibold text-zinc-300">{attackerResult}</span>. The rest of
          this round is paused until you call it.
        </p>
      )}
    </DialogShell>
  );
}
