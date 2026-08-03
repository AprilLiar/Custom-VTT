import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { socket } from '../socket.js';
import { getCombat } from '../lib/api.js';

// Combat Automation (Phase 9, sub-phase 4 — 4.2's GM defense prompt).
// GM-only, opened from the attacker's own chat roll card once the GM judges
// a Defense Frame is actually in play for one of `targetCandidateIds` (the
// GM makes this call themselves, same trust model as everywhere else in
// this no-auth app — there's no attempt here to duplicate
// classifyDefenseCoverage's frame-overlap math client-side just to decide
// whether to *show* this button; the server is the single source of truth
// for whether the picked defender's coverage is actually valid, including
// force-correcting an invalid pick to Failed — see combat:resolve_defense).
// The defender-move picker below is sourced from combat.declaredMoves,
// already filtered server-side to whatever this GM is actually entitled to
// see (isRevealedToViewer) — a still-secret Player move simply doesn't
// appear, the same secrecy the rest of the Arena already enforces, no
// special-casing needed here.
export default function ResolveDefenseDialog({
  attackerDeclaredMoveId,
  attackerResult,
  targetCandidateIds,
  characters,
  onClose,
}) {
  const [targetId, setTargetId] = useState(
    targetCandidateIds.length === 1 ? targetCandidateIds[0] : null
  );
  const [declaredMoves, setDeclaredMoves] = useState(null);
  const [defenderDeclaredMoveId, setDefenderDeclaredMoveId] = useState(null);
  const [defenseType, setDefenseType] = useState(null); // 'block' | 'dodge'
  const [outcome, setOutcome] = useState(null); // 'successful' | 'failed'

  useEffect(() => {
    getCombat({ role: 'gm' })
      .then((c) => setDeclaredMoves(c.declaredMoves ?? []))
      .catch(console.error);
  }, []);

  const defenderOptions = (declaredMoves ?? []).filter(
    (dm) => dm.characterId === targetId && dm.moveId != null
  );

  const submit = () => {
    if (!defenderDeclaredMoveId || !defenseType || !outcome) return;
    socket.emit('combat:resolve_defense', {
      attackerDeclaredMoveId,
      attackerResult,
      defenderDeclaredMoveId,
      defenseType,
      outcome,
    });
    onClose();
  };

  // Tailwind's build only picks up class names it can see literally in the
  // source, so the active-state classes are a static lookup rather than a
  // `border-${color}-500`-style interpolation, which would silently produce
  // unstyled tiles in the production build.
  const ACTIVE_TILE_CLASS = {
    sky: 'border-sky-500 bg-sky-900/40 text-sky-300',
    emerald: 'border-emerald-500 bg-emerald-900/40 text-emerald-300',
    red: 'border-red-500 bg-red-900/40 text-red-300',
  };

  const Tile = ({ active, onClick, children, color }) => (
    <button
      type="button"
      onClick={onClick}
      className={`panel-cut-sm border py-4 text-center font-display text-sm font-bold uppercase tracking-wide transition-colors ${
        active ? ACTIVE_TILE_CLASS[color] : 'border-zinc-700 text-zinc-400 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.85, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        className="flex w-full max-w-md flex-col gap-3 panel-cut-lg border border-zinc-700 bg-zinc-900 p-4"
      >
        <div className="flex items-center gap-2">
          <h3 className="font-display font-bold uppercase tracking-wide text-zinc-100">Resolve Defense</h3>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto panel-cut-sm px-2 text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        {targetId == null ? (
          <div className="space-y-2">
            <p className="text-sm text-zinc-400">Who defended?</p>
            <div className="flex flex-wrap gap-2">
              {targetCandidateIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTargetId(id)}
                  className="panel-cut-sm border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-brand-500 hover:bg-zinc-800"
                >
                  {characters?.get(id)?.name ?? `Character #${id}`}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <label className="text-sm text-zinc-400">
              Defending move
              <select
                value={defenderDeclaredMoveId ?? ''}
                onChange={(e) => setDefenderDeclaredMoveId(Number(e.target.value) || null)}
                className="mt-1 w-full panel-cut-sm border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100"
              >
                <option value="">
                  {declaredMoves === null
                    ? 'Loading…'
                    : defenderOptions.length === 0
                      ? 'No visible declared move for this character'
                      : 'Select…'}
                </option>
                {defenderOptions.map((dm) => (
                  <option key={dm.id} value={dm.id}>
                    {dm.moveName}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <Tile active={defenseType === 'block'} onClick={() => setDefenseType('block')} color="sky">
                Block
              </Tile>
              <Tile active={defenseType === 'dodge'} onClick={() => setDefenseType('dodge')} color="sky">
                Dodge
              </Tile>
              <Tile active={outcome === 'successful'} onClick={() => setOutcome('successful')} color="emerald">
                Successful
              </Tile>
              <Tile active={outcome === 'failed'} onClick={() => setOutcome('failed')} color="red">
                Failed
              </Tile>
            </div>

            <button
              type="button"
              disabled={!defenderDeclaredMoveId || !defenseType || !outcome}
              onClick={submit}
              className="panel-cut-sm bg-brand-600 py-2 font-semibold text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Resolve
            </button>
            {targetCandidateIds.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setTargetId(null);
                  setDefenderDeclaredMoveId(null);
                }}
                className="text-xs text-zinc-600 hover:text-zinc-400"
              >
                Change target
              </button>
            )}
          </>
        )}
      </motion.div>
    </div>
  );
}
