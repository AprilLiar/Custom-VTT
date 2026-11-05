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

// The Gate a die's number (or a paid cost's rating) reaches on an Action.
// By the rules you get every Gate up to it (decided), so this is the top one:
// the highest cost threshold at or below the number (Damage, a 6: 5). An
// "X" cost has no cost thresholds — any number buys its base effect (0) and
// reaches its effect Gates (Grapple, a 7: 7). null when the number is below
// the Action's lowest cost (Guard, a 3).
export function gateFor(action, value) {
  const nums = (list) => [...(list ?? [])].filter((t) => typeof t === 'number').sort((a, b) => a - b);
  const header = nums(action?.gates?.headerThresholds);
  const effect = nums(action?.gates?.effectThresholds);
  const v = Number(value);
  if (header.length) {
    if (!(v >= header[0])) return null;
    return [...header, ...effect].filter((t) => t <= v).reduce((a, b) => Math.max(a, b), header[0]);
  }
  return effect.filter((t) => t <= v).reduce((a, b) => Math.max(a, b), 0);
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
