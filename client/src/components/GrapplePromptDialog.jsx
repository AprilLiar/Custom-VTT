import { useState } from 'react';
import { socket } from '../socket.js';
import DialogShell from './DialogShell.jsx';

// Grappling's follow-up sequence — the one moment in a fight where you read
// your opponent live rather than guessing in advance at declaration time.
//
// **Two phases, in order (decided, revised).** The grab has already been
// settled by the time this appears: what is left is the grappler choosing what
// to do with the hold, and then — only if there was more than one way it could
// go — the defender guessing which way it went. So exactly one side is being
// asked at any moment, and the other is told who they are waiting on.
//
// **The same cross, seen two ways.** The grappler gets the move names, their
// Stamina costs, and which ones they cannot actually take. The defender gets
// four arrows in the same places with all of that stripped. That asymmetry is
// enforced server-side (mapPendingGrappleForViewer) — this component only
// renders what it was given, so a defender who opens devtools finds nulls.

const CROSS = ['blank', 'up', 'blank', 'left', 'centre', 'right', 'blank', 'down', 'blank'];
const GLYPH = { up: '↑', down: '↓', left: '←', right: '→' };
// Must match DECLINE_FOLLOW_UP in server/grappleLogic.js — deliberately not
// 'none', which is already the "no read happened" outcome.
const DECLINE = 'decline';

const WHY_NOT = {
  'not-owned': 'not learned',
  unaffordable: 'no Stamina',
};

export default function GrapplePromptDialog({ pairIndex, pending, onAnswered }) {
  const [sent, setSent] = useState(null);
  const isGrappler = pending.role === 'grappler';
  const choosing = pending.phase === 'choice';
  const byDirection = new Map((pending.directions ?? []).map((d) => [d.direction, d]));

  const answer = (direction) => {
    if (sent) return;
    setSent(direction);
    socket.emit(isGrappler ? 'combat:grapple_choose' : 'combat:grapple_guess', {
      pairIndex,
      direction,
      grapplerDeclaredMoveId: pending.grapplerDeclaredMoveId,
    });
    onAnswered?.();
  };

  const waiting = sent != null || pending.answered;

  // Nothing is being asked of this viewer — either they already answered or it
  // is not their phase. Naming who holds it up is the difference between a
  // round that looks broken and one that is visibly waiting on a person.
  if (waiting) {
    return (
      <DialogShell
        title="The hold is on"
        variant="fullscreen"
        dismissible={false}
        maxWidth="max-w-md"
        onClose={() => {}}
      >
        <p className="text-center text-sm text-zinc-400">
          {sent != null ? 'Answer in. ' : ''}
          Waiting on <b className="text-amber-300">{pending.waitingOn}</b> to{' '}
          {choosing ? 'choose where the grab goes' : 'guess which way it went'}.
        </p>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      title={isGrappler ? 'You have them — where does it go?' : 'Which way is it going?'}
      variant="fullscreen"
      dismissible={false}
      maxWidth="max-w-xl"
      onClose={() => {}}
    >
      <p className="mb-4 text-center text-sm text-zinc-400">
        {isGrappler ? (
          <>
            <b className="text-amber-300">{pending.grapplerMoveName}</b> has{' '}
            {pending.targetCharacterName}. Pick the follow-up — it goes on the timeline
            straight after the grab, and they will get one guess at it.
          </>
        ) : (
          <>
            <b className="text-amber-300">{pending.grapplerCharacterName}</b> has hold of you
            with {pending.grapplerMoveName}, and has already chosen. Guess which way it
            goes: read it right and what comes next takes{' '}
            <b className="text-emerald-300">−5</b>; read it wrong and it takes{' '}
            <b className="text-red-300">+5</b>.
          </>
        )}
      </p>

      <div className="mx-auto grid w-full max-w-md grid-cols-3 gap-2">
        {CROSS.map((cell, i) => {
          if (cell === 'blank') return <div key={i} />;
          if (cell === 'centre') {
            return (
              <div
                key={i}
                className="flex items-center justify-center panel-cut-sm border border-dashed border-zinc-700 px-2 py-4 text-center text-[11px] uppercase leading-tight text-zinc-500"
              >
                the hold
              </div>
            );
          }
          const assigned = byDirection.get(cell);
          // The grappler may only take a direction that carries a move they can
          // actually use; the defender may guess ANY of the four, including one
          // that carries nothing — guessing at an empty direction is a wrong
          // guess, not an invalid move.
          const usable = isGrappler ? Boolean(assigned?.available) : true;
          const disabled = !usable;
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => answer(cell)}
              title={
                isGrappler && assigned && !assigned.available
                  ? `${assigned.moveName} — ${WHY_NOT[assigned.reason] ?? 'unavailable'}`
                  : undefined
              }
              className={`flex min-h-24 flex-col items-center justify-center gap-1 panel-cut-sm border px-2 py-3 text-center transition-colors ${
                disabled
                  ? 'border-zinc-800 bg-zinc-900 text-zinc-700'
                  : 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:border-amber-500 hover:bg-amber-900/25'
              }`}
            >
              <span className="text-2xl leading-none">{GLYPH[cell]}</span>
              {isGrappler ? (
                <>
                  <span className="line-clamp-2 text-[11px] leading-tight">
                    {assigned?.moveName ?? '—'}
                  </span>
                  {assigned && !assigned.available && (
                    <span className="text-[10px] uppercase text-red-400/80">
                      {WHY_NOT[assigned.reason] ?? 'unavailable'}
                    </span>
                  )}
                  {assigned?.available && assigned.staminaCost ? (
                    <span className="text-[10px] text-zinc-500">
                      {assigned.staminaCost > 0 ? `-${assigned.staminaCost}` : `+${-assigned.staminaCost}`} Stamina
                    </span>
                  ) : null}
                </>
              ) : (
                // The app's established "something is there, but not what"
                // grammar: the shape stays, the substance is greyed out.
                <span
                  className={`text-[11px] leading-tight ${
                    assigned ? 'text-zinc-500' : 'text-zinc-700'
                  }`}
                >
                  {assigned ? '???' : '—'}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {isGrappler && (
        // Always offered, even when nothing is takeable — which is the whole
        // point of still showing the cross in that case (decided): the grappler
        // gets to see what they could not afford rather than being silently
        // skipped. The hold and its On Successful Grapple already happened, so
        // declining costs nothing.
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => answer(DECLINE)}
            className="panel-cut-sm border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500"
          >
            Take it no further
          </button>
        </div>
      )}

      <p className="mt-4 text-center text-xs text-zinc-500">
        {isGrappler
          ? 'Greyed directions carry a move you have not learned or cannot pay for.'
          : 'Any direction can be guessed — even an empty one.'}
      </p>
    </DialogShell>
  );
}
