// **Paying an Action's token cost on the dice board (decided).** Pure: what a
// fighter can afford of an Action's non-dice cost options, what is left to
// choose, and the exact payment — shared by the board's dialog and the server,
// which checks and applies it (server/diceMarks.js).
//
// The fighter's state: { tokens: { key: n }, hp: n (current), shield: n,
//   challengeHolders: [{ id, name }] }  — enemies holding your Challenge.
//
// A cost option's components (content): { kind: 'token', token: key | 'basic', amount }
// (basic = any mix of Iron, Power, Speed), { kind: 'hp', amount: n | { minimum, maximum, chosen } },
// { kind: 'shield', amount: n | 'all', minimum }, { kind: 'challenge_token_on_enemy' }.

export const BASIC_KEYS = ['iron', 'power', 'speed'];
const PAYABLE = new Set(['token', 'hp', 'shield', 'challenge_token_on_enemy']);
const tokenName = (k) => (k === 'basic' ? 'Basic' : String(k).charAt(0).toUpperCase() + String(k).slice(1).replace(/_/g, ' '));

// The Action's cost options you pay without dice: [{ index, option }]. A
// "Free" Action has one, with nothing in it.
export function tokenOptions(action) {
  return (action?.cost?.options ?? [])
    .map((option, index) => ({ index, option }))
    .filter(({ option }) => (option.category === 'token' || option.category === 'free') && option.components.every((c) => PAYABLE.has(c.kind)));
}
export const hasDiceCost = (action) => (action?.cost?.options ?? []).some((o) => o.category === 'dice');
export const isFree = (action) => (action?.cost?.options ?? []).some((o) => o.category === 'free');

// **Costs changed by the fighter's own rules (the QA pass)** — both ride on
// the state:
//   state.costReduction { amount, minimumOther } — Elder Style: "the cost of
//     all Actions you perform are reduced by 1 (to a minimum of … 2
//     tokens/HP/Shield)": the option's first cost that can go down does.
//   state.luck n — Luck tokens held with the Underdog's mechanic: each "may be
//     used to pay for (part of) any Token Action, in place of up to 3 Basic
//     Tokens, 3 HP, or 3 Shield". Used for what is missing; more only when
//     `answers.luck` asks for it (the engine asks at Commit).
const REDUCIBLE = new Set(['token', 'hp', 'shield']);
const isBasicCost = (c) => c.kind === 'token' && (c.token === 'basic' || BASIC_KEYS.includes(c.token));
const luckable = (c) => typeof c.amount === 'number' && (isBasicCost(c) || c.kind === 'hp' || c.kind === 'shield');
export function costOf(option, state) {
  const r = state?.costReduction;
  let left = r ? Number(r.amount) || 0 : 0;
  const min = r?.minimumOther ?? 2;
  return option.components.map((c) => {
    if (!left || typeof c.amount !== 'number' || !REDUCIBLE.has(c.kind)) return c;
    const next = Math.min(c.amount, Math.max(min, c.amount - left));
    left -= c.amount - next;
    return next === c.amount ? c : { ...c, amount: next };
  });
}
const heldFor = (c, state) => {
  const tokens = state.tokens ?? {};
  if (c.kind === 'hp') return state.hp ?? 0;
  if (c.kind === 'shield') return state.shield ?? 0;
  return c.token === 'basic' ? BASIC_KEYS.reduce((n, k) => n + (tokens[k] ?? 0), 0) : (tokens[c.token] ?? 0);
};
// Luck spent on each component: [n per component], or null when even Luck can't cover it.
// `want`: how many Luck tokens to use in all (at least what is missing).
export function luckPlan(components, state, want = 0) {
  const held = Number(state?.luck) || 0;
  const use = components.map(() => 0);
  const left = components.map((c) => (luckable(c) ? c.amount : 0));
  let spent = 0;
  components.forEach((c, i) => {
    if (!luckable(c)) return;
    while (left[i] - Math.min(3, left[i]) >= 0 && heldFor(c, state) < left[i] && spent < held) {
      left[i] -= Math.min(3, left[i]);
      use[i]++;
      spent++;
    }
  });
  if (components.some((c, i) => luckable(c) && heldFor(c, state) < left[i])) return null;
  // More, by choice: off the biggest cost left each time.
  while (spent < Math.min(held, Number(want) || 0)) {
    let best = -1;
    left.forEach((n, i) => {
      if (n > 0 && (best < 0 || n > left[best])) best = i;
    });
    if (best < 0) break;
    left[best] -= Math.min(3, left[best]);
    use[best]++;
    spent++;
  }
  return { use, left, spent };
}
// How many Luck tokens could usefully go into an option (for the engine's question).
export function luckRoom(option, state) {
  const comps = costOf(option, state);
  const held = Number(state?.luck) || 0;
  return Math.min(held, comps.reduce((n, c) => n + (luckable(c) ? Math.ceil(c.amount / 3) : 0), 0));
}
// The option as it must be paid now: reduced (Elder), with Luck in place of what it covers.
function payable(option, state, answers) {
  const comps = costOf(option, state);
  if (!(Number(state?.luck) > 0)) return { comps, luck: 0 };
  const plan = luckPlan(comps, state, answers?.luck);
  if (!plan) return { comps, luck: 0 };
  return { comps: comps.map((c, i) => (plan.use[i] ? { ...c, amount: plan.left[i] } : c)).filter((c) => !(luckable(c) && c.amount === 0)), luck: plan.spent };
}

// One option's needs against the state. → null when unaffordable, else
// { choices: [...] } — what the person still has to decide:
//   { kind: 'split', amount, keys: [held basic keys] }   which Basic tokens
//   { kind: 'hp', minimum, maximum }                      how much HP (X)
//   { kind: 'holder', holders }                           whose Challenge
export function needsOf(option, state, answers = null) {
  const choices = [];
  const tokens = state.tokens ?? {};
  for (const c of payable(option, state, answers).comps) {
    if (c.kind === 'token') {
      if (c.token === 'basic') {
        const held = BASIC_KEYS.filter((k) => (tokens[k] ?? 0) > 0);
        const total = held.reduce((n, k) => n + tokens[k], 0);
        if (total < c.amount) return null;
        // A choice only when more than one way exists.
        if (held.length > 1 && total > c.amount) choices.push({ kind: 'split', amount: c.amount, keys: held });
      } else if ((tokens[c.token] ?? 0) < c.amount) return null;
    } else if (c.kind === 'hp') {
      if (typeof c.amount === 'object') {
        const maximum = Math.min(c.amount.maximum ?? 99, (state.hp ?? 0) - 0);
        if (maximum < (c.amount.minimum ?? 1)) return null;
        choices.push({ kind: 'hp', minimum: c.amount.minimum ?? 1, maximum });
      } else if ((state.hp ?? 0) < c.amount) return null;
    } else if (c.kind === 'shield') {
      const need = c.amount === 'all' ? (c.minimum ?? 1) : Math.max(c.amount, c.minimum ?? 0);
      if ((state.shield ?? 0) < need) return null;
    } else if (c.kind === 'challenge_token_on_enemy') {
      const holders = state.challengeHolders ?? [];
      if (!holders.length) return null;
      if (holders.length > 1) choices.push({ kind: 'holder', holders });
    }
  }
  return { choices };
}

// Every option you can afford: [{ index, option, label, choices }].
export function affordableOptions(action, state) {
  return tokenOptions(action)
    .map(({ index, option }) => {
      const n = needsOf(option, state);
      return n ? { index, option, label: optionLabel(option), choices: n.choices } : null;
    })
    .filter(Boolean);
}

export function optionLabel(option) {
  if (option.category === 'free' || !option.components.length) return 'Free';
  return option.components
    .map((c) => {
      if (c.kind === 'token') return `${c.amount} ${tokenName(c.token)} token${c.amount === 1 ? '' : 's'}`;
      if (c.kind === 'hp') return typeof c.amount === 'object' ? `${c.amount.minimum}–${c.amount.maximum} HP` : `${c.amount} HP`;
      if (c.kind === 'shield') return c.amount === 'all' ? 'your whole Shield' : `${c.amount} Shield`;
      return 'your Challenge token';
    })
    .join(' + ');
}

// The exact payment for an option and the person's answers
// ({ split: { key: n }, hp: n, holderId }). → { tokens, hp, shield, holderId,
// rating } or { error }. `rating` is what the payment counts as (its Gate).
export function planPayment(action, optionIndex, answers, state) {
  const option = action?.cost?.options?.[optionIndex];
  if (!option || !tokenOptions(action).some((o) => o.index === optionIndex)) return { error: 'no such cost' };
  if (!needsOf(option, state, answers)) return { error: 'not enough' };
  const out = { tokens: {}, hp: 0, shield: 0, holderId: null, rating: 0 };
  const tokens = state.tokens ?? {};
  const pay = payable(option, state, answers);
  if (pay.luck) out.tokens.luck = pay.luck;
  // A split answered for the printed cost no longer fits a cost Luck or Elder Style cut down.
  const changed = pay.comps.length !== option.components.length || pay.comps.some((c, i) => c !== option.components[i]);
  for (const c of pay.comps) {
    if (c.kind === 'token') {
      if (c.token === 'basic') {
        const held = BASIC_KEYS.filter((k) => (tokens[k] ?? 0) > 0);
        let split = answers?.split;
        if (split && changed && Object.values(split).reduce((n, v) => n + (Math.trunc(Number(v)) || 0), 0) !== c.amount) split = null;
        if (!split) {
          // No choice was needed: take them in order.
          split = {};
          let left = c.amount;
          for (const k of held) {
            const take = Math.min(left, tokens[k]);
            if (take) split[k] = take;
            left -= take;
          }
        }
        let sum = 0;
        for (const [k, n] of Object.entries(split)) {
          const v = Math.trunc(Number(n) || 0);
          if (!BASIC_KEYS.includes(k) || v < 0 || v > (tokens[k] ?? 0)) return { error: 'bad split' };
          if (v) out.tokens[k] = (out.tokens[k] ?? 0) + v;
          sum += v;
        }
        if (sum !== c.amount) return { error: `pick exactly ${c.amount}` };
      } else out.tokens[c.token] = (out.tokens[c.token] ?? 0) + c.amount;
    } else if (c.kind === 'hp') {
      if (typeof c.amount === 'object') {
        const v = Math.trunc(Number(answers?.hp) || 0);
        if (v < (c.amount.minimum ?? 1) || v > Math.min(c.amount.maximum ?? 99, state.hp ?? 0)) return { error: 'bad HP amount' };
        out.hp += v;
      } else out.hp += c.amount;
    } else if (c.kind === 'shield') {
      out.shield += c.amount === 'all' ? state.shield : c.amount;
    } else if (c.kind === 'challenge_token_on_enemy') {
      const holders = state.challengeHolders ?? [];
      const id = holders.length === 1 ? holders[0].id : Number(answers?.holderId);
      if (!holders.some((h) => h.id === id)) return { error: 'pick whose Challenge' };
      out.holderId = id;
    }
  }
  const r = option.rating;
  out.rating =
    typeof r === 'number' ? r : r?.ref === 'payment.destroyedShieldValue' ? out.shield : r && typeof r === 'object' && r.chosen ? out.hp : 0;
  return out;
}

// A payment in words, for the card and the chat.
export function paymentText(p) {
  const parts = Object.entries(p.tokens ?? {}).map(([k, n]) => `${n} ${tokenName(k)}`);
  if (p.hp) parts.push(`${p.hp} HP`);
  if (p.shield) parts.push(`${p.shield} Shield`);
  if (p.holderId != null) parts.push('Challenge');
  return parts.join(' + ') || 'Free';
}
