// Display helpers for Move cards.

export const TRIGGER_LABELS = {
  hit: 'On Hit',
  block: 'On Block',
  miss: 'On Miss',
  defense_success: 'On Successful Defense',
  defense_failure: 'On Failed Defense',
};

export function automationLabel({ type, amount }) {
  const n = Math.abs(amount);
  switch (type) {
    case 'self_recovery':
      return `${amount > 0 ? '+' : '−'}${n} Recovery (self)`;
    case 'opponent_recovery':
      return `+${n} Recovery → opponent`;
    case 'self_stamina':
      return `−${n} Stamina (self)`;
    case 'opponent_stamina':
      return `−${n} Stamina → opponent`;
    default:
      return `${type} ${amount}`;
  }
}

export const AUTOMATION_OPTIONS = [
  { type: 'self_recovery', label: 'Recovery (self, +/-)' },
  { type: 'opponent_recovery', label: 'Add Recovery to opponent' },
  { type: 'self_stamina', label: 'Lose extra Stamina (self)' },
  { type: 'opponent_stamina', label: 'Opponent loses Stamina' },
  { type: 'self_stat_step', label: 'Step your own Stat (+/-)' },
  { type: 'opponent_stat_step', label: "Step the opponent's Stat (+/-)" },
];

// The two stat-step automations name one Stat outright, so they use the
// concrete slots only — the ambiguous Hand/Leg vocabulary a move's Roll
// uses has no meaning here. Mirrors AUTOMATION_STAT_SLOTS in
// server/moveLogic.js, which is the authority.
export const AUTOMATION_STAT_SLOTS = [
  'Skull',
  'Brain',
  'Left Hand',
  'Right Hand',
  'Body',
  'Stamina',
  'Left Leg',
  'Right Leg',
];

export const SIGNED_AUTOMATION_TYPES = new Set([
  'self_recovery',
  'self_stat_step',
  'opponent_stat_step',
]);

export const STAT_STEP_AUTOMATION_TYPES = new Set(['self_stat_step', 'opponent_stat_step']);
