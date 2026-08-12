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

// ---------- Block Tag (the first Tag automation) ----------
//
// A move carrying the **Block** Tag has no up-front Stamina Cost. It pays at
// resolution for exactly as much of the attack as its guard absorbed, scaled
// by its Stamina Modifier — see server/tagAutomations.js for the rule and
// server/combatDamage.js's resolveBlockStamina for the arithmetic.
//
// Matched by NAME, case-insensitively, never by id: tag ids differ between
// databases and the GM owns this list, so the client resolves a move's
// tag_ids against the live tag list exactly the way the server resolves its
// own. Keeping both sides on the name is what stops the two from disagreeing
// about which moves are Blocks.
export const BLOCK_TAG_NAME = 'Block';

const normTag = (name) => String(name ?? '').trim().toLowerCase();

export function isBlockTagId(tagId, tags) {
  const tag = (tags ?? []).find((t) => t.id === tagId);
  return tag ? normTag(tag.name) === normTag(BLOCK_TAG_NAME) : false;
}

// `tagIds` may be a move's stored tag_ids or the Move Creator's live
// selection — both are plain id arrays, so this covers the saved card and
// the half-authored form alike.
export function carriesBlockTag(tagIds, tags) {
  return (tagIds ?? []).some((id) => isBlockTagId(id, tags));
}

// "×1.5" / "×0.5" — the multiplier as the table reads it. 1 is still shown
// rather than hidden: "this Block charges exactly what it absorbed" is a real
// statement about the move, not an absent value.
export function staminaModifierLabel(modifier) {
  const n = Number(modifier);
  return `×${Number.isFinite(n) && n > 0 ? n : 1}`;
}
