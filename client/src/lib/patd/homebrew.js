// **Homebrew content (vttprojectplan.md, "Homebrew builder").** The GM's own
// Forms, Styles and Archetypes, each with its Abilities and Actions, stored as
// one item per row (server/homebrew.js) and merged into the book's content so
// the builder, the fights and the turn triggers treat them like any other.
//
// Pure (only the token catalog), shared by the server (cleaning what is saved, merging for fights) and
// the client (the editor, merging for the builder).
//
// An item, as saved:
//   { id, kind, name, descriptionText, published,
//     // form:        aliases: [..], actionDice: [{ kind: 'die', sides, color } | { kind: 'fixed', value, color }], skillId
//     // style:       range: { minimum, maximum }, archetypeId
//     // archetype:   archetypeKind: 'player' | 'villain'
//     // freestyle:   range, actionDice (they replace the Form's green dice), bannedFormIds
//     // superMove:   ownerId (an Archetype), variant: 'alpha' | 'delta' | 'villain',
//     //              costMinimum, costCount (matching numbers) — its one Action is the move
//     // build:       unblockable (its Abilities can't be blocked)
//     // skill:       rulesText, formId (optional: the Form that teaches it)
//     // warriorPath: rulesText (Abilities: "when your Path triggers")
//     abilities: [{ name, rulesText, variant?, rules: [rule spec] }],
//     actions:   [{ name, cost, rulesText }] }
//
// A rule spec is what the simple rule editor writes:
//   { moment, optional, steps: [step] }   — compiled to the content's own rule
//   { raw: rule }                          — a book rule kept as is (Copy from book)
// A step: { kind, amount?, token?, who?, filter?, options? } (see STEP_KINDS).

import { BASIC_TOKENS, STATUS_TOKENS, UNIQUE_TOKENS } from '../panicTokens.js';

// **Every kind of content a character picks (decided, play feedback: "any
// content"):** the book's system structure (hero / character types, level
// tracks and their Features, the Basic Actions) stays the book's.
export const HB_KINDS = ['form', 'style', 'archetype', 'freestyle', 'superMove', 'build', 'skill', 'warriorPath'];
// The Skill picker's "Other" — a custom Skill written on the Form.
export const OTHER_SKILL = 'other';
// Tokens a step may give or name (Shield and Armor have their own steps).
export const HOMEBREW_TOKENS = [...BASIC_TOKENS, ...STATUS_TOKENS, ...UNIQUE_TOKENS];
export const HOMEBREW_TOKEN_KEYS = HOMEBREW_TOKENS.map((t) => t.key);
export const HB_PREFIX = {
  form: 'form.',
  style: 'style.',
  archetype: 'archetype.',
  freestyle: 'freestyle.',
  superMove: 'super-move.',
  build: 'build.',
  skill: 'skill.',
  warriorPath: 'warrior-path.',
};
// Kinds whose parts are only Abilities, only the one move, or nothing.
export const KIND_PARTS = {
  form: { abilities: true, actions: true },
  style: { abilities: true, actions: true },
  archetype: { abilities: true, actions: true },
  freestyle: { abilities: true, actions: true },
  superMove: { abilities: false, actions: false },
  build: { abilities: true, actions: true },
  skill: { abilities: false, actions: false },
  warriorPath: { abilities: true, actions: false },
};
export const SUPER_VARIANTS = ['alpha', 'delta', 'villain'];
// A Super Move's cost as the book writes it.
export const superCostText = (count = 2, minimum = 3) =>
  `${count === 2 ? 'Two' : count === 3 ? 'Three' : 'Four'} matching numbers${minimum > 1 ? `, each ${minimum} or higher` : ''}`;
export const DIE_SIDES = [4, 6, 8, 10, 12];
export const DIE_COLORS = ['purple', 'green'];
export const VARIANT_KEYS = ['focused', 'fused', 'frantic'];
const MAX_ABILITIES = 8;
const MAX_ACTIONS = 12;
const MAX_RULES = 6;
const MAX_STEPS = 8;
const MAX_RAW_RULE = 12000; // characters of JSON

// When a rule runs.
export const MOMENTS = [
  { id: 'own_turn.start', label: 'Start of your turn' },
  { id: 'own_turn.end_abilities', label: 'End of your turn' },
  { id: 'allied_turn.start', label: "Start of each ally's turn (and yours)" },
  { id: 'enemy_turn.start', label: "Start of each enemy's turn" },
  { id: 'any_turn.start', label: 'Start of every turn' },
  { id: 'self.bleed', label: 'When you Bleed' },
  { id: 'self.damage_taken', label: 'When you take damage (from a triggered effect)' },
  { id: 'self.challenge_given_to_enemy', label: 'After you Challenge an enemy (from a triggered effect)' },
  { id: 'warrior_path.trigger', label: "When your Warrior's Path triggers" },
  { id: 'text', label: 'Text only (shown as a "by hand" card)' },
];
const MOMENT_IDS = new Set(MOMENTS.map((m) => m.id));

// Who a step applies to.
export const WHO = [
  { id: 'self', label: 'you' },
  { id: 'ally', label: 'an ally in range (chosen)' },
  { id: 'enemy', label: 'an enemy in range (chosen)' },
  { id: 'all_allies', label: 'you and every ally in range' },
  { id: 'all_enemies', label: 'every enemy in range' },
];

// The effects the editor offers. `who` lists the targets each allows.
export const STEP_KINDS = [
  { id: 'gain_tokens', label: 'Gain tokens', who: ['self', 'ally', 'enemy', 'all_allies', 'all_enemies'], amount: true, token: true },
  { id: 'gain_shield', label: 'Gain a Shield', who: ['self', 'ally', 'all_allies'], amount: true },
  { id: 'heal', label: 'Heal', who: ['self', 'ally', 'all_allies'], amount: true, healValue: true },
  { id: 'damage', label: 'Deal damage', who: ['enemy', 'all_enemies'], amount: true },
  { id: 'pay_hp', label: 'Pay HP', who: ['self'], amount: true },
  { id: 'challenge', label: 'Challenge', who: ['enemy'] },
  { id: 'discard_tokens', label: 'Discard tokens', who: ['self', 'ally', 'enemy'], amount: true, filter: true },
  { id: 'temp_armor', label: 'Gain temporary Armor', who: ['self', 'ally'] },
  { id: 'add_pool', label: 'Add a number to the Action Pool', who: ['self'], amount: true },
  { id: 'notify', label: 'Text notification', who: [], text: true },
  { id: 'choose', label: 'Choose one of…', who: [] },
];
const STEP_BY_ID = Object.fromEntries(STEP_KINDS.map((s) => [s.id, s]));

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const text = (v, max) => String(v ?? '').replace(/\r/g, '').slice(0, max).trim();
const slug = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'item';

// ------------------------------------------------------------------ steps → op nodes

const RANGE = { mode: 'stance', origin: 'self' };
function targetOf(who) {
  switch (who) {
    case 'ally':
      return { kind: 'ally', excludeSelf: true, range: RANGE, count: 1 };
    case 'enemy':
      return { kind: 'enemy', range: RANGE, count: 1 };
    case 'all_allies':
      return { kind: 'self_and_allies', range: RANGE, count: 'all' };
    case 'all_enemies':
      return { kind: 'enemy', range: RANGE, count: 'all' };
    default:
      return { ref: 'self' };
  }
}

// A cleaned step (or null).
export function cleanStep(raw, tokenKeys, depth = 0) {
  const def = STEP_BY_ID[raw?.kind];
  if (!def) return null;
  if (def.id === 'choose') {
    if (depth > 0) return null;
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .slice(0, 4)
      .map((o) => cleanStep(o, tokenKeys, depth + 1))
      .filter(Boolean);
    return options.length >= 2 ? { kind: 'choose', options } : null;
  }
  const out = { kind: def.id, who: def.who.includes(raw.who) ? raw.who : def.who[0] };
  // A Text notification: what the chat card says (empty → the Ability's rules text).
  if (def.text) out.text = text(raw.text, 300);
  if (def.amount) out.amount = def.healValue && raw.amount === 'heal_value' ? 'heal_value' : clampInt(raw.amount, 1, 12, 1);
  if (def.token) out.token = tokenKeys.includes(raw.token) ? raw.token : tokenKeys[0];
  if (def.filter) out.filter = raw.filter === 'status' ? 'status' : 'any';
  return out;
}

export function compileStep(step) {
  const target = targetOf(step.who);
  const amount = step.amount === 'heal_value' ? { ref: 'context.healValue' } : step.amount;
  switch (step.kind) {
    case 'gain_tokens':
      return { op: 'gain_tokens', token: step.token, amount, target };
    case 'gain_shield':
      return { op: 'gain_shield', value: amount, target };
    case 'heal':
      return { op: 'heal', amount, target };
    case 'damage':
      return { op: 'damage', amount, target };
    case 'pay_hp':
      return { op: 'pay_hp', amount, target };
    case 'challenge':
      return { op: 'challenge', target };
    case 'discard_tokens':
      return { op: 'discard_tokens', amount, target, tokenFilter: step.filter };
    case 'temp_armor':
      return { op: 'grant_armor', temporary: true, target };
    case 'add_pool':
      return { op: 'add_pool_number', value: amount, target };
    case 'notify':
      return { op: 'notify', text: step.text ?? '' };
    case 'choose':
      return {
        op: 'choose',
        minimum: 1,
        maximum: 1,
        options: step.options.map((o, i) => ({ id: `option-${i + 1}`, effect: compileStep(o) })),
      };
    default:
      return null;
  }
}

// A rule spec → the content's rule (or null for a text-only rule).
export function compileRule(spec, ruleId) {
  if (spec.raw) return { ...spec.raw, id: ruleId };
  if (spec.moment === 'text' || !spec.steps.length) return null;
  const steps = spec.steps.map(compileStep).filter(Boolean);
  const body = steps.length === 1 ? steps[0] : { op: 'sequence', steps };
  return { events: [spec.moment], effect: spec.optional ? { op: 'optional', effect: body } : body, optional: Boolean(spec.optional), id: ruleId };
}

// A rule spec, cleaned.
function cleanRuleSpec(raw, tokenKeys) {
  if (raw?.raw && typeof raw.raw === 'object') {
    const r = raw.raw;
    const json = JSON.stringify(r);
    if (json.length > MAX_RAW_RULE || !Array.isArray(r.events) || !r.events.every((e) => typeof e === 'string') || !r.effect || typeof r.effect !== 'object') return null;
    const { id: _drop, ...rest } = JSON.parse(json);
    return { raw: rest };
  }
  const moment = MOMENT_IDS.has(raw?.moment) ? raw.moment : 'own_turn.start';
  const steps = moment === 'text' ? [] : (Array.isArray(raw?.steps) ? raw.steps : []).slice(0, MAX_STEPS).map((s) => cleanStep(s, tokenKeys)).filter(Boolean);
  return { moment, optional: Boolean(raw?.optional), steps };
}

// Best effort: a book rule as editor steps (so a copy stays editable), else raw.
export function specFromRule(rule) {
  const whoOf = (t) => {
    if (t?.ref === 'self') return 'self';
    if (t?.kind === 'enemy') return t.count === 'all' ? 'all_enemies' : 'enemy';
    if (t?.kind === 'ally') return 'ally';
    if (t?.kind === 'self_and_allies') return 'all_allies';
    return null;
  };
  const amt = (v) => (typeof v === 'number' ? v : v?.ref === 'context.healValue' ? 'heal_value' : null);
  const stepOf = (n) => {
    const who = whoOf(n.target);
    const map = { gain_tokens: 'gain_tokens', gain_shield: 'gain_shield', heal: 'heal', damage: 'damage', pay_hp: 'pay_hp', challenge: 'challenge', discard_tokens: 'discard_tokens', add_pool_number: 'add_pool' };
    if (n.op === 'grant_armor' && n.temporary && who) return { kind: 'temp_armor', who };
    if (n.op === 'notify') return { kind: 'notify', text: typeof n.text === 'string' ? n.text : '' };
    const kind = map[n.op];
    if (!kind || !who) return null;
    const s = { kind, who };
    if (kind !== 'challenge') {
      const a = amt(n.op === 'gain_shield' ? n.value : n.op === 'add_pool_number' ? n.value : n.amount);
      if (a == null) return null;
      s.amount = a;
    }
    if (kind === 'gain_tokens') {
      if (typeof n.token !== 'string') return null;
      s.token = n.token;
    }
    if (kind === 'discard_tokens') s.filter = n.tokenFilter === 'status' ? 'status' : 'any';
    return s;
  };
  const simple = rule.events?.length === 1 && MOMENT_IDS.has(rule.events[0]) && !rule.condition && !rule.limit;
  if (simple) {
    let effect = rule.effect;
    let optional = false;
    if (effect?.op === 'optional') {
      optional = true;
      effect = effect.effect;
    }
    const nodes = effect?.op === 'sequence' ? effect.steps : [effect];
    const steps = nodes.map((n) => (n ? stepOf(n) : null));
    if (steps.length && steps.every(Boolean)) return { moment: rule.events[0], optional, steps };
  }
  const { id: _drop, ...raw } = rule;
  return { raw };
}

// ------------------------------------------------------------------ items

// A saved item, cleaned against the content (`idx`: the book's index, used
// for Skills and Archetypes). `tokenKeys`: the token catalog's keys.
// Returns null when it is not a usable item.
export function cleanHomebrew(raw, idx, tokenKeys) {
  const kind = HB_KINDS.includes(raw?.kind) ? raw.kind : null;
  if (!kind) return null;
  const name = text(raw.name, 60);
  if (!name) return null;
  const item = { kind, name, descriptionText: text(raw.descriptionText, 4000), published: Boolean(raw.published) };
  const diceOf = (list) =>
    (Array.isArray(list) ? list : [])
      .slice(0, 6)
      .map((d) => {
        const color = DIE_COLORS.includes(d?.color) ? d.color : 'purple';
        if (d?.kind === 'fixed') return { kind: 'fixed', value: clampInt(d.value, 1, 12, 1), color };
        return { kind: 'die', sides: DIE_SIDES.includes(Number(d?.sides)) ? Number(d.sides) : 6, color };
      });
  const rangeOf = (r) => {
    const minimum = clampInt(r?.minimum, 0, 9, 1);
    return { minimum, maximum: clampInt(r?.maximum, minimum, 12, Math.max(minimum, 1)) };
  };
  if (kind === 'freestyle') {
    item.range = rangeOf(raw.range);
    item.actionDice = diceOf(raw.actionDice);
    item.bannedFormIds = (Array.isArray(raw.bannedFormIds) ? raw.bannedFormIds : []).filter((id) => typeof id === 'string' && /^form\.[a-z0-9.-]+$/.test(id)).slice(0, 12);
  }
  if (kind === 'superMove') {
    item.ownerId = typeof raw.ownerId === 'string' && /^archetype\.[a-z0-9.-]+$/.test(raw.ownerId) ? raw.ownerId : null;
    item.variant = SUPER_VARIANTS.includes(raw.variant) ? raw.variant : 'alpha';
    item.costCount = clampInt(raw.costCount, 2, 4, 2);
    item.costMinimum = clampInt(raw.costMinimum, 1, 12, 3);
  }
  if (kind === 'build') item.unblockable = raw.unblockable !== false;
  if (kind === 'skill' || kind === 'warriorPath') item.rulesText = text(raw.rulesText, 2000);
  if (kind === 'skill') item.formId = typeof raw.formId === 'string' && /^form\.[a-z0-9.-]+$/.test(raw.formId) ? raw.formId : null;
  if (kind === 'form') {
    item.aliases = (Array.isArray(raw.aliases) ? raw.aliases : [])
      .map((a) => text(a, 24))
      .filter(Boolean)
      .slice(0, 8);
    item.actionDice = (Array.isArray(raw.actionDice) ? raw.actionDice : [])
      .slice(0, 6)
      .map((d) => {
        const color = DIE_COLORS.includes(d?.color) ? d.color : 'purple';
        if (d?.kind === 'fixed') return { kind: 'fixed', value: clampInt(d.value, 1, 12, 1), color };
        return { kind: 'die', sides: DIE_SIDES.includes(Number(d?.sides)) ? Number(d.sides) : 6, color };
      });
    // A book Skill, or "Other": the GM's own Skill, written here.
    const custom = raw.skillId === OTHER_SKILL || (raw.skillId == null && raw.customSkill?.name);
    item.skillId = custom ? null : idx.get(raw.skillId)?.id?.startsWith('skill.') ? raw.skillId : null;
    item.customSkill = custom ? { name: text(raw.customSkill?.name, 40) || 'Custom Skill', rulesText: text(raw.customSkill?.rulesText, 1000) } : null;
  }
  if (kind === 'style') {
    item.range = rangeOf(raw.range);
    // Any Archetype, the book's or a homebrew one (checked when merging).
    item.archetypeId = typeof raw.archetypeId === 'string' && /^archetype\.[a-z0-9.-]+$/.test(raw.archetypeId) ? raw.archetypeId : null;
  }
  if (kind === 'archetype') item.archetypeKind = raw.archetypeKind === 'villain' ? 'villain' : 'player';
  // **Stable ids inside an item (decided, homebrew pipeline):** every Ability
  // and Action keeps its own `uid` across edits, renames and reorders — the
  // automation map is keyed by it. A missing or repeated one gets a new one.
  const seen = new Set();
  const uidOf = (u) => {
    const id = isUid(u) && !seen.has(u) ? u : newUid();
    seen.add(id);
    return id;
  };
  const parts = KIND_PARTS[kind];
  item.abilities = (parts.abilities && Array.isArray(raw.abilities) ? raw.abilities : [])
    .slice(0, MAX_ABILITIES)
    .map((a) => ({
      uid: uidOf(a?.uid),
      name: text(a?.name, 60) || name,
      rulesText: text(a?.rulesText, 2000),
      ...(kind === 'archetype' ? { variant: VARIANT_KEYS.includes(a?.variant) ? a.variant : null } : {}),
      rules: (Array.isArray(a?.rules) ? a.rules : [])
        .slice(0, MAX_RULES)
        .map((r) => cleanRuleSpec(r, tokenKeys))
        .filter(Boolean),
    }));
  item.actions = (parts.actions && Array.isArray(raw.actions) ? raw.actions : [])
    .slice(0, MAX_ACTIONS)
    .map((a) => ({ uid: uidOf(a?.uid), name: text(a?.name, 60), cost: text(a?.cost, 80), rulesText: text(a?.rulesText, 2000) }))
    .filter((a) => a.name);
  // **A Super Move is its one move** — kept as the item's only Action part, so
  // Claude's automation pass treats it like any Action (by its uid).
  if (kind === 'superMove') {
    const m = Array.isArray(raw.actions) ? raw.actions[0] : null;
    item.actions = [{ uid: uidOf(m?.uid), name, cost: superCostText(item.costCount, item.costMinimum), rulesText: text(m?.rulesText ?? raw.rulesText, 2000) }];
  }
  return item;
}

// An item with every Ability and Action given a uid (a missing or repeated one
// gets a new one): { item, changed }. Older saved items had none.
export function ensureUids(item, rand = Math.random) {
  const seen = new Set();
  let changed = false;
  const fix = (x) => {
    if (isUid(x?.uid) && !seen.has(x.uid)) {
      seen.add(x.uid);
      return x;
    }
    changed = true;
    let uid;
    do uid = newUid(rand);
    while (seen.has(uid));
    seen.add(uid);
    // eslint-disable-next-line no-unused-vars
    const { uid: _old, ...rest } = x ?? {};
    return { uid, ...rest };
  };
  const out = { ...item, abilities: (item.abilities ?? []).map(fix), actions: (item.actions ?? []).map(fix) };
  return { item: changed ? out : item, changed };
}

// A fresh in-item id for an Ability or Action: 8 base-36 characters.
export const newUid = (rand = Math.random) =>
  Array.from({ length: 8 }, () => Math.floor(rand() * 36).toString(36)).join('');
export const isUid = (u) => typeof u === 'string' && /^[a-z0-9]{6,16}$/.test(u);

// A fresh id for a new item: "form.hb-<name>-<random>".
export function newHomebrewId(kind, name, rand = Math.random) {
  return `${HB_PREFIX[kind]}hb-${slug(name)}-${Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')}`;
}
export const isHomebrewId = (id) => typeof id === 'string' && /^(form|style|archetype|freestyle|super-move|build|skill|warrior-path)\.hb-[a-z0-9-]+$/.test(id);
// The kind an id belongs to (by its prefix).
export const kindOfId = (id) => Object.entries(HB_PREFIX).find(([, p]) => typeof id === 'string' && id.startsWith(p))?.[0] ?? null;

// One item → its catalog entries: { entity, abilities, actions }.
// `auto`: this item's entries of the homebrew automation map
// (homebrew/automation.json, written by Claude's passes) — by in-item uid, an
// Ability's `rules` or an Action's `effect` (and structured `cost`). They run
// even when the wording changed since (decided: a grey wrench, not "by hand").
// What an Action's automation entry may set, besides a structured `cost`.
const ACTION_AUTO_KEYS = ['effect', 'gates', 'limits', 'conditions', 'timing', 'tags', 'usableWhileTakenOut'];

// The book's rules every Super Move shares (once a fight, not in Round 1, the
// side's limit…), taken from a book Super Move when one is at hand.
const SUPER_DEFAULTS = {
  conditions: [
    { operator: 'gt', args: [{ ref: 'context.round' }, 1] },
    { ref: 'context.superMovesAllowed' },
    { operator: 'lt', args: [{ ref: 'self.superMovesUsedThisFight' }, 1] },
    { operator: 'lt', args: [{ ref: 'side.superMovesUsedThisRound' }, { ref: 'context.superMoveLimitPerSide' }] },
  ],
  limits: [{ maximum: 1, period: 'fight', metric: 'uses', scope: 'all_super_moves_by_character' }],
  timing: 'when_an_action_can_be_performed',
  isAction: false,
  triggersAbilities: false,
  allowsTokenResponses: false,
  armorApplies: true,
};
const superCost = (item) => ({
  text: superCostText(item.costCount, item.costMinimum),
  selection: 'exactly_one',
  options: [{ id: 'option-1', category: 'super', components: [{ kind: 'pool_number', minimum: item.costMinimum, maximum: null, count: item.costCount, matching: true, consume: true }] }],
  additionalOptions: [],
});

export function itemToContent(item, auto = null, superTemplate = null) {
  const tail = item.id.slice(item.id.indexOf('.') + 1);
  const entryOf = (x) => (x?.uid ? auto?.entries?.[x.uid] : null) ?? null;
  const abilities = item.abilities.map((a, i) => {
    const id = `ability.${tail}.a${i + 1}`;
    const e = entryOf(a);
    const rules = Array.isArray(e?.rules)
      ? e.rules.map((r, j) => ({ ...r, id: `${id}.rule-${j + 1}` }))
      : a.rules.map((r, j) => compileRule(r, `${id}.rule-${j + 1}`)).filter(Boolean);
    return {
      id,
      name: a.name,
      ownerId: item.id,
      rulesText: a.rulesText,
      rules,
      automationState: Array.isArray(e?.rules) ? 'automated' : 'structured',
      uid: a.uid,
      homebrew: true,
      ...(a.variant ? { variant: a.variant } : {}),
    };
  });
  const actions = item.actions.map((a, i) => {
    const e = entryOf(a);
    return {
      id: `action.${tail}.x${i + 1}`,
      name: a.name,
      ownerId: item.id,
      kind: 'unique',
      cost: e?.cost ? { ...e.cost, text: a.cost } : { text: a.cost },
      rulesText: a.rulesText,
      ...Object.fromEntries(ACTION_AUTO_KEYS.filter((k) => e?.[k] !== undefined).map((k) => [k, e[k]])),
      ...(e?.effect ? { automationState: 'automated' } : {}),
      uid: a.uid,
      homebrew: true,
    };
  });
  const base = {
    id: item.id,
    name: item.name,
    descriptionText: item.descriptionText,
    homebrew: true,
    published: item.published,
    actionIds: actions.map((a) => a.id),
  };
  let entity;
  if (item.kind === 'superMove') {
    // The move itself: its one Action part's text, automation by its uid.
    const m = item.actions[0] ?? { rulesText: '' };
    const e = entryOf(m);
    const shared = Object.fromEntries(Object.keys(SUPER_DEFAULTS).map((k) => [k, superTemplate?.[k] ?? SUPER_DEFAULTS[k]]));
    entity = {
      id: item.id,
      name: item.name,
      ownerId: item.ownerId,
      variant: item.variant,
      rulesText: m.rulesText,
      descriptionText: item.descriptionText,
      ...shared,
      cost: e?.cost ? { ...e.cost, text: superCostText(item.costCount, item.costMinimum) } : superCost(item),
      ...Object.fromEntries(ACTION_AUTO_KEYS.filter((k) => e?.[k] !== undefined).map((k) => [k, e[k]])),
      automationState: e?.effect ? 'automated' : 'structured',
      uid: m.uid,
      homebrew: true,
      published: item.published,
    };
    return { entity, abilities: [], actions: [], skills: [] };
  }
  if (item.kind === 'skill') {
    entity = { id: item.id, name: item.name, rulesText: item.rulesText, formId: item.formId, descriptionText: item.descriptionText, homebrew: true, published: item.published };
    return { entity, abilities: [], actions: [], skills: [] };
  }
  const skills = item.customSkill ? [{ id: `skill.${tail}.s1`, name: item.customSkill.name, rulesText: item.customSkill.rulesText, homebrew: true }] : [];
  if (item.kind === 'form') {
    entity = { ...base, aliases: item.aliases, actionDice: item.actionDice, skillId: skills[0]?.id ?? item.skillId, abilityIds: abilities.map((a) => a.id) };
  } else if (item.kind === 'style') {
    entity = { ...base, range: item.range, archetypeId: item.archetypeId, abilityIds: abilities.map((a) => a.id) };
  } else if (item.kind === 'freestyle') {
    entity = {
      ...base,
      range: item.range,
      actionDice: item.actionDice,
      bannedFormIds: item.bannedFormIds,
      // (Like every book Freestyle: its dice replace the Form's green ones.)
      diceMode: 'replace_form_green_keep_form_purple',
      abilityIds: abilities.map((a) => a.id),
    };
  } else if (item.kind === 'build') {
    entity = { ...base, unblockable: item.unblockable, abilityIds: abilities.map((a) => a.id) };
  } else if (item.kind === 'warriorPath') {
    entity = { ...base, rulesText: item.rulesText, abilityIds: abilities.map((a) => a.id) };
  } else {
    const variants = Object.fromEntries(VARIANT_KEYS.map((v) => [v, abilities.filter((a) => a.variant === v).map((a) => a.id)]));
    entity = {
      ...base,
      kind: item.archetypeKind,
      abilityVariants: variants,
      abilityIds: abilities.filter((a) => !a.variant).map((a) => a.id),
      styleIds: [],
      superMoveIds: [],
    };
  }
  return { entity, abilities, actions, skills };
}

// The book's content with homebrew items added. Published items (or all, with
// `listDrafts`) join the pickable lists; the rest are still indexed (under
// `homebrewUnlisted`) so a character already using one keeps it.
export function mergeHomebrew(content, items, { listDrafts = true, automation = null } = {}) {
  if (!items?.length) return content;
  const out = { ...content };
  for (const key of ['forms', 'styles', 'archetypes', 'abilities', 'actions', 'skills', 'freestyles', 'superMoves', 'builds', 'warriorPaths']) out[key] = [...(content[key] ?? [])];
  out.homebrewUnlisted = [];
  const archetypes = new Map(out.archetypes.map((a, i) => [a.id, i]));
  const superTemplate = (content.superMoves ?? []).find((m) => m.conditions && m.limits) ?? null;
  const contents = items.map((it) => itemToContent(it, automation?.items?.[it.id] ?? null, superTemplate));
  // Where each newer kind is listed.
  const LISTS = { 'freestyle.': 'freestyles', 'super-move.': 'superMoves', 'build.': 'builds', 'skill.': 'skills', 'warrior-path.': 'warriorPaths' };
  // Archetypes first, so homebrew Styles can join them.
  for (const c of contents) {
    if (c.entity.id.startsWith('archetype.')) {
      (c.entity.published || listDrafts ? out.archetypes : out.homebrewUnlisted).push(c.entity);
      if (c.entity.published || listDrafts) archetypes.set(c.entity.id, out.archetypes.length - 1);
    }
  }
  for (const c of contents) {
    const listed = c.entity.published || listDrafts;
    if (c.entity.id.startsWith('form.')) (listed ? out.forms : out.homebrewUnlisted).push(c.entity);
    if (c.entity.id.startsWith('style.')) {
      (listed ? out.styles : out.homebrewUnlisted).push(c.entity);
      const ai = listed ? archetypes.get(c.entity.archetypeId) : undefined;
      if (ai != null) out.archetypes[ai] = { ...out.archetypes[ai], styleIds: [...(out.archetypes[ai].styleIds ?? []), c.entity.id] };
    }
    const list = Object.entries(LISTS).find(([p]) => c.entity.id.startsWith(p))?.[1];
    if (list) {
      (listed ? out[list] : out.homebrewUnlisted).push(c.entity);
      // A Super Move joins its Archetype's list too.
      const ai = list === 'superMoves' && listed ? archetypes.get(c.entity.ownerId) : undefined;
      if (ai != null) out.archetypes[ai] = { ...out.archetypes[ai], superMoveIds: [...(out.archetypes[ai].superMoveIds ?? []), c.entity.id] };
    }
    out.abilities.push(...c.abilities);
    out.actions.push(...c.actions);
    out.skills.push(...c.skills);
  }
  return out;
}

// A book Form / Style / Archetype as a new homebrew item (Copy from book).
export function copyFromBook(entry, idx) {
  const kind = kindOfId(entry.id);
  if (!kind) return null;
  if (kind === 'superMove') {
    const opt = entry.cost?.options?.[0]?.components?.[0];
    return {
      kind,
      name: `${entry.name} (copy)`,
      descriptionText: entry.descriptionText ?? '',
      published: false,
      ownerId: entry.ownerId ?? null,
      variant: SUPER_VARIANTS.includes(entry.variant) ? entry.variant : 'alpha',
      costCount: opt?.count ?? 2,
      costMinimum: opt?.minimum ?? 3,
      abilities: [],
      actions: [{ uid: newUid(), name: entry.name, cost: '', rulesText: entry.rulesText ?? '' }],
    };
  }
  if (kind === 'skill') return { kind, name: `${entry.name} (copy)`, descriptionText: '', published: false, rulesText: entry.rulesText ?? '', formId: entry.formId ?? null, abilities: [], actions: [] };
  const abilityOf = (id, variant = null) => {
    const a = idx.get(id);
    if (!a) return null;
    return { uid: newUid(), name: a.name, rulesText: a.rulesText ?? '', ...(kind === 'archetype' ? { variant } : {}), rules: (a.rules ?? []).map(specFromRule) };
  };
  const abilities =
    kind === 'archetype'
      ? [
          ...VARIANT_KEYS.flatMap((v) => (entry.abilityVariants?.[v] ?? []).map((id) => abilityOf(id, v))),
          ...(entry.abilityIds ?? []).map((id) => abilityOf(id)),
        ]
      : (entry.abilityIds ?? []).map((id) => abilityOf(id));
  const actions = (entry.actionIds ?? [])
    .map((id) => idx.get(id))
    .filter(Boolean)
    .map((a) => ({ uid: newUid(), name: a.name, cost: a.cost?.text ?? (typeof a.cost === 'string' ? a.cost : ''), rulesText: a.rulesText ?? '' }));
  const item = {
    kind,
    name: `${entry.name} (copy)`,
    descriptionText: entry.descriptionText ?? '',
    published: false,
    abilities: abilities.filter(Boolean),
    actions,
  };
  if (kind === 'form') Object.assign(item, { aliases: [...(entry.aliases ?? [])], actionDice: (entry.actionDice ?? []).map((d) => ({ ...d })), skillId: entry.skillId ?? null, customSkill: null });
  if (kind === 'style') Object.assign(item, { range: { ...(entry.range ?? { minimum: 1, maximum: 1 }) }, archetypeId: entry.archetypeId ?? null });
  if (kind === 'archetype') item.archetypeKind = entry.kind === 'villain' ? 'villain' : 'player';
  if (kind === 'freestyle')
    Object.assign(item, { range: { ...(entry.range ?? { minimum: 1, maximum: 1 }) }, actionDice: (entry.actionDice ?? []).map((d) => ({ ...d })), bannedFormIds: [...(entry.bannedFormIds ?? [])] });
  if (kind === 'build') item.unblockable = entry.unblockable !== false;
  if (kind === 'warriorPath') {
    item.rulesText = entry.rulesText ?? '';
    item.actions = [];
  }
  return item;
}

// A plain-language line for a rule spec (the editor's preview).
export function describeSpec(spec, tokenName = (k) => k) {
  if (spec.raw) return 'A rule copied from the book (kept as is).';
  if (spec.moment === 'text') return 'Text only.';
  const whoText = (w) => WHO.find((x) => x.id === w)?.label ?? 'you';
  const one = (s) => {
    const n = s.amount === 'heal_value' ? 'the Heal Value' : s.amount;
    switch (s.kind) {
      case 'gain_tokens':
        return `${whoText(s.who)} gain${s.who === 'self' ? '' : 's'} ${n} ${tokenName(s.token)}`;
      case 'gain_shield':
        return `${whoText(s.who)} gain${s.who === 'self' ? '' : 's'} Shield ${n}`;
      case 'heal':
        return `${whoText(s.who)} heal${s.who === 'self' ? '' : 's'} ${n}`;
      case 'damage':
        return `deal ${n} damage to ${whoText(s.who)}`;
      case 'pay_hp':
        return `pay ${n} HP`;
      case 'challenge':
        return `Challenge ${whoText(s.who)}`;
      case 'discard_tokens':
        return `${whoText(s.who)} discard${s.who === 'self' ? '' : 's'} ${n} ${s.filter === 'status' ? 'Status ' : ''}token${n === 1 ? '' : 's'}`;
      case 'temp_armor':
        return `${whoText(s.who)} gain${s.who === 'self' ? '' : 's'} temporary Armor`;
      case 'add_pool':
        return `add a ${n} to your Action Pool`;
      case 'notify':
        return s.text ? `post "${s.text}" in the chat` : 'post the rules text in the chat';
      case 'choose':
        return `choose one: ${s.options.map(one).join(' -or- ')}`;
      default:
        return '';
    }
  };
  const when = MOMENTS.find((m) => m.id === spec.moment)?.label ?? '';
  const body = spec.steps.map(one).filter(Boolean).join(', then ');
  return body ? `${when}: ${spec.optional ? 'you may ' : ''}${body}.` : `${when}: (no effect yet)`;
}
