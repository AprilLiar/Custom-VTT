// The fixed 7-style ruleset — seeded into the DB once, not editable in-app.
// A complete tournament: every pair of styles has a winner; each style
// defeats exactly 3 others and is defeated by the remaining 3.
// Icons are lucide icon names, rendered client-side.

export const STYLES = [
  { name: 'Speed', icon: 'zap' },
  { name: 'Power', icon: 'dumbbell' },
  { name: 'Improvisation', icon: 'shuffle' },
  { name: 'Technique', icon: 'crosshair' },
  { name: 'Keep-out', icon: 'arrow-left-right' },
  { name: 'Defensive', icon: 'shield' },
  { name: 'Close-Quarters', icon: 'swords' },
];

// +2 for each style you are strong against, -2 for each you are weak towards
// (the same edge read from the loser's side).
export const COUNTER_BONUS = 2;

export const DEFEATS = {
  Speed: ['Power', 'Improvisation', 'Keep-out'],
  Power: ['Defensive', 'Improvisation', 'Technique'],
  Improvisation: ['Technique', 'Keep-out', 'Close-Quarters'],
  Technique: ['Speed', 'Defensive', 'Keep-out'],
  'Keep-out': ['Power', 'Defensive', 'Close-Quarters'],
  Defensive: ['Speed', 'Improvisation', 'Close-Quarters'],
  'Close-Quarters': ['Speed', 'Power', 'Technique'],
};
