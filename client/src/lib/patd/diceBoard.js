// **The turn's dice board (vttprojectplan.md, "Action cards and the dice
// board").** Purely visual: a player lays this turn's rolled dice on the
// Actions they mean to use. Nothing is paid or resolved by it. Pure helpers
// shared by the client (the board, the chat card) and the server (cleaning
// the marks it stores and broadcasts).
//
// Marks for one Stance roll: { used: [dieIndex], assign: { [dieIndex]: { actionId, threshold } } }
//   used   — dice crossed out (tapped, or laid on an Action)
//   assign — dice laid on an Action, with the Gate the die's number reaches

export const MAX_DICE = 12;

// The Gate a die's number reaches on an Action: the highest header threshold
// at or below it (Damage, a 6: "5+"). null when the Action has no thresholds
// (an "X" or token cost) or the number is below its lowest one.
export function gateFor(action, value) {
  const ts = [...(action?.gates?.headerThresholds ?? [])].filter((t) => typeof t === 'number').sort((a, b) => a - b);
  let out = null;
  for (const t of ts) if (Number(value) >= t) out = t;
  return out;
}

// The Actions a turn can use: the Basic ones, and the Personal ones — always
// available (Archetypes, Build, Features) plus the rolled Stance's (its Form
// and Style) — then Super Moves. `derived` from deriveBuild, `stance` from
// stanceOfBuild. → { basic: [id], personal: [{ title, ids }], supers: [id] }
export function turnActions(derived, stance, idx) {
  const basicIds = idx.content.basicActionIds ?? [];
  const basic = new Set(basicIds);
  const always = (derived?.constantActionIds ?? []).filter((id) => !basic.has(id) && idx.get(id));
  const own = (stance?.actionIds ?? []).filter((id) => !basic.has(id) && !always.includes(id) && idx.get(id));
  const personal = [];
  if (own.length) personal.push({ title: stance?.name ?? 'Stance', ids: own });
  if (always.length) personal.push({ title: 'Always available', ids: always });
  return { basic: basicIds.filter((id) => idx.get(id)), personal, supers: (derived?.superMoveIds ?? []).filter((id) => idx.get(id)) };
}

// Marks as sent by a client, cleaned: dice indices within the roll, Action
// ids that look like ids, thresholds as numbers. Every assigned die is used.
export function cleanMarks(raw, diceCount) {
  const n = Math.min(MAX_DICE, Math.max(0, Math.trunc(Number(diceCount) || 0)));
  const okIndex = (i) => Number.isInteger(i) && i >= 0 && i < n;
  const assign = {};
  for (const [k, v] of Object.entries(raw?.assign && typeof raw.assign === 'object' ? raw.assign : {})) {
    const i = Number(k);
    if (!okIndex(i) || typeof v?.actionId !== 'string' || !/^[a-z0-9.+-]{1,120}$/.test(v.actionId)) continue;
    assign[i] = { actionId: v.actionId, threshold: Number.isInteger(v.threshold) ? v.threshold : null };
  }
  const used = [...new Set([...(Array.isArray(raw?.used) ? raw.used : []).map(Number).filter(okIndex), ...Object.keys(assign).map(Number)])].sort((a, b) => a - b);
  return { used, assign };
}

export const EMPTY_MARKS = Object.freeze({ used: [], assign: {} });
