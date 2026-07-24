// Pure validation/normalization for Moves — kept free of I/O for unit testing.

export const TRIGGERS = ['hit', 'block', 'miss'];

// Frame data: 0-10 squares per segment (Startup/Active/Recovery), at least
// one square total. Startup yellow, Active red, Recovery blue (client-side).
export const FRAME_MAX = 10;

export function clampFrame(value) {
  const n = Math.trunc(Number(value) || 0);
  return Math.max(0, Math.min(FRAME_MAX, n));
}

export function validFrames(startup, active, recovery) {
  return startup + active + recovery >= 1;
}

// Automation types on an interaction (the only automated effects for now):
//   self_recovery:     add/remove Recovery on yourself (amount may be negative)
//   opponent_recovery: add Recovery to the opponent (positive)
//   self_stamina:      lose additional Stamina yourself (positive = amount lost)
//   opponent_stamina:  the opponent loses Stamina (positive = amount lost)
// Execution happens in the combat phases; Phase 3 stores and displays them.
export const AUTOMATION_TYPES = [
  'self_recovery',
  'opponent_recovery',
  'self_stamina',
  'opponent_stamina',
];

const AMOUNT_LIMIT = 20;

// Returns a cleaned automations array, dropping anything malformed.
export function sanitizeAutomations(list) {
  if (!Array.isArray(list)) return [];
  const clean = [];
  for (const entry of list) {
    if (!entry || !AUTOMATION_TYPES.includes(entry.type)) continue;
    let amount = Math.trunc(Number(entry.amount) || 0);
    amount = Math.max(-AMOUNT_LIMIT, Math.min(AMOUNT_LIMIT, amount));
    if (amount === 0) continue;
    // Only self_recovery is signed (add or remove); the rest are positive.
    if (entry.type !== 'self_recovery') amount = Math.abs(amount);
    clean.push({ type: entry.type, amount });
  }
  return clean;
}

// Normalizes the interactions payload {hit, block, miss} -> rows worth storing
// (non-empty text or at least one automation).
export function normalizeInteractions(interactions) {
  const rows = [];
  if (!interactions || typeof interactions !== 'object') return rows;
  for (const trigger of TRIGGERS) {
    const entry = interactions[trigger];
    if (!entry) continue;
    const text = String(entry.text ?? '').trim();
    const automations = sanitizeAutomations(entry.automations);
    if (text || automations.length) rows.push({ trigger, text, automations });
  }
  return rows;
}
