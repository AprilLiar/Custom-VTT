import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';
import { onDraggingMoveChange } from '../lib/dragMoveState.js';

// One square on the Tic Counter strip. `footprint` (startup/active/recovery
// tic ranges, relative to the square's own absolute Tic) is only non-null
// while something is being dragged and this square is the hovered drop
// point — it drives the live width preview described in the plan: the
// footprint grows/shrinks across neighboring squares as the move's own
// Startup/Active/Recovery length dictates, without ever revealing which
// square any *other* declared move actually landed on (that stays hidden
// until reveal — see DeclaredMovesPanel in CombatArena.jsx).
function TicSquare({ relativeTic, isCurrent, footprintZone, onDragOver, onDrop }) {
  const zoneStyle = {
    startup: 'bg-amber-600/70 border-amber-400',
    active: 'bg-rose-600/70 border-rose-400',
    recovery: 'bg-blue-600/70 border-blue-400',
    blocked: 'bg-zinc-700/80 border-zinc-500 text-zinc-500',
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
  const { role, characterId } = useRole();
  const [combat, setCombat] = useState(null);
  const [hoverTic, setHoverTic] = useState(null);
  const [draggingMove, setDraggingMoveLocal] = useState(null);

  useEffect(() => {
    // This bar doesn't render declaredMoves itself, but keeps the same
    // identity-tailored fetch as CombatArena.jsx for consistency (see
    // lib/api.js's getCombat) in case that ever changes.
    getCombat(role === 'gm' ? { role } : { role, characterId }).then(setCombat).catch(console.error);
    const onUpdated = (c) => setCombat(c);
    socket.on('combat:updated', onUpdated);
    return () => socket.off('combat:updated', onUpdated);
  }, [role, characterId]);

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

  // Exactly the round's own Tics — nothing more. A move that would land
  // past the last one still declares fine (the drop clamps forward to the
  // character's real legal Tic, even beyond what's drawn here — see
  // handleDrop/move:declare); it just carries over and shows up as blocked
  // Tics at the start of next round instead of being previewable now.
  const squares = Array.from({ length: roundLength }, (_, i) => ({
    absoluteTic: roundStartTic + i,
    relative: i + 1,
  }));

  // While dragging, Tics before this character's own next-eligible Tic
  // (e.g. still finishing a move carried over from last round) are shown
  // as blocked — not just clamped silently on drop — so it's visually
  // obvious why an early Tic can't be picked.
  const zoneFor = (absoluteTic) => {
    if (!draggingMove) return null;
    const minTic = draggingMove.minPlacementTic ?? roundStartTic;
    if (absoluteTic < minTic) return 'blocked';
    if (hoverTic == null) return null;
    const effectiveTic = Math.max(hoverTic, minTic);
    const { startupTics, activeTics, recoveryTics } = draggingMove;
    const startupEnd = effectiveTic + startupTics;
    const activeEnd = startupEnd + activeTics;
    const recoveryEnd = activeEnd + recoveryTics;
    if (absoluteTic >= effectiveTic && absoluteTic < startupEnd) return 'startup';
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
            relativeTic={sq.relative}
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
