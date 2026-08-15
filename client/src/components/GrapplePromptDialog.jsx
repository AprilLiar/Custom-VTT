import { useState } from 'react';
import { socket } from '../socket.js';
import DialogShell from './DialogShell.jsx';

// Grappling's direction mini-game — the one moment in a fight where you read
// your opponent live rather than guessing in advance at declaration time.
//
// **The same cross, seen two ways.** The grappler gets the move names and
// picks where the grab goes. The target gets four arrows in the same places
// with the names stripped, and guesses which one it went. That asymmetry is
// enforced server-side (mapPendingGrappleForViewer) — this component only
// renders whatever it was given, so a target who opens devtools finds
// nulls, not names.
//
// Both prompts appear at the same moment and neither resolves anything on
// its own: the contest waits for both answers, so clicking first tells the
// other side nothing.

const CROSS = ['blank', 'up', 'blank', 'left', 'centre', 'right', 'blank', 'down', 'blank'];
const GLYPH = { up: '↑', down: '↓', left: '←', right: '→' };

export default function GrapplePromptDialog({ pairIndex, pending, onAnswered }) {
  const [sent, setSent] = useState(null);
  const isGrappler = pending.role === 'grappler';
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

  return (
    <DialogShell
      title={isGrappler ? 'Which way?' : 'Which way is it going?'}
      // `fullscreen`, not `theater`: theater fills the viewport on every size
      // because the cutscene is something you sit and watch. This is a prompt
      // you answer in two seconds, and it looked stranded in all that space.
      variant="fullscreen"
      dismissible={false}
      maxWidth="max-w-xl"
      onClose={() => {}}
    >
      <p className="mb-4 text-center text-sm text-zinc-400">
        {isGrappler ? (
          <>
            <b className="text-amber-300">{pending.grapplerMoveName}</b> has{' '}
            {pending.targetCharacterName}. Pick where it goes — they are guessing at
            the same moment.
          </>
        ) : (
          <>
            <b className="text-amber-300">{pending.grapplerCharacterName}</b> has hold of you
            with {pending.grapplerMoveName}. Guess which way it goes. Read it right
            and you get <b className="text-emerald-300">+5</b>; read it wrong and they do.
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
                the grab
              </div>
            );
          }
          const assigned = byDirection.get(cell);
          // The grappler may only send the grab somewhere it can actually go;
          // the target may guess ANY of the four, including one that carries
          // nothing — guessing at an empty direction is a wrong guess, not an
          // invalid move.
          const disabled = waiting || (isGrappler && !assigned);
          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => answer(cell)}
              className={`flex min-h-24 flex-col items-center justify-center gap-1 panel-cut-sm border px-2 py-3 text-center transition-colors ${
                sent === cell
                  ? 'border-amber-400 bg-amber-800/40 text-amber-100'
                  : disabled
                    ? 'border-zinc-800 bg-zinc-900 text-zinc-700'
                    : 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:border-amber-500 hover:bg-amber-900/25'
              }`}
            >
              <span className="text-2xl leading-none">{GLYPH[cell]}</span>
              {isGrappler ? (
                <span className="line-clamp-2 text-[11px] leading-tight">
                  {assigned?.moveName ?? '—'}
                </span>
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

      <p className="mt-4 text-center text-xs text-zinc-500">
        {waiting
          ? 'Answer in. Waiting for the other side…'
          : isGrappler
            ? 'Only directions carrying a move can be picked.'
            : 'Any direction can be guessed — even an empty one.'}
      </p>
    </DialogShell>
  );
}
