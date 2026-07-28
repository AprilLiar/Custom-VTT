import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { onDraggingMoveChange } from '../lib/dragMoveState.js';

// How many Tics past the current round's end to render as droppable —
// lets a player drop a move further out than the current round without
// needing to wait for it to actually arrive (see move:declare's
// placementTic, which accepts any Tic at or after the character's own
// next-eligible one).
const LOOKAHEAD_TICS = 8;

// One square on the Tic Counter strip. `footprint` (startup/active/recovery
// tic ranges, relative to the square's own absolute Tic) is only non-null
// while something is being dragged and this square is the hovered drop
// point — it drives the live width preview described in the plan: the
// footprint grows/shrinks across neighboring squares as the move's own
// Startup/Active/Recovery length dictates, without ever revealing which
// square any *other* declared move actually landed on (that stays hidden
// until reveal — see DeclaredMovesPanel in CombatArena.jsx).
function TicSquare({ relativeTic, isOverflow, isCurrent, footprintZone, onDragOver, onDrop }) {
  const zoneStyle = {
    startup: 'bg-amber-600/70 border-amber-400',
    active: 'bg-rose-600/70 border-rose-400',
    recovery: 'bg-rose-900/60 border-rose-700',
  }[footprintZone];
  return (
    <div
      onDragOver={onDragOver}
      onDrop={onDrop}
      title={`Tic ${relativeTic}`}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded border text-[11px] font-semibold transition-colors ${
        zoneStyle ??
        (isCurrent
          ? 'border-indigo-400 bg-indigo-600 text-white'
          : isOverflow
          ? 'border-zinc-700 bg-zinc-800/60 text-zinc-500'
          : 'border-zinc-700 bg-zinc-900 text-zinc-400')
      }`}
    >
      {relativeTic}
    </div>
  );
}

// The Combat Arena's Tic Counter, mounted once in App.jsx's Shell so it
// stays visible on every page — not just the Arena — for as long as
// combat.phase is non-null (see vttprojectplan.md's combat redesign
// section: Start Combat / End Combat gate this bar's visibility globally).
// Round/phase progression, Done Declaring, and Tic stepping all moved here
// from CombatArena.jsx's old CombatTimingBar so there's one authoritative
// place to see and drive combat state regardless of which page is open;
// the Arena page itself keeps the roster, the declare-a-move picker (the
// drag source for this bar's squares), and DeclaredMovesPanel.
export default function CombatHeaderBar() {
  const { role } = useRole();
  const [combat, setCombat] = useState(null);
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMoveLocal] = useState(null);

  useEffect(() => {
    getCombat().then(setCombat).catch(console.error);
    const onUpdated = (c) => setCombat(c);
    socket.on('combat:updated', onUpdated);
    return () => socket.off('combat:updated', onUpdated);
  }, []);

  useEffect(() => onDraggingMoveChange(setDraggingMoveLocal), []);

  if (!combat || combat.phase == null) return null;

  const {
    phase,
    roundNumber,
    currentTic,
    roundStartTic,
    roundLength,
    declaringSide,
    participants,
  } = combat;
  const hasParticipants = (participants ?? []).length > 0;

  const squareCount = roundLength + LOOKAHEAD_TICS;
  const squares = Array.from({ length: squareCount }, (_, i) => {
    const absoluteTic = roundStartTic + i;
    const relative = i + 1;
    return { absoluteTic, relative, isOverflow: relative > roundLength };
  });

  const zoneFor = (absoluteTic) => {
    if (!draggingMove || hoverTic == null) return null;
    const { startupTics, activeTics, recoveryTics } = draggingMove;
    const startupEnd = hoverTic + startupTics;
    const activeEnd = startupEnd + activeTics;
    const recoveryEnd = activeEnd + recoveryTics;
    if (absoluteTic >= hoverTic && absoluteTic < startupEnd) return 'startup';
    if (absoluteTic >= startupEnd && absoluteTic < activeEnd) return 'active';
    if (absoluteTic >= activeEnd && absoluteTic < recoveryEnd) return 'recovery';
    return null;
  };

  const canDrop = phase === 'declaration';

  const handleDrop = (absoluteTic) => (e) => {
    e.preventDefault();
    setHoverTic(null);
    const raw = e.dataTransfer.getData('application/x-vtt-move');
    if (!raw) return;
    const { characterId, moveId } = JSON.parse(raw);
    socket.emit('move:declare', { characterId, moveId, placementTic: absoluteTic });
  };

  return (
    <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-bold text-zinc-200">Round {roundNumber}</span>
        {phase === 'declaration' && (
          <>
            <span className="text-zinc-400">
              {declaringSide
                ? `${declaringSide === 'left' ? 'Left' : 'Right'} is declaring…`
                : 'Declarations complete'}
            </span>
            {declaringSide && (
              <button
                onClick={() => socket.emit('combat:side_done_declaring', { side: declaringSide })}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {declaringSide === 'left' ? 'Left' : 'Right'} done declaring
              </button>
            )}
            {role === 'gm' && !declaringSide && (
              <button
                onClick={() => socket.emit('combat:start_tic_countdown', {})}
                className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-semibold hover:bg-indigo-500"
              >
                Start Tic Countdown
              </button>
            )}
          </>
        )}
        {phase === 'tic_countdown' && role === 'gm' && (
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
        {role === 'gm' && phase !== 'declaration' && hasParticipants && (
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
      <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
        {squares.map((sq) => (
          <TicSquare
            key={sq.absoluteTic}
            absoluteTic={sq.absoluteTic}
            relativeTic={sq.relative}
            isOverflow={sq.isOverflow}
            isCurrent={sq.absoluteTic === currentTic}
            footprintZone={zoneFor(sq.absoluteTic)}
            onDragOver={
              canDrop
                ? (e) => {
                    e.preventDefault();
                    setHoverTic(sq.absoluteTic);
                  }
                : undefined
            }
            onDrop={canDrop ? handleDrop(sq.absoluteTic) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
