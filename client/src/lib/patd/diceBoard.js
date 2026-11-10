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

// **Elder Style (the QA pass):** "the cost of all Actions you perform are
// reduced by 1 (to a minimum of 1+ …)" — a number counts as one higher against
// an Action's printed costs and Gates. An "X" cost has none to reduce.
export const costBonus = (action, state) =>
  (action?.gates?.headerThresholds ?? []).some((t) => typeof t === 'number') ? Math.max(0, Number(state?.costReduction?.amount) || 0) : 0;

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

// ------------------------------------------------------------------ the turn board (full automation, phase B)
//
// A Stance roll's board (dice_marks.data):
//   { stanceKey, results: [roll results], extra: [{ value, source }],
//     placements: [{ key, kind: 'die' | 'token', die?, actionId, threshold, stop,
//                    option?, answers?, text?, committed, snapshot?, summary? }],  // in placement order
//     power: false, paused: false, committing: false }
// The pool is the roll's results followed by the extra numbers (pool index).

// Numbers an Ability took out (`removed`: combined, split, Judgment's lowest
// die) keep their index but leave the pool (phase H).
export const poolOf = (data) =>
  [
    ...(data.results ?? []).map((r, i) => ({ index: i, value: r.result, die: r.die, color: r.color, bonus: r.bonus, fixed: r.die === undefined, removed: Boolean(r.removed), changed: Boolean(r.changed) })),
    ...(data.extra ?? []).map((x, j) => ({ index: (data.results ?? []).length + j, value: x.value, source: x.source, added: true, removed: Boolean(x.removed), changed: Boolean(x.changed) })),
  ].filter((p) => !p.removed);

// **The numbers still in the Action Pool (phase H):** not taken out, not spent
// by a committed Action.
export const livePool = (data) => {
  const spent = new Set((data?.placements ?? []).filter((p) => p.committed).flatMap((p) => (p.kind === 'die' ? [p.die] : p.kind === 'super' ? (p.dice ?? []) : [])));
  return poolOf(data ?? {}).filter((p) => !spent.has(p.index));
};

// Changes to a board's pool, by pool index (pure; `data` is changed in place).
export const poolEntry = (data, index) => {
  const n = (data.results ?? []).length;
  return index < n ? { list: data.results, i: index, key: 'result' } : { list: data.extra ?? [], i: index - n, key: 'value' };
};
export function setPoolValue(data, index, value) {
  const e = poolEntry(data, index);
  if (!e.list[e.i]) return false;
  e.list[e.i][e.key] = Math.max(0, Math.round(Number(value) || 0));
  e.list[e.i].changed = true;
  return true;
}
export function removePoolNumber(data, index) {
  const e = poolEntry(data, index);
  if (!e.list[e.i]) return false;
  e.list[e.i].removed = true;
  return true;
}
export function addPoolValue(data, value, source = 'ability') {
  data.extra = [...(data.extra ?? []), { value: Math.max(0, Math.round(Number(value) || 0)), source }];
  return (data.results ?? []).length + data.extra.length - 1;
}

// What everyone sees of a board (no server-only payment snapshots).
export function publicBoard(rollId, data, active) {
  return {
    rollId,
    active: Boolean(active),
    results: data.results ?? [],
    extra: data.extra ?? [],
    placements: (data.placements ?? []).map(({ key, kind, die, dice, actionId, threshold, stop, text, committed, summary, option }) => ({
      key,
      kind,
      die,
      // A Super Move's pair of matching numbers (phase I).
      dice: dice ?? null,
      actionId,
      threshold: threshold ?? null,
      stop: stop ?? null,
      text: text ?? null,
      committed: Boolean(committed),
      summary: summary ?? null,
      option: option ?? null,
    })),
    power: Boolean(data.power),
    paused: Boolean(data.paused),
    committing: Boolean(data.committing),
    // A reaction board (phase F): the reactions on offer, by resource.
    reaction: data.reaction ? { clusters: data.reaction.clusters ?? [], fighterName: data.reaction.fighterName ?? null } : null,
    // Heroic Spirit (phase F): the ally who takes this turn with these dice.
    heroic: data.heroic ?? null,
  };
}

// The tokens / HP / Shield already promised to token placements not yet
// committed — subtracted from the live state before checking another one.
export function reservedBy(placements, plans) {
  const out = { tokens: {}, hp: 0, shield: 0 };
  for (const p of placements) {
    if (p.committed || p.kind !== 'token') continue;
    const plan = plans(p);
    if (!plan || plan.error) continue;
    for (const [k, n] of Object.entries(plan.tokens ?? {})) out.tokens[k] = (out.tokens[k] ?? 0) + n;
    out.hp += plan.hp ?? 0;
    out.shield += plan.shield ?? 0;
  }
  return out;
}
export function minusReserved(state, reserved) {
  const tokens = { ...state.tokens };
  for (const [k, n] of Object.entries(reserved.tokens)) tokens[k] = Math.max(0, (tokens[k] ?? 0) - n);
  return { ...state, tokens, hp: Math.max(0, (state.hp ?? 0) - reserved.hp), shield: Math.max(0, (state.shield ?? 0) - reserved.shield) };
}

// The Gates a stop may pick: thresholds at or below the reached one.
export function stopChoices(action, reached) {
  const all = [...(action?.gates?.headerThresholds ?? []), ...(action?.gates?.effectThresholds ?? [])].filter((t) => typeof t === 'number');
  return [...new Set(all)].filter((t) => reached != null && t <= reached).sort((a, b) => a - b);
}
