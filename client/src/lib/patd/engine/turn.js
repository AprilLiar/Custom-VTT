// **Turn structure and reactions (full automation, phase F — book pp.66-70).**
// Pure: an Action's own conditions and limits, which reactions a fighter
// has right now (grouped by the resource that pays for them — decided), the
// Comeback rule's squares, and who counts as Taken Out.

import { gateFor } from '../diceBoard.js';
import { affordableOptions, hasDiceCost, tokenOptions } from '../tokenCost.js';

// ------------------------------------------------------------------ conditions and limits

// The turn as an Action sees it: { isOwnTurn, isEnemyTurn, isAlliedTurn,
// performedByAnotherAction, tokens }.
export function turnContext({ actorId, actorSide, activeId, activeSide, tokens = {}, performedByAnotherAction = false }) {
  const isOwnTurn = actorId === activeId;
  return { isOwnTurn, isEnemyTurn: !isOwnTurn && activeSide != null && activeSide !== actorSide, isAlliedTurn: !isOwnTurn && activeSide === actorSide, performedByAnotherAction, tokens };
}

// An Action's condition (content: refs to context.* and self.tokens.*, with
// eq / not). Anything else is unknown → null (left to people).
export function evalCondition(c, ctx) {
  if (c == null) return true;
  // Plain values (numbers in a comparison) stay as they are.
  if (typeof c !== 'object') return c;
  if (typeof c.ref === 'string') {
    const m = c.ref.match(/^context\.(isOwnTurn|isEnemyTurn|isAlliedTurn|performedByAnotherAction)$/);
    if (m) return Boolean(ctx[m[1]]);
    const t = c.ref.match(/^self\.tokens\.([a-z_]+)$/);
    if (t) return ctx.tokens?.[t[1]] ?? 0;
    return null;
  }
  const args = (c.args ?? []).map((a) => evalCondition(a, ctx));
  if (args.some((a) => a === null)) return null;
  switch (c.operator) {
    case 'not':
      return !args[0];
    case 'eq':
      return args[0] === args[1];
    case 'and':
      return args.every(Boolean);
    case 'or':
      return args.some(Boolean);
    default:
      return null;
  }
}

// Usage counters live in the fight runtime's `usage`; the period suffix lets
// runtime.startTurn clear them (':turn' each turn, ':round' each round).
const PERIOD = { turn: 'turn', enemy_turn: 'turn', round: 'round', fight: 'fight' };
export const limitKey = (actionId, fighterId, period) => `action:${actionId}:${fighterId}:${PERIOD[period] ?? 'turn'}`;
const usesOf = (limits) => (limits ?? []).filter((l) => (l.metric ?? 'uses') === 'uses' && PERIOD[l.period]);

// May `fighterId` use `action` now? `pending`: how many more of it are
// already placed this turn (not yet performed). → { ok, reason }
export function actionUsable(action, ctx, usage = {}, fighterId, pending = 0) {
  for (const c of action?.conditions ?? []) {
    const v = evalCondition(c, ctx);
    if (v !== null && !v) return { ok: false, reason: conditionText(c) };
  }
  for (const l of usesOf(action?.limits)) {
    const used = (usage[limitKey(action.id, fighterId, l.period)] ?? 0) + pending;
    if (used >= l.maximum) return { ok: false, reason: `only ${l.maximum === 1 ? 'once' : `${l.maximum} times`} per ${l.period.replace('_', ' ')}` };
  }
  return { ok: true };
}
const conditionText = (c) =>
  c?.ref === 'context.isEnemyTurn'
    ? "only during an enemy's turn"
    : c?.ref === 'context.isOwnTurn'
      ? 'only on your own turn'
      : c?.ref === 'context.isAlliedTurn'
        ? "only during an ally's turn"
        : c?.operator === 'not' && c.args?.[0]?.ref === 'context.isOwnTurn'
          ? 'not on your own turn'
          : 'its condition is not met';

// After an Action is performed: count it against its limits.
export function recordUse(usage, action, fighterId) {
  for (const l of usesOf(action?.limits)) {
    const k = limitKey(action.id, fighterId, l.period);
    usage[k] = (usage[k] ?? 0) + 1;
  }
}

// ------------------------------------------------------------------ Super Moves (phase I)

export const isSuperMove = (a) => typeof a?.id === 'string' && a.id.startsWith('super-move.');
// Paid with two matching numbers of 3+ (all but Transcendant Spirit, which is
// offered while giving your Heroic Spirit — server/triggers.js transcendantSpirit).
export const superOnBoard = (a) => isSuperMove(a) && (a.timing ?? 'when_an_action_can_be_performed') === 'when_an_action_can_be_performed' && (a.cost?.options ?? []).some((o) => (o.components ?? []).some((c) => c.kind === 'pool_number' && c.matching));
export const SUPER_MINIMUM = 3;
export const superKey = (fighterId) => `super:${fighterId}:fight`;

// **May this fighter use a Super Move now? (decided: all limits enforced)**
// Not in Round 1; once per fight per character; the side's per-round limit
// from the Cinematic Weight (Feather 0, Light/Middle/Heavy 1, World 2).
// → { ok, reason }
export function superUsable({ move, round, usedByMe = 0, sideUsed = 0, sideLimit = 1, pending = 0 }) {
  if (!superOnBoard(move)) return { ok: false, reason: 'used while giving your Heroic Spirit (you are asked then)' };
  if (!(round > 1)) return { ok: false, reason: 'not in Round 1' };
  if (usedByMe + pending >= 1) return { ok: false, reason: 'once per fight' };
  if (sideUsed >= sideLimit) return { ok: false, reason: sideLimit ? `your side has used its Super Move${sideLimit === 1 ? '' : 's'} this Round` : 'no Super Moves at this Cinematic Weight' };
  return { ok: true };
}

// The pair a Super Move is paid with: the picked number and a free one
// matching it, both 3+. `taken`: pool indexes already placed. → [i, j] or null
export function superPair(pool, index, taken = []) {
  const n = pool.find((p) => p.index === index);
  if (!n || !(n.value >= SUPER_MINIMUM) || taken.includes(index)) return null;
  const mate = pool.find((p) => p.index !== index && p.value === n.value && !taken.includes(p.index));
  return mate ? [index, mate.index] : null;
}

// ------------------------------------------------------------------ reactions

// The reactions a fighter can take now, by the resource that pays for them
// (decided: one cluster per resource). `ids`: the Actions their current
// Stance gives (Basic and Personal). `state`: their payable state
// (tokenCost.js). `chaos`: Chaos tokens held, `chaosUsed`: already spent one
// this turn (Chaos is once per turn). → [{ resource, label, ids }]
export function reactionClusters({ ids, idx, ctx, usage, fighterId, state, chaos = 0, chaosUsed = false }) {
  const tokens = [];
  const viaChaos = [];
  for (const id of ids) {
    const a = idx.get(id);
    if (!a || !actionUsable(a, ctx, usage, fighterId).ok) continue;
    if (tokenOptions(a).length && affordableOptions(a, state).length) tokens.push(id);
    // "Spend a Chaos Token to take a Reactive Action, as if you had spent a 4."
    if (chaos > 0 && !chaosUsed && hasDiceCost(a) && gateFor(a, 4) != null) viaChaos.push(id);
  }
  const out = [];
  if (tokens.length) out.push({ resource: 'tokens', label: 'Paid with tokens', ids: tokens });
  if (viaChaos.length) out.push({ resource: 'chaos', label: 'Chaos token (as a 4)', ids: viaChaos });
  return out;
}

// ------------------------------------------------------------------ Taken Out and the Comeback rule

// Taken Out (book p.62): at zero HP on the last bar, or removed from play.
export const atZero = (hp) => hp?.max != null && hp.bars - hp.broken <= 1 && hp.current === 0;
export const takenOut = (f) => !f.square || atZero(f.hp);

// The Comeback rule's squares: empty spaces within 3 of the arena's edge.
// On lanes only a lane's ends are the edge (`colsOnly`).
export function comebackSquares(bounds, isEmpty, { within = 3, colsOnly = false } = {}) {
  if (!bounds) return [];
  const out = [];
  for (let col = bounds.colMin; col <= bounds.colMax; col++) {
    for (let row = bounds.rowMin; row <= bounds.rowMax; row++) {
      const fromCols = Math.min(col - bounds.colMin, bounds.colMax - col);
      const edge = colsOnly ? fromCols : Math.min(fromCols, row - bounds.rowMin, bounds.rowMax - row);
      if (edge < within && isEmpty({ col, row })) out.push({ col, row });
    }
  }
  return out;
}
