// Display helpers for a Counter's optional "reward" tracking tag — purely
// cosmetic (no mechanical effect), character-owned counters only (see
// CountersTab.jsx). Still shown read-only in the Combat Arena when that
// counter is flagged Show in Combat (see CombatArena.jsx's ArenaCounterRow).
export const REWARD_TYPES = ['story', 'statistic', 'perk', 'move', 'combat_prowess'];

export const REWARD_LABELS = {
  story: 'Story',
  statistic: 'Statistic',
  perk: 'Perk',
  move: 'Move',
  combat_prowess: 'Combat Prowess',
};

// bg/text Tailwind classes per reward, loosely matched to what it tracks.
export const REWARD_COLORS = {
  story: 'bg-amber-900/50 text-amber-300',
  statistic: 'bg-blue-900/50 text-blue-300',
  perk: 'bg-violet-900/50 text-violet-300',
  move: 'bg-orange-900/50 text-orange-300',
  combat_prowess: 'bg-red-900/50 text-red-300',
};
