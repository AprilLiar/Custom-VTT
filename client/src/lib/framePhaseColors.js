// The one canonical Startup/Active/Recovery/Defense palette.
//
// Combat Automation overhaul §4.3: this used to be four near-duplicate
// copies — FrameBar's SEGMENTS (yellow/red/blue/green), CombatArena's
// DECLARED_PHASE_COLOR (the same four), TicSquare's zoneStyle (amber/rose/
// blue, bordered + glowing), and ChatPanel's SNAPSHOT_PHASE_COLOR (amber/
// rose/blue/emerald). RoundCutscene needs the same palette again, and a
// fifth ad-hoc copy is worse than consolidating, so all of them now import
// from here.
//
// The surviving family is amber/rose/blue/emerald — the shades TicSquare's
// drop preview and ChatPanel's lane snapshots already shared, and the two
// most-recently-touched call sites. FrameBar's older yellow/red/green
// shift onto it, which is the point: one palette, one place to change it.

export const FRAME_PHASES = ['startup', 'active', 'recovery', 'trip_recovery', 'defense'];

export const PHASE_LABEL = {
  startup: 'Startup',
  active: 'Active',
  recovery: 'Recovery',
  trip_recovery: 'Trip Recovery',
  defense: 'Defense',
};

// **Trip Recovery reads as Recovery, deliberately (decided, new).** It *is*
// Recovery — same blocking, same displacement — so it stays in the blue
// family rather than taking a colour of its own; a fifth hue would say "this
// is a different kind of thing" when the point is that it is the same thing
// happening on the ground. Darker, plus a down arrow on every frame, so it is
// unmistakable at a glance without being unreadable next to ordinary blue.
//
// The arrow is what actually carries the distinction: colour alone fails for
// anyone who cannot tell two blues apart, and these two are adjacent by
// design. Rendered by `TripFrameMark` (see below) wherever a frame is big
// enough to hold it.
export const TRIP_MARK = '\u2193';

// Flat fills — frame-data strips, lane-snapshot segments, the small
// footprint-preview squares, and the cutscene's own move bars.
export const PHASE_BG = {
  startup: 'bg-amber-500',
  active: 'bg-rose-500',
  recovery: 'bg-blue-500',
  trip_recovery: 'bg-blue-800',
  defense: 'bg-emerald-500',
};

// Bordered + glowing variants, for a whole Tic square rendered as a
// footprint zone (TicSquare's drag/drop preview, and the cutscene's
// playhead highlight). `blocked` is not a frame phase — it's TicSquare's
// "you cannot drop here" state — but it lives here so a call site styling
// a Tic square has one import rather than two.
export const PHASE_ZONE = {
  startup: 'border-amber-300 bg-amber-500/80 shadow-[0_0_10px_rgba(251,191,36,0.45)]',
  active: 'border-rose-300 bg-rose-500/80 shadow-[0_0_10px_rgba(244,63,94,0.45)]',
  recovery: 'border-blue-300 bg-blue-500/80 shadow-[0_0_10px_rgba(59,130,246,0.45)]',
  trip_recovery: 'border-blue-400 bg-blue-800/90 shadow-[0_0_10px_rgba(30,64,175,0.55)]',
  defense: 'border-emerald-300 bg-emerald-500/80 shadow-[0_0_10px_rgba(16,185,129,0.45)]',
  blocked: 'border-zinc-600 bg-zinc-800 text-zinc-600',
};

// A Block that catches only the opening frame has its Recovery auto-extended to cover the
// rest of the attack's Active window — a rule, not a choice (decision #1
// keeps Block entirely out of the prompt loop), so the only way the table
// sees it happen is here. Decided: paint those Tics in the Block's own
// colour, dimmed, so they read as "this is the block, still running" rather
// than as ordinary Recovery the player authored.
export const EXTENDED_OPACITY = 0.7;

export const PHASE_BG_EXTENDED = {
  startup: 'bg-amber-500/70',
  active: 'bg-rose-500/70',
  recovery: 'bg-blue-500/70',
  trip_recovery: 'bg-blue-800/70',
  defense: 'bg-emerald-500/70',
};

// Half-open [extendedFromTic, recoveryEndTic), matching phaseAt's own
// convention. A footprint only carries recoveryExtendedFromTic once a
// recovery_extended round event has been folded into it (see
// footprintsFrom in RoundCutscene.jsx).
export function isExtendedRecoveryTic(footprint, tic) {
  const from = footprint?.recoveryExtendedFromTic;
  if (from == null) return false;
  return tic >= from && tic < footprint.recoveryEndTic;
}

// Client-side mirror of server/combatDamage.js's phaseAtTic — same
// half-open [placementTic, recoveryEndTic) convention, same
// defense-frames-win-over-their-underlying-phase rule. Returns null when
// `tic` falls outside the move's footprint entirely.
//
// A Defense Frame is an annotation on top of whichever phase it lands in
// (see sanitizeDefensePositions in server/moveLogic.js), which is why it's
// checked first: a defense-tagged Active Tic renders green, not red.
export function phaseAt(footprint, tic) {
  if (!footprint) return null;
  const {
    placementTic, revealTic, activeEndTic, recoveryEndTic, defenseFramePositions,
    tripRecoveryTics = 0,
  } = footprint;
  if (tic < placementTic || tic >= recoveryEndTic) return null;
  if (defenseFramePositions?.includes(tic - placementTic)) return 'defense';
  if (tic < revealTic) return 'startup';
  if (tic < activeEndTic) return 'active';
  const tripFrom = Math.max(activeEndTic, recoveryEndTic - Math.max(0, tripRecoveryTics));
  if (tripRecoveryTics > 0 && tic >= tripFrom) return 'trip_recovery';
  return 'recovery';
}

// phaseAt + palette lookup in one step, for the many call sites that only
// ever want the class name. Returns null outside the footprint so callers
// can skip rendering a segment at all.
export function phaseBgAt(footprint, tic) {
  const phase = phaseAt(footprint, tic);
  return phase ? PHASE_BG[phase] : null;
}


// Is this Tic one of the move's Trip Recovery frames? The renderers need this
// separately from `phaseAt` because a Defense Frame wins the *colour* while
// still being spent on the ground — a guard held from the floor is still on
// the floor, and still keeps the arrow.
export function isTripTic(footprint, tic) {
  if (!footprint) return false;
  const { activeEndTic, recoveryEndTic, tripRecoveryTics = 0 } = footprint;
  if (!(tripRecoveryTics > 0)) return false;
  if (tic < activeEndTic || tic >= recoveryEndTic) return false;
  return tic >= Math.max(activeEndTic, recoveryEndTic - tripRecoveryTics);
}

// **Where an Off The Ground move may start — the one copy of the rule.**
//
// Normally a character's next move is floored at their previous move's full
// footprint end. A move carrying **Off The Ground** may begin earlier, so its
// Startup overlaps the trip frames: you are winding up as you get back to your
// feet. Two limits, and both are the point of it:
//
//  - **Only the trip frames.** The floor never reaches past where the trip
//    window began, so ordinary Recovery stays untouchable.
//  - **Only the Startup.** Capped at the move's own Startup length, which is
//    the same statement as: its Active frames may not begin before the trip
//    window ends. You can get up while winding up; you cannot throw the punch
//    from the floor.
//
// **It lives here, on the client, and the server imports it** — the same
// arrangement `matchups.js` already has. It began as server-only, and the Tic
// Counter floored declarations without it: the trip frames a Grounding move
// left behind drew as unreachable while the server happily accepted a drop on
// them. A rule that decides both what is legal and what is drawn cannot have
// two implementations.
//
// Returns the earliest legal placement Tic. With no trip frames, or without the
// Tag, this is exactly `blockedUntilTic` — the ordinary rule, unchanged.
export function placementFloorAfterTrip({
  blockedUntilTic,
  tripRecoveryTics = 0,
  startupTics = 0,
  offTheGround = false,
}) {
  if (blockedUntilTic == null) return null;
  if (!offTheGround) return blockedUntilTic;
  const trip = Math.max(0, Math.trunc(Number(tripRecoveryTics) || 0));
  const startup = Math.max(0, Math.trunc(Number(startupTics) || 0));
  return blockedUntilTic - Math.min(trip, startup);
}
