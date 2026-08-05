import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { socket } from '../socket.js';
import { getCharacter } from '../lib/api.js';
import { dieLabel } from '../lib/dice.js';
import { ANATOMY } from '../lib/anatomy.js';
import VitruvianFigure from './VitruvianFigure.jsx';
import { portraitSrc, vitruvianSrc } from '../lib/image.js';

// Combat Automation (Phase 9, sub-phase 4 — 4.1's Damage Application
// dialog). `targetCandidateIds` is the roll's own target-candidate list
// (trivially one id for a normal 1-on-1 pair, more than one under Uneven
// Combat — see the roll-context shape documented on chat_log.payload); when
// there's more than one, a small picker stands in for the Vitruvian layout
// until one is chosen. `initialHalfDamageSteps` seeds the adjustable
// half-damage-step counter — the raw roll's own computeHitDamage(total) by
// default, or the resolved (possibly reduced) Partial Block/Dodge amount
// once combat:resolve_defense has run (see ChatPanel.jsx, which tracks
// combat:defense_resolved per roll and passes the resolved figure through
// here instead). Clicking a Stat applies the CURRENT counter value via
// combat:apply_damage — the dialog deliberately never closes itself
// afterward (per the plan: "the Apply button... stays clickable
// indefinitely," letting the GM correct a misclick or split damage across
// several Stats across multiple clicks); only closing it is the explicit ✕
// or a click outside, same as every other dialog in this app (nothing here
// is "pending" that a close would discard — every click already landed for
// real). `attackerDeclaredMoveId` (sub-phase 5, optional): the roll's own
// declaredMoveId — threaded through to combat:apply_damage so it can fire
// the attacking move's own 'hit' trigger automations exactly once; omitted
// entirely for ad-hoc/manual GM damage with no attacking move behind it.
export default function DamageApplicationDialog({
  targetCandidateIds,
  initialHalfDamageSteps,
  attackerDeclaredMoveId,
  allowedSlotNames, // Attack Target (Change 001): concrete Stat names damage may land on; undefined = unrestricted (manual GM damage)
  attackTargetSource, // 'move' | 'block' | undefined
  characters,
  onClose,
}) {
  const [targetId, setTargetId] = useState(
    targetCandidateIds.length === 1 ? targetCandidateIds[0] : null
  );
  const [target, setTarget] = useState(null); // { character, dice }
  const [steps, setSteps] = useState(Math.max(0, initialHalfDamageSteps));

  useEffect(() => {
    if (targetId == null) return;
    let cancelled = false;
    const load = () =>
      getCharacter(targetId)
        .then((data) => !cancelled && setTarget(data))
        .catch(console.error);
    load();
    // Live-refresh while the dialog is open so a Stat's new size/status
    // shows immediately after each Apply click (and after an Undo).
    const events = ['die:updated', 'character:updated'];
    for (const ev of events) socket.on(ev, load);
    return () => {
      cancelled = true;
      for (const ev of events) socket.off(ev, load);
    };
  }, [targetId]);

  // Attack Target (Change 001): undefined = unrestricted (manual/ad-hoc GM
  // damage with no attacking declared move behind it) — the server applies
  // the exact same rule (see combat:apply_damage's own effective_attack_
  // targets check), this is purely a UX preview of that same restriction.
  const isAllowedTarget = (die) => allowedSlotNames == null || allowedSlotNames.includes(die.slot_name);

  const apply = (die) => {
    if (!steps || !isAllowedTarget(die)) return;
    socket.emit('combat:apply_damage', { dieId: die.id, halfDamageSteps: steps, attackerDeclaredMoveId });
  };

  const undo = () => socket.emit('combat:undo_damage');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.85, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-3 overflow-y-auto panel-cut-lg border border-zinc-700 bg-zinc-900 p-4"
      >
        <div className="flex items-center gap-2">
          <h3 className="font-display font-bold uppercase tracking-wide text-zinc-100">Apply Damage</h3>
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
            <p className="text-sm text-zinc-400">Uneven Combat — who was hit?</p>
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
        ) : !target ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="flex flex-col gap-3 md:flex-row">
            <div className="flex shrink-0 flex-col items-center gap-2 md:w-40">
              <img
                src={portraitSrc(target.character)}
                alt={target.character.name}
                className="h-16 w-16 shrink-0 border border-zinc-700 bg-zinc-800 object-cover panel-cut-sm"
              />
              <span className="font-display text-center text-sm font-semibold text-zinc-100">
                {target.character.name}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSteps((s) => Math.max(0, s - 1))}
                  className="h-8 w-8 panel-cut-sm border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800"
                >
                  −
                </button>
                <div className="w-16 text-center">
                  <div className="font-mono text-2xl font-black leading-none text-brand-300">{steps}</div>
                  <div className="text-[10px] uppercase text-zinc-600">Half-Dmg</div>
                </div>
                <button
                  type="button"
                  onClick={() => setSteps((s) => s + 1)}
                  className="h-8 w-8 panel-cut-sm border border-zinc-700 text-lg text-zinc-300 hover:bg-zinc-800"
                >
                  +
                </button>
              </div>
              <div className="text-xs text-zinc-500">= {steps * 0.5} damage</div>
              <button
                type="button"
                onClick={undo}
                className="panel-cut-sm border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Undo last
              </button>
              {targetCandidateIds.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    setTargetId(null);
                    setTarget(null);
                  }}
                  className="text-xs text-zinc-600 hover:text-zinc-400"
                >
                  Change target
                </button>
              )}
            </div>

            <div className="flex-1">
              {allowedSlotNames != null && (
                <p className="mb-1 text-center text-xs text-zinc-500">
                  Effective Attack Target:{' '}
                  <span className={allowedSlotNames.length ? 'text-zinc-300' : 'text-zinc-600'}>
                    {allowedSlotNames.length ? allowedSlotNames.join(' + ') : 'None'}
                  </span>
                  {attackTargetSource === 'block' && (
                    <span className="italic text-sky-400"> — changed by Block</span>
                  )}
                </p>
              )}
              <div className="relative aspect-square w-full select-none">
                <VitruvianFigure
                  className="absolute inset-0 h-full w-full text-zinc-400"
                  customSrc={vitruvianSrc(target.character)}
                />
                {target.dice.map((die) => {
                  const spot = ANATOMY[die.slot_name];
                  if (!spot) return null;
                  const incapacitated = die.status === 'incapacitated';
                  const allowedTarget = isAllowedTarget(die);
                  const disabled = incapacitated || !steps || !allowedTarget;
                  return (
                    <button
                      key={die.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => apply(die)}
                      title={
                        incapacitated
                          ? 'Incapacitated'
                          : !allowedTarget
                            ? 'Not an Attack Target'
                            : `Apply ${steps} Half-Damage to ${die.slot_name}`
                      }
                      style={{ top: spot.top, left: spot.left }}
                      className={`absolute flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center panel-cut-sm border font-display text-xs font-bold transition-colors ${
                        incapacitated || !allowedTarget
                          ? 'cursor-not-allowed border-zinc-800 bg-zinc-900 text-zinc-700 opacity-50'
                          : 'border-zinc-700 bg-zinc-800/90 text-zinc-100 hover:border-red-500 hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50'
                      } ${die.half_damage ? 'ring-2 ring-amber-500' : ''}`}
                    >
                      <spot.Icon className="pointer-events-none h-5 w-5 opacity-50" />
                      <span className={incapacitated ? 'line-through' : ''}>{dieLabel(die.current_size, die.bonus)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
