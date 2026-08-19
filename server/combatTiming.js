// Pure Tic-timing math for Combat Timing (Phase 7) — no I/O, so it can be
// unit-tested in isolation before any of it is wired into sockets or the
// Arena UI (see server/test/combatTiming.test.js and the plan's Combat
// Timing mechanic + Implementation Risks sections). The Tic counter is a
// single global value that never resets; round boundaries are just markers
// on that timeline (round_start_tic), which is what makes overflow between
// rounds fall out of plain arithmetic instead of needing special-casing.

// A side's Initiative is the highest Brain roll among characters on that
// side (Declaration Phase). The losing side declares first. `left`/`right`
// are arrays of per-character records: `{ characterId, roll, currentBrain,
// lockedBrain, hasSpeedStance }` — only `roll` is required for the common
// (non-tied) case, the rest feed the tie-break cascade below.
//
// Tie-break (decided): when the two sides' top roll is exactly equal, only
// the character(s) — on either side — who actually posted that tied roll
// are eligible tie-break candidates (a side with one high outlier and one
// low roller isn't dragged in by its low roller). Among those candidates,
// in order: highest current Brain value (die size + bonus) wins; if still
// tied, highest locked Brain value wins; if still tied, a candidate with
// Speed in their current active stance wins (only if that narrows the
// field — if none or all have it, it doesn't decide anything); if still
// tied, pick at random. Whichever side the winning candidate belongs to
// wins the roll-off — same as the non-tied case, the loser declares first.
// `random` is injectable (defaults to Math.random) so the random fallback
// stays deterministic in tests.
export function resolveSideInitiative({ left, right }, random = Math.random) {
  const initiativeOf = (side) => side.reduce((best, c) => Math.max(best, c.roll), -Infinity);
  const leftInitiative = initiativeOf(left);
  const rightInitiative = initiativeOf(right);

  let winnerSide;
  if (leftInitiative !== rightInitiative) {
    winnerSide = leftInitiative > rightInitiative ? 'left' : 'right';
  } else {
    const candidates = [
      ...left.filter((c) => c.roll === leftInitiative).map((c) => ({ ...c, side: 'left' })),
      ...right.filter((c) => c.roll === rightInitiative).map((c) => ({ ...c, side: 'right' })),
    ];
    winnerSide = breakInitiativeTie(candidates, random)?.side ?? 'right';
  }
  const firstToDeclare = winnerSide === 'left' ? 'right' : 'left';
  const secondToDeclare = firstToDeclare === 'left' ? 'right' : 'left';
  return { leftInitiative, rightInitiative, firstToDeclare, secondToDeclare };
}

// Narrows `list` to whichever entries share the max value of `keyFn`.
function narrowToBest(list, keyFn) {
  const best = list.reduce((max, c) => Math.max(max, keyFn(c)), -Infinity);
  return list.filter((c) => keyFn(c) === best);
}

function breakInitiativeTie(candidates, random) {
  if (!candidates.length) return null;
  let pool = narrowToBest(candidates, (c) => c.currentBrain ?? -Infinity);
  if (pool.length > 1) pool = narrowToBest(pool, (c) => c.lockedBrain ?? -Infinity);
  if (pool.length > 1) {
    const withSpeed = pool.filter((c) => c.hasSpeedStance);
    if (withSpeed.length > 0 && withSpeed.length < pool.length) pool = withSpeed;
  }
  if (pool.length > 1) return pool[Math.floor(random() * pool.length)];
  return pool[0];
}

// A character's next move can't be placed before the round's start Tic, or
// before their own last-queued move's full footprint ends (reveal Tic +
// Active + Recovery) — even if that move was queued in a previous round
// (Declaration Phase). `previousBlockedUntilTic` is null for a character's
// first move ever. Revised (decided): an earlier version of this rule only
// blocked through Startup (the reveal Tic), letting a new move get placed
// while an earlier one was still Active or Recovering — see
// vttprojectplan.md's Combat Timing section.
export function computePlacementTic({ roundStartTic, previousBlockedUntilTic }) {
  if (previousBlockedUntilTic == null) return roundStartTic;
  return Math.max(roundStartTic, previousBlockedUntilTic);
}

// A move placed at placementTic resolves/reveals at placementTic + startup,
// then occupies Active and Recovery Tics beyond that (informational — see
// computePlacementTic above for why these don't gate the *next* move).
export function computeMoveFootprint({ placementTic, startupTics, activeTics, recoveryTics }) {
  const revealTic = placementTic + startupTics;
  const activeEndTic = revealTic + activeTics;
  const recoveryEndTic = activeEndTic + recoveryTics;
  return { placementTic, revealTic, activeEndTic, recoveryEndTic };
}

// Reveal state is computed live from the current Tic, never cached — so
// moving the counter backward naturally re-hides a move that hasn't
// "really" happened yet. The declaring character's own client always sees
// the real move; everyone else only past the reveal Tic.
export function isMoveRevealedTo({ revealTic, currentTic, viewerIsOwner }) {
  return viewerIsOwner || currentTic >= revealTic;
}

// A new round's start Tic must never land inside the previous round's own
// window, even if the GM presses Next Round without ever stepping the Tic
// Countdown forward (e.g. right after Start Tic Countdown, or after only a
// partial countdown) — otherwise computePlacementTic can't tell the
// difference between genuine cross-round overflow and a round that simply
// never elapsed, and a character's moves declared (but never resolved) last
// round wrongly keep blocking the exact same Tics again this round. The new
// round is therefore floored at a full round_length past the previous
// round's own start — actual overflow (a footprint ending later than that)
// still carries through normally, since computePlacementTic takes the max of
// this and the offending move's own blocked-until Tic. The very first round
// (phase null — no previous window to protect against) is exempt and simply
// starts wherever the counter already sits.
export function computeNextRoundStartTic({ phase, currentTic, roundStartTic, roundLength }) {
  if (phase === null) return currentTic;
  return Math.max(currentTic, roundStartTic + roundLength);
}

// Initiative overflow penalty (decided, new rule): a character whose own
// last-queued move is still carrying its footprint into the new round takes
// a penalty on that round's Brain initiative roll equal to how many of the
// new round's own Tics are still occupied by it — the same "blocked until"
// floor computePlacementTic already uses to gate their next declare (see
// move:declare server-side), just expressed as a roll penalty here instead
// of a placement floor. `blockedUntilTic` is null for a character with no
// declared moves yet (always 0 penalty — including the very first round,
// which by definition has no previous round to overflow from); a move that
// already fully resolved before the new round starts also floors at 0
// rather than going negative.
export function computeInitiativeOverflowPenalty({ blockedUntilTic, nextRoundStartTic }) {
  if (blockedUntilTic == null) return 0;
  return Math.max(0, blockedUntilTic - nextRoundStartTic);
}

// The GM's display shows Tics relative to the current round (Tic 1-N) even
// though the underlying counter never resets. A Tic past round_length is
// overflow — it belongs to this round only in the sense that it's still
// finishing a move placed during it; the next Next Round press starts a new
// round_start_tic at whatever the counter is currently at.
export function relativeTic({ tic, roundStartTic, roundLength }) {
  const relative = tic - roundStartTic + 1;
  const overflowBy = Math.max(0, relative - roundLength);
  return { relative, isOverflow: overflowBy > 0, overflowBy };
}

// Idle-Tic Stamina Regen (decided, see plan): a Tic is "idle" for a
// character only if it falls completely outside every one of their declared
// moves' full footprint — Startup through Recovery, same window
// computePlacementTic blocks the next move against — including a move
// carried over from an earlier round via overflow. Any single Tic touched
// by any footprint (even just Recovery, even just the placement Tic itself)
// disqualifies it; there's no partial credit. `footprints` is this
// character's full set of `{ placementTic, recoveryEndTic }` windows
// (inclusive on both ends) across every move that could still be live,
// regardless of which round declared it.
export function isTicIdle({ tic, footprints }) {
  return !footprints.some(({ placementTic, recoveryEndTic }) => tic >= placementTic && tic <= recoveryEndTic);
}

// Combat Automation overhaul, decision #7 — Interruption's "moment of
// impact." Walks the attacker's own Active window Tic by Tic
// (`[attackerActiveStart, attackerActiveEnd)`, same half-open convention as
// every other footprint check in this module) and returns the FIRST Tic at
// which the target is still inside their own declared move's Startup
// window (placementTic <= tic < that move's own revealTic) — giving
// combatDamage.js's computeInterruptBonus real variation (more elapsed
// Active Tics before the target's Startup is caught = a bigger bonus)
// instead of collapsing to a flat +1 every time. `targetMoves` is the
// target's own declared moves as `{ declaredMoveId, placementTic,
// revealTic }`. Returns null when the target's Startup never overlaps the
// attack at all — no Interruption fires for this attack.
export function findInterruptEligibleTic({ attackerActiveStart, attackerActiveEnd, targetMoves }) {
  for (let tic = attackerActiveStart; tic < attackerActiveEnd; tic++) {
    const startupMove = targetMoves.find((m) => m.placementTic <= tic && tic < m.revealTic);
    if (startupMove) return { tic, declaredMoveId: startupMove.declaredMoveId };
  }
  return null;
}

// Lane snapshot chat cards (decided, Chat Log redesign): a declared move's
// squares only ever appear on a snapshot when its footprint overlaps the
// round's own displayed Tic window — the snapshot mirrors the live Tic
// Counter, which likewise only ever shows one round's worth of squares at a
// time, never a past round's own. `recoveryEndTic` is exclusive (the first
// Tic no longer occupied), matching every other footprint check in this
// module; `roundStartTic + roundLength` (the window's own exclusive end) is
// the same convention.
export function overlapsRoundWindow({ placementTic, recoveryEndTic, roundStartTic, roundLength }) {
  return placementTic < roundStartTic + roundLength && recoveryEndTic > roundStartTic;
}

// ---------- Imposed Recovery (decided, new) ----------
//
// An `opponent_recovery` (or `self_recovery`) automation used to be a purely
// bookkeeping change: it bumped one declared move's `recovery_extension_tics`
// and nothing on the board moved. **It lands on the clock now** — the extra
// Recovery is applied at the Tic it fires on, and everything that character
// had declared after it slides that many Tics later.
//
// Where the frames go depends on what the target is doing at that exact Tic,
// and there are exactly three answers:
//
//   - **`'startup'`** — caught winding up. The extra Tics are added to that
//     move's own Startup, so the move is *delayed*: `placementTic` stays
//     where it is (the wind-up genuinely started there) and `revealTic`
//     moves later, which drags Active and Recovery with it.
//   - **`'in-flight'`** — caught mid-Active or mid-Recovery. The move plays
//     out as declared and the extra Tics go on the end, after its own
//     Recovery — i.e. `recoveryExtensionTics`, the same column a Block's
//     too-late coverage already writes to.
//   - **`'idle'`** — caught between moves. There is no move to lengthen, so
//     the whole effect is the displacement: everything declared later slides.
//     Nothing is drawn on the idle Tics themselves, because there is no
//     declared move there to draw (see the plan for why this is deliberate
//     rather than missing).
//
// In all three the tail is the same: **every move of that character starting
// after the affected one moves later by `tics`.** That is what keeps the
// timeline legal — lengthening a move without moving what follows it would
// overlap the two, which is precisely the state `computePlacementTic` exists
// to prevent at declare time.
//
// Pure: `moves` in, `updates` out, no database and no clock of its own. The
// caller passes this character's declared moves as
// `{ id, placementTic, revealTic, activeTics, recoveryTics, recoveryExtensionTics }`
// and writes back whatever comes out. `updates` only ever contains rows that
// actually changed, so an empty list is a legitimate "nothing to do".
//
// `tics` must be positive — a *negative* self_recovery shrinks a window, and
// pulling later moves earlier would violate the placement floors they were
// declared under, so that case is deliberately left to the plain
// `clampRecoveryExtension` path and answers `{ phase: 'none' }` here.
export function planImposedRecovery({ moves, tic, tics }) {
  const none = { phase: 'none', affectedMoveId: null, updates: [] };
  if (!Number.isInteger(tics) || tics <= 0) return none;
  if (!Number.isInteger(tic)) return none;

  const withEnds = (moves ?? []).map((m) => ({
    ...m,
    recoveryEndTic: m.revealTic + m.activeTics + m.recoveryTics + (m.recoveryExtensionTics ?? 0),
  }));

  // Half-open, like every other footprint check here: a move owns
  // [placementTic, recoveryEndTic).
  const hit = withEnds.find((m) => m.placementTic <= tic && tic < m.recoveryEndTic) ?? null;
  const phase = hit == null ? 'idle' : tic < hit.revealTic ? 'startup' : 'in-flight';

  const updates = [];
  if (hit && phase === 'startup') {
    updates.push({ id: hit.id, placementTic: hit.placementTic, revealTic: hit.revealTic + tics,
      recoveryExtensionTics: hit.recoveryExtensionTics ?? 0 });
  } else if (hit) {
    updates.push({ id: hit.id, placementTic: hit.placementTic, revealTic: hit.revealTic,
      recoveryExtensionTics: (hit.recoveryExtensionTics ?? 0) + tics });
  }

  // "After the affected one" is measured from where the affected move
  // starts, not from `tic` — a move that begins on the same Tic the hit move
  // begins on cannot exist (footprints never overlap), so this is an exact
  // partition rather than a heuristic. With nothing hit, `tic` itself is the
  // dividing line.
  const after = hit ? hit.placementTic : tic;
  for (const m of withEnds) {
    if (m.placementTic <= after) continue;
    if (hit && m.id === hit.id) continue;
    updates.push({
      id: m.id,
      placementTic: m.placementTic + tics,
      revealTic: m.revealTic + tics,
      recoveryExtensionTics: m.recoveryExtensionTics ?? 0,
    });
  }

  return { phase, affectedMoveId: hit?.id ?? null, updates };
}
