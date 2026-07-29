// Pure Tic-timing math for Combat Timing (Phase 7) — no I/O, so it can be
// unit-tested in isolation before any of it is wired into sockets or the
// Arena UI (see server/test/combatTiming.test.js and the plan's Combat
// Timing mechanic + Implementation Risks sections). The Tic counter is a
// single global value that never resets; round boundaries are just markers
// on that timeline (round_start_tic), which is what makes overflow between
// rounds fall out of plain arithmetic instead of needing special-casing.

// A side's Initiative is the highest Brain roll among characters on that
// side (Declaration Phase). The losing side declares first. Ties aren't
// addressed in the plan; broken here by having 'left' declare first (i.e.
// 'right' wins ties) — an arbitrary but deterministic default.
export function resolveSideInitiative({ left, right }) {
  const leftInitiative = Math.max(...left);
  const rightInitiative = Math.max(...right);
  const firstToDeclare = leftInitiative <= rightInitiative ? 'left' : 'right';
  const secondToDeclare = firstToDeclare === 'left' ? 'right' : 'left';
  return { leftInitiative, rightInitiative, firstToDeclare, secondToDeclare };
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
