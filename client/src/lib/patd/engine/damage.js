// **Damage Resolution, "WEPIA" (full automation, phase C — book p.69).**
// Pure: the server (server/triggers.js, `world.damage`) gathers the attacker's
// and the target's state and modifiers, asks people through `decide`, and
// applies what this returns (tokens spent, HP lost, Armor triggered).
//
// The book's order, for one hit:
//   1. base damage (an Action's own adjustments: Elder Style −1)
//   2. Weakness — the attacker discards 1: −2 (Armor Install: −1), minimum 0
//   3. weird effects — Heroic Style splits it; a Pit: −1 from beyond Range 3
//   4. Power — the attacker may spend 1 (more with Power Form, Ego, Giant,
//      Drive Install): +1 damage and Push 1 each
//   5. Iron — the target may spend up to 2 (Drive Install +1, Armor Install
//      caps their opponents at 1): −1 damage and −1 push/pull each; then
//      "spend 1 Iron to take 1 less from any source" (Iron Form) and the like
//   6. Shield — the target may block with it: absorbs 1-for-1, breaks when used up
//   7. Armor — if the damage is still 1+: −3 the first time this turn
//      (The Tank: −10), −2 the second, −1 after that; once per hit; temporary
//      Armor after all the rest, once, then it is lost
//   8. the rest comes off HP.
//
// Who can block what: Iron only against Actions and Abilities (not Burning,
// Fall or Traps); Shields only against Actions and Abilities that target you,
// and Burning damage; Armor against everything. Unblockable (book p.26)
// switches defences off: by Tokens, Armor, Shields, Abilities, or all of them.

import { listMod, sumMod, valueOf } from './modifiers.js';

export const DEFENSES = ['armor', 'shields', 'iron_tokens', 'control_tokens', 'tokens', 'abilities'];

// Unblockable lists (content values: 'armor', 'shields', 'iron_tokens',
// 'tokens', 'abilities', 'all') → the Set of defences that don't work.
export function unblockableSet(...lists) {
  const s = new Set();
  for (const l of lists) {
    for (const v of Array.isArray(l) ? l : l == null ? [] : [l]) {
      if (v === 'all') DEFENSES.forEach((d) => s.add(d));
      else if (typeof v === 'string') s.add(v === 'shield' ? 'shields' : v);
    }
  }
  if (s.has('tokens')) {
    s.add('iron_tokens');
    s.add('control_tokens');
  }
  return s;
}

// Damage sources. `kind`: 'action' | 'ability' | 'super' | 'trap' | 'fall' |
// 'burning' | 'other'. Attacks (dealt by someone, with an Action, Ability or
// Super Move) are the ones Weakness, Power, Iron and Shields work on.
const ATTACKS = new Set(['action', 'ability', 'super']);
export const isAttack = (kind) => ATTACKS.has(kind);
// What `damage.immunity` values match a source (Winged Style: fall; Phoenix:
// burning_tokens; Volcanic: traps; Vortex, Spirit: pits).
const IMMUNITY = { fall: ['fall'], burning: ['burning_tokens'], trap: ['traps'] };
export const immunityTags = (source) => [...(IMMUNITY[source.kind] ?? []), ...(source.tags ?? [])];
export const isImmune = (targetMods, source) => {
  const list = listMod(targetMods, 'damage.immunity');
  return immunityTags(source).some((t) => list.includes(t));
};

// How many Power tokens one hit can take: 1, plus "Enhance a Hit N additional
// times" (Power Form 2, Ego Freestyle 1, The Giant 1) and "1 more Power token
// per hit" (Drive Install).
export const powerAllowance = (attackerMods) =>
  1 + sumMod(attackerMods, 'enhance_hit.additional_uses') + sumMod(attackerMods, 'power_tokens.additional_per_hit');

// How many Iron tokens one hit can take (Reducing a Hit: 1 or 2; Drive
// Install: 1 more; an Armor Install attacker: only 1).
export const IRON_PER_HIT = 2;
export function ironAllowance(targetMods, attackerMods = []) {
  const own = IRON_PER_HIT + sumMod(targetMods, 'iron_tokens.additional_per_hit');
  const cap = valueOf(attackerMods, 'opponents.iron_token_limit_per_hit', null);
  return cap == null ? own : Math.max(0, Math.min(own, Number(cap) || 0));
}

// Step 1: an Action's damage values adjusted (Elder Style: −1, minimum 0).
export function baseDamage(amount, attackerMods, source) {
  let n = Math.max(0, Math.trunc(Number(amount) || 0));
  if (source.kind !== 'action') return n;
  for (const m of attackerMods.filter((x) => x.rule === 'action_damage.adjustment')) {
    const v = m.value ?? {};
    n = Math.max(Number(v.minimum) || 0, n + (Number(v.amount) || 0));
  }
  return n;
}

// Step 2: Weakness — only when hitting an enemy with an attack.
export function weaknessStep(amount, held, reduction = 2) {
  if (!(held > 0)) return { amount, spent: 0, reduced: 0 };
  const next = Math.max(0, amount - reduction);
  return { amount: next, spent: 1, reduced: amount - next };
}

// Step 3: a target standing in a Pit takes 1 less from attacks beyond Range 3.
export const pitStep = (amount, inPit, distance) => (inPit && distance != null && distance > 3 ? Math.max(0, amount - 1) : amount);

// Step 6: a Shield absorbs 1-for-1; used up, it breaks.
export function shieldStep(amount, value) {
  const s = Math.max(0, Math.trunc(Number(value) || 0));
  const absorbed = Math.min(s, amount);
  return { amount: amount - absorbed, absorbed, shield: s - absorbed, broke: s > 0 && absorbed === s && amount >= s };
}

// Step 7: Armor. `a`: { sources (permanent Armor this hit), temp (has
// temporary Armor), triggered (permanent triggers used this turn),
// firstReduction (3; The Tank 10), perTurn (triggers per source per turn: 1;
// Armor Install 2), keepOnOne (Armor Install: not spent when it blocks a
// 1-damage hit to zero) }.
export const armorReduction = (index, first = 3) => (index <= 0 ? first : index === 1 ? 2 : 1);
export function armorStep(amount, a) {
  const none = { amount, triggered: false, blocked: 0, usedTemp: false, spent: false };
  if (!(amount >= 1)) return none;
  const capacity = Math.max(0, a.sources ?? 0) * Math.max(1, a.perTurn ?? 1);
  const triggered = Math.max(0, a.triggered ?? 0);
  const usedTemp = triggered >= capacity;
  if (usedTemp && !a.temp) return none;
  const blocked = Math.min(amount, armorReduction(triggered, a.firstReduction ?? 3));
  const spent = !(a.keepOnOne && amount === 1);
  return { amount: amount - blocked, triggered: true, blocked, usedTemp, spent };
}

// How much Armor would block this hit (for Auto Iron: don't waste Iron on
// damage Armor takes anyway).
export const armorWouldBlock = (amount, a) => (a && !a.off ? armorStep(amount, a).blocked : 0);

// **One hit, start to finish.** `hit`:
//   { amount, source: { kind, tags },
//     attacker: { tokens, mods, enemy (of the target) } | null,
//     target: { tokens, mods, dizzy, inPit },
//     distance, unblockable: Set, allowIron, armor: armorStep's `a` | null,
//     exploitWeakness (spend the target's Weakness as Power) }
// `decide` (async, may be partial):
//   split(amount) → { keep, give: [{ to, amount }] } | null   (Heroic Style)
//   power({ max, amount }) → n
//   iron({ max, amount, armorBlocks }) → n
//   wouldTake(amount) → extra reduction (Iron Form's "1 less from any source")
//   shield({ value, amount, armorBlocks }) → boolean
// → { amount (lost from HP), immune, dizzy, steps: [text], spend: { weakness,
//     power, targetWeakness, iron, shield }, absorbed, broke, armor, power,
//     iron, split, pushBonus, pushResist }
export async function resolveDamage(hit, decide = {}) {
  const { source } = hit;
  const ub = hit.unblockable ?? new Set();
  const atk = hit.attacker;
  const tgt = hit.target;
  const attack = isAttack(source.kind);
  const out = {
    amount: 0,
    immune: false,
    dizzy: false,
    steps: [],
    spend: { weakness: 0, power: 0, targetWeakness: 0, iron: 0, shield: 0 },
    absorbed: 0,
    broke: false,
    armor: null,
    power: 0,
    iron: 0,
    reduced: 0,
    split: null,
    pushBonus: 0,
    pushResist: 0,
  };
  // Dizzy fighters can't take damage; immunity stops it whole (unless the
  // hit ignores the target's Abilities).
  if (tgt.dizzy) {
    out.dizzy = true;
    out.steps.push('Dizzy: no damage');
    return out;
  }
  if (!ub.has('abilities') && isImmune(tgt.mods ?? [], source)) {
    out.immune = true;
    out.steps.push('immune');
    return out;
  }
  // 1.
  let n = baseDamage(hit.amount, atk?.mods ?? [], source);
  // 2. Weakness: hitting an enemy with an attack.
  if (attack && atk?.enemy && (atk.tokens?.weakness ?? 0) > 0) {
    const w = weaknessStep(n, atk.tokens.weakness, Number(valueOf(atk.mods ?? [], 'weakness.damage_reduction', 2)));
    n = w.amount;
    out.spend.weakness = w.spent;
    if (w.spent) out.steps.push(`Weakness −${w.reduced}`);
  }
  // 3. Weird effects.
  if (attack) {
    const before = n;
    n = pitStep(n, tgt.inPit, hit.distance);
    if (n < before) out.steps.push('Pit −1');
  }
  if (attack && decide.split && n > 0) {
    const s = await decide.split(n);
    if (s && s.give?.length) {
      out.split = s;
      n = Math.max(0, s.keep);
      out.steps.push(`split: ${n} kept`);
    }
  }
  // 4. Power: the attacker enhances the hit.
  if (attack && atk) {
    const own = atk.tokens?.power ?? 0;
    const theirs = hit.exploitWeakness ? tgt.tokens?.weakness ?? 0 : 0;
    const max = Math.min(powerAllowance(atk.mods ?? []), own + theirs);
    if (max > 0 && decide.power) {
      const want = Math.max(0, Math.min(max, Math.trunc(Number(await decide.power({ max, amount: n })) || 0)));
      if (want > 0) {
        // Exploit Weakness: the target's Weakness first (it costs you nothing).
        out.spend.targetWeakness = Math.min(theirs, want);
        out.spend.power = want - out.spend.targetWeakness;
        out.power = want;
        out.pushBonus = want;
        n += want;
        out.steps.push(`Power +${want}`);
      }
    }
  }
  const armorOff = !hit.armor || ub.has('armor') || hit.armor.disabled;
  const armorBlocks = (x) => (armorOff ? 0 : armorWouldBlock(x, hit.armor));
  // 5. Iron: the target reduces the hit.
  if (attack && (!ub.has('iron_tokens') || hit.allowIron)) {
    const max = Math.min(ironAllowance(tgt.mods ?? [], atk?.mods ?? []), tgt.tokens?.iron ?? 0);
    if (max > 0 && n > 0 && decide.iron) {
      const want = Math.max(0, Math.min(max, n, Math.trunc(Number(await decide.iron({ max: Math.min(max, n), amount: n, armorBlocks: armorBlocks(n) })) || 0)));
      if (want > 0) {
        out.spend.iron = want;
        out.iron = want;
        out.pushResist = want;
        n -= want;
        out.steps.push(`Iron −${want}`);
      }
    }
  }
  // "Take 1 less damage from any source" (Iron Form, Mountainous Freestyle).
  // (Their rules ignore Unblockable — the content's `ignoresUnblockable`.)
  // Only offered when Armor won't take the whole hit anyway.
  // `decide.wouldTake(n, { ironLeft, armorBlocks })` → a number, or
  // { reduction, iron } when it spends Iron (Iron Form — native since the
  // fix: the Iron already spent on this hit is counted, never spent twice).
  if (n > 0 && decide.wouldTake && n > armorBlocks(n)) {
    const got = await decide.wouldTake(n, { ironLeft: Math.max(0, (tgt.tokens?.iron ?? 0) - out.spend.iron), armorBlocks: armorBlocks(n) });
    const r = Math.max(0, Math.trunc(Number(typeof got === 'object' && got ? got.reduction : got) || 0));
    const iron = Math.max(0, Math.trunc(Number(typeof got === 'object' && got ? got.iron : 0) || 0));
    if (r > 0) {
      out.reduced = Math.min(n, r);
      n -= out.reduced;
      out.spend.iron += iron;
      out.ironForm = iron;
      out.steps.push(iron ? `Iron Form −${out.reduced}` : `reduced −${out.reduced}`);
    }
  }
  // 6. Shield.
  const shieldable = attack || source.kind === 'burning';
  const shieldValue = tgt.tokens?.shield ?? 0;
  if (shieldable && n > 0 && shieldValue > 0 && !ub.has('shields') && !hit.shieldDisabled && decide.shield) {
    if (await decide.shield({ value: shieldValue, amount: n, armorBlocks: armorBlocks(n) })) {
      const s = shieldStep(n, shieldValue);
      out.absorbed = s.absorbed;
      out.broke = s.broke;
      out.spend.shield = s.absorbed;
      n = s.amount;
      out.steps.push(`Shield absorbs ${s.absorbed}${s.broke ? ' and breaks' : ''}`);
    }
  }
  // 7. Armor.
  if (!armorOff) {
    const a = armorStep(n, hit.armor);
    if (a.triggered) {
      out.armor = a;
      n = a.amount;
      out.steps.push(`${a.usedTemp ? 'temporary ' : ''}Armor −${a.blocked}`);
    }
  }
  out.amount = Math.max(0, n);
  return out;
}

// The Ask / Auto / Never settings (decided: on the sheet's Combat tab).
// Players default to Ask, NPCs to Auto.
export const SPEND_MODES = ['ask', 'auto', 'never'];
export const SPEND_KEYS = ['power', 'iron', 'shield'];
export function spendPrefs(prefs, isNpc) {
  const def = isNpc ? 'auto' : 'ask';
  const out = {};
  for (const k of SPEND_KEYS) out[k] = SPEND_MODES.includes(prefs?.[k]) ? prefs[k] : def;
  return out;
}
export function normalizePrefs(raw) {
  const out = {};
  for (const k of SPEND_KEYS) if (SPEND_MODES.includes(raw?.[k])) out[k] = raw[k];
  return out;
}

// What Auto spends: Power all it may; Iron only on damage Armor won't take
// anyway; the Shield always.
export const autoPower = ({ max }) => max;
export const autoIron = ({ max, amount, armorBlocks = 0 }) => Math.max(0, Math.min(max, amount - armorBlocks));
export const autoShield = () => true;
