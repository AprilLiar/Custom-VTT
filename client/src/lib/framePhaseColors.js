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

export const FRAME_PHASES = ['startup', 'active', 'recovery', 'defense'];

export const PHASE_LABEL = {
  startup: 'Startup',
  active: 'Active',
  recovery: 'Recovery',
  defense: 'Defense',
};

// Flat fills — frame-data strips, lane-snapshot segments, the small
// footprint-preview squares, and the cutscene's own move bars.
export const PHASE_BG = {
  startup: 'bg-amber-500',
  active: 'bg-rose-500',
  recovery: 'bg-blue-500',
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
  const { placementTic, revealTic, activeEndTic, recoveryEndTic, defenseFramePositions } = footprint;
  if (tic < placementTic || tic >= recoveryEndTic) return null;
  if (defenseFramePositions?.includes(tic - placementTic)) return 'defense';
  if (tic < revealTic) return 'startup';
  if (tic < activeEndTic) return 'active';
  return 'recovery';
}

// phaseAt + palette lookup in one step, for the many call sites that only
// ever want the class name. Returns null outside the footprint so callers
// can skip rendering a segment at all.
export function phaseBgAt(footprint, tic) {
  const phase = phaseAt(footprint, tic);
  return phase ? PHASE_BG[phase] : null;
}
