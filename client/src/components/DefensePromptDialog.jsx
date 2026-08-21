import { useEffect, useState } from 'react';
import { socket } from '../socket.js';
import DialogShell from './DialogShell.jsx';

// **Every defence is adjudicated by the GM (decided, reversed).** This started
// life as DodgePromptDialog, the one human decision left in an otherwise fully
// automatic round, and it now asks the same question of a **Block** as well —
// reversing the Combat Automation overhaul's decision #1 ("Block is fully
// automatic, purely dice-based, zero GM clicks, ever").
//
// The reason is a rule no amount of code can decide: a Straight and a Haymaker
// can both come at the head, but a *front* guard stops one and a *side* guard
// stops the other, and nothing in the frame data knows the difference. A
// defence that happens to overlap in time was being taken as proof it was the
// *right* defence.
//
// One component for both, because it is one question — "did this defence
// actually apply?" — and two dialogs asking it in two voices is how the pair
// drifts. What differs is only what a Yes means, and that is the engine's
// business, not this dialog's: a confirmed Dodge negates the attack outright,
// while a confirmed Block then rolls its guard and can still come out Partial.
//
// Mounted by CombatHeaderBar rather than inside the Arena, so it reaches the GM
// wherever they are in the app — the paused pair's round cannot continue until
// they answer, and they may well be looking at a different fight (or a character
// sheet). dismissible={false} for the same reason MoveConflictDialog is: the
// pause is real game state that needs *an* answer, not a dialog to wave away.
//
// **This dialog does not take itself down (decided, reworked).** It is rendered
// from the pause as the server reports it, and it stays up until the server
// stops reporting it. Clicking used to dismiss it on the spot, which meant an
// answer that never arrived — a phone that had already dropped its socket, most
// often — took the question with it and left the fight unadvanceable. Now a
// click only disables the buttons, and if nothing comes back the dialog says so
// and lets the GM try again.
const KIND = {
  dodge: {
    title: 'Dodge — did it land?',
    event: 'combat:resolve_dodge',
    verb: 'dodging',
    border: 'border-emerald-700/50',
  },
  block: {
    title: 'Block — did it hold?',
    event: 'combat:resolve_block',
    verb: 'blocking',
    border: 'border-sky-700/50',
  },
};

export default function DefensePromptDialog({
  defenseKind = 'dodge',
  pairIndex,
  attackerDeclaredMoveId,
  attackerCharacterName,
  attackerMoveName,
  defenderCharacterName,
  defenderMoveName,
  attackerResult,
  // A Block is asked on 'too-short' coverage as well as 'full', and those are
  // different questions to answer — one guard covered the whole swing, the
  // other only caught its opening. Null for a Dodge, which only ever reaches a
  // person on 'full'.
  coverage,
  // Multi-target attacks (decided, new): a move naming several Stats asks one
  // question per Stat, so the prompt has to say WHICH line of the attack it is
  // about — otherwise the GM sees the same dialog twice and has no way to tell
  // it apart from a duplicate. Null for a move with no Attack Target of its
  // own, which is one question about the attack as a whole.
  targetSlotName,
  remainingStats,
  // Called on click, purely so a hand-summoned copy of this prompt can stand
  // down (see lib/pausePrompts.js). It does NOT dismiss this dialog.
  onAnswered,
}) {
  const kind = KIND[defenseKind] ?? KIND.dodge;
  // 'idle' → 'sent' → 'stalled'. Nothing here clears back to 'idle' on success:
  // success means the server stops reporting this pause and the whole dialog
  // unmounts (or re-mounts under a new key for the next Stat).
  const [submit, setSubmit] = useState('idle');
  useEffect(() => {
    if (submit !== 'sent') return undefined;
    const timer = setTimeout(() => setSubmit('stalled'), 8000);
    return () => clearTimeout(timer);
  }, [submit]);

  const resolve = (outcome) => {
    socket.emit(kind.event, { pairIndex, outcome, attackerDeclaredMoveId });
    setSubmit('sent');
    onAnswered?.();
  };
  const busy = submit === 'sent';

  return (
    <DialogShell
      title={kind.title}
      dismissible={false}
      maxWidth="max-w-sm"
      panelClassName={kind.border}
      footer={
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => resolve('failed')}
            disabled={busy}
            className="min-h-11 flex-1 panel-cut-sm border border-red-700/50 bg-red-950/40 py-2 font-semibold text-red-300 hover:bg-red-900/40 disabled:opacity-50"
          >
            Failed
          </button>
          <button
            type="button"
            onClick={() => resolve('successful')}
            disabled={busy}
            className="min-h-11 flex-1 panel-cut-sm bg-emerald-700 py-2 font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            Successful
          </button>
        </div>
      }
    >
      <p className="text-sm text-zinc-300">
        <span className="font-semibold text-zinc-100">{defenderCharacterName ?? 'The defender'}</span>
        {defenderMoveName ? ` is ${kind.verb} with "${defenderMoveName}"` : ` is ${kind.verb}`},{' '}
        {coverage === 'too-short' ? 'catching the opening of' : 'fully covering'}{' '}
        <span className="font-semibold text-zinc-100">{attackerCharacterName ?? 'the attacker'}</span>
        {attackerMoveName ? `'s "${attackerMoveName}"` : "'s attack"}.
      </p>
      {targetSlotName && (
        <p className="mt-2 text-sm text-zinc-300">
          This call is about the strike to{' '}
          <span className="font-semibold text-amber-300">{targetSlotName}</span>
          {/* Only counted out when there is actually more to come — on an
              ordinary single-Stat attack the tally would be noise. */}
          {(remainingStats?.length ?? 0) > 1
            ? `, then ${remainingStats.length - 1} more Stat${remainingStats.length - 1 === 1 ? '' : 's'} this same attack is coming for.`
            : '.'}
        </p>
      )}
      {defenseKind === 'block' && (
        <p className="mt-2 text-xs text-zinc-500">
          Successful rolls the guard and subtracts it — it can still come out Partial. Failed
          discards the guard entirely: the attack lands as though nothing were there, and the
          Recovery is not extended.
        </p>
      )}
      {attackerResult != null && (
        <p className="mt-2 text-xs text-zinc-500">
          Attacker rolled <span className="font-semibold text-zinc-300">{attackerResult}</span>. The rest of
          this round is paused until you call it.
        </p>
      )}
      {submit === 'sent' && <p className="mt-2 text-xs text-zinc-500">Sending your call…</p>}
      {submit === 'stalled' && (
        <p className="mt-2 text-xs text-amber-300/90">
          No answer came back. The call may not have reached the table — the buttons are live again,
          so try once more.
        </p>
      )}
    </DialogShell>
  );
}
