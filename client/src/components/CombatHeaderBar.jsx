import { useEffect, useState } from 'react';
import { useRole } from '../roleContext.jsx';
import { socket } from '../socket.js';
import { getCombat, getCharacters } from '../lib/api.js';
import { onDraggingMoveChange } from '../lib/dragMoveState.js';
import { joinNames } from '../lib/names.js';

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
  // Names only, kept separately from `combat` — combat:updated's broadcast
  // payload doesn't carry the full `characters` map (only the initial
  // GET /api/combat fetch does), so relying on combat.characters here
  // would go stale/undefined after the first live update.
  const [roster, setRoster] = useState(null);
  const [toast, setToast] = useState(null);
  // A move with an ambiguous Left/Right Roll slot doesn't declare on drop —
  // it holds here until the popup below records a choice (or is cancelled).
  const [pendingDeclare, setPendingDeclare] = useState(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    // This bar doesn't render declaredMoves itself, but keeps the same
    // identity-tailored fetch as CombatArena.jsx for consistency (see
    // lib/api.js's getCombat) in case that ever changes.
    getCombat(role === 'gm' ? { role } : { role, characterId }).then(setCombat).catch(console.error);
    const onUpdated = (c) => setCombat(c);
    socket.on('combat:updated', onUpdated);
    return () => socket.off('combat:updated', onUpdated);
  }, [role, characterId]);

  useEffect(() => {
    const refreshRoster = () => getCharacters().then(setRoster).catch(console.error);
    refreshRoster();
    const events = ['character:created', 'character:updated', 'character:deleted'];
    for (const ev of events) socket.on(ev, refreshRoster);
    return () => {
      for (const ev of events) socket.off(ev, refreshRoster);
    };
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
  const nameById = new Map((roster ?? []).map((c) => [c.id, c.name]));
  const namesForSide = (side) => {
    const names = (participants ?? [])
      .filter((p) => p.side === side)
      .map((p) => nameById.get(p.character_id))
      .filter(Boolean);
    return { text: joinNames(names), isPlural: names.length > 1 };
  };

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
    const { characterId, moveId, moveName, staminaCost, ambiguous, appendageSlot } = JSON.parse(raw);
    // A pre-check purely for a fast, friendly "Not enough Stamina" —
    // move:declare still enforces this authoritatively server-side (a
    // silent no-op on failure), same as ever. Mirrors the server's own
    // affordability formula, but can under-count `pending` for a character
    // this client can't see early declares for (declaring on someone
    // else's behalf, e.g. GM for a Player) — an accepted edge case given
    // the trust-based model; worst case it just misses showing the toast.
    const character = (roster ?? []).find((c) => c.id === characterId);
    if (character && Number.isInteger(staminaCost)) {
      const pending = (combat.declaredMoves ?? [])
        .filter((dm) => dm.characterId === characterId && dm.staminaCost != null && !dm.staminaCommitted)
        .reduce((sum, dm) => sum + dm.staminaCost, 0);
      if (character.current_stamina - pending - staminaCost < 0) {
        setToast('Not enough Stamina');
        return;
      }
    }
    if (ambiguous) {
      setPendingDeclare({ characterId, moveId, moveName, absoluteTic, appendageSlot });
      return;
    }
    socket.emit('move:declare', { characterId, moveId, placementTic: absoluteTic });
  };

  const chooseAppendage = (side) => {
    socket.emit('move:declare', {
      characterId: pendingDeclare.characterId,
      moveId: pendingDeclare.moveId,
      placementTic: pendingDeclare.absoluteTic,
      appendageChoice: side,
    });
    setPendingDeclare(null);
  };

  return (
    <div className="relative border-b border-zinc-800 bg-zinc-950 px-4 py-2">
      {toast && (
        <div className="absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 rounded-md border border-red-700 bg-red-950/95 px-3 py-1.5 text-sm font-semibold text-red-200 shadow-lg">
          {toast}
        </div>
      )}
      {pendingDeclare && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setPendingDeclare(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex w-72 flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
          >
            <h3 className="font-bold text-zinc-100">
              {nameById.get(pendingDeclare.characterId) ?? 'Character'}: {pendingDeclare.moveName}
            </h3>
            <p className="text-sm text-zinc-400">Which side is throwing this?</p>
            <div className="flex gap-2">
              {['left', 'right'].map((side) => (
                <button
                  key={side}
                  onClick={() => chooseAppendage(side)}
                  className="flex-1 rounded-md bg-indigo-600 py-2 font-semibold capitalize hover:bg-indigo-500"
                >
                  {side}
                  {pendingDeclare.appendageSlot ? ` ${pendingDeclare.appendageSlot}` : ''}
                </button>
              ))}
            </div>
            <button
              onClick={() => setPendingDeclare(null)}
              className="rounded-md border border-zinc-700 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-bold text-zinc-200">Round {roundNumber}</span>
        {phase === 'declaration' && (
          <>
            <span className="text-zinc-400">
              {declaringSide
                ? `${namesForSide(declaringSide).text} ${namesForSide(declaringSide).isPlural ? 'are' : 'is'} declaring…`
                : 'Declarations complete'}
            </span>
            {declaringSide && (
              <button
                onClick={() => socket.emit('combat:side_done_declaring', { side: declaringSide })}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {namesForSide(declaringSide).text} done declaring
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
