// A character's build (decided — vttprojectplan.md, "Character builder & turn
// automation"): what the player chose, and everything the rules content
// derives from it. Pure — the server and the client share it, and it takes the
// content index (content.js `indexContent`) as an argument.
//
// **Nothing is locked (decided):** any character may take any hero or NPC
// type and any player or villain Archetype; the construction rules only
// produce warnings.
//
// A saved build (JSON, ids only):
//   {
//     type:       'hero-type.focused' | ... | 'character-type.warrior' | ...,
//     archetypes: [{ id, variant: 'focused' | 'fused' | 'frantic' }],
//     stances:    [{ formId, styleId, alias, constructChoice }]  (styleId may be a Freestyle)
//     forms:      [formId]    — Frantic only: known Forms
//     styles:     [styleId]   — Frantic only: known Styles
//     buildId, skills: { replaceFromId, replaceToId, custom },
//     level, xp, superMoveIds: [], warriorPathId, healthBars,
//     prefs:      { power?, iron?, shield?: 'ask' | 'auto' | 'never' }
//   }
import { normalizePrefs } from './engine/damage.js';

export const VARIANTS = ['focused', 'fused', 'frantic'];
export const LEVEL_MIN = 1;
export const LEVEL_MAX = 10;
export const MAX_STANCES = 12;
export const CUSTOM_SKILL_MAX = 40;
export const XP_LOG_MAX = 30;
// The book's fight awards: Victory 2, Defeat 1.
export const XP_AWARDS = { victory: 2, defeat: 1 };

// ------------------------------------------------------------------ types

// Hero and NPC types as one list: id, name, default ability variant, how many
// Stances, Archetypes and Health Bars it starts with, and its advancement track.
export function buildTypes(idx) {
  const c = idx.content;
  const heroes = c.heroTypes.map((h) => ({
    id: h.id,
    name: `${h.name} Hero`,
    kind: 'hero',
    variant: h.abilityVariant,
    stanceCount: h.stanceMode === 'assemble_each_turn' ? 0 : 3,
    assemble: h.stanceMode === 'assemble_each_turn',
    archetypeCount: h.archetypeCount,
    stylesPerArchetype: h.stylesPerArchetype,
    healthBars: 1,
    trackId: h.advancementTrackId,
    abilityIds: h.abilityIds ?? [],
  }));
  const npcs = c.characterTypes.map((t) => ({
    id: t.id,
    name: t.name,
    kind: 'npc',
    variant: t.archetypeAbilityVariant ?? 'fused',
    stanceCount: t.stanceCount ?? 1,
    assemble: false,
    archetypeCount: 1,
    stylesPerArchetype: null,
    healthBars: typeof t.healthBarCount === 'object' ? t.healthBarCount?.minimum ?? 1 : t.healthBarCount ?? 1,
    healthBarRange: typeof t.healthBarCount === 'object' ? t.healthBarCount : null,
    trackId: t.advancementTrackId ?? 'advancement-track.warrior',
    mustMatchStyleArchetype: Boolean(t.mustMatchStyleArchetype),
    abilityIds: [],
  }));
  return [...heroes, ...npcs];
}
export const typeOf = (idx, id) => buildTypes(idx).find((t) => t.id === id) ?? null;

// ------------------------------------------------------------------ helpers

const isKind = (idx, id, prefix) => typeof id === 'string' && id.startsWith(prefix) && idx.byId.has(id);
const isStyleLike = (idx, id) => isKind(idx, id, 'style.') || isKind(idx, id, 'freestyle.');
const uniq = (arr) => [...new Set(arr)];
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// "Halcyon Style" → "Halcyon"; "Chaotic Freestyle" → "Chaotic".
export const shortStyleName = (name) => String(name ?? '').replace(/\s+(Freestyle|Style)$/i, '');

export function emptyBuild(typeId = 'hero-type.focused') {
  return {
    type: typeId,
    archetypes: [],
    stances: [],
    forms: [],
    styles: [],
    buildId: null,
    skills: { replaceFromId: null, replaceToId: null, custom: '' },
    level: 1,
    xp: 0,
    // XP history, newest last: [{ at: ISO date, amount, reason }] (kept to XP_LOG_MAX).
    xpLog: [],
    superMoveIds: [],
    warriorPathId: null,
    healthBars: null,
    // Ask / Auto / Never for Power, Iron and Shield (full automation, phase C);
    // a key left out takes the default: players Ask, NPCs Auto.
    prefs: {},
  };
}

// A saved build, cleaned against the content: unknown ids dropped, numbers
// clamped, strings trimmed. Never throws.
export function normalizeBuild(raw, idx) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const types = buildTypes(idx);
  const type = types.find((t) => t.id === b.type) ?? types[0];
  const out = emptyBuild(type.id);
  const seenArch = new Set();
  for (const a of Array.isArray(b.archetypes) ? b.archetypes : []) {
    const id = typeof a === 'string' ? a : a?.id;
    if (!isKind(idx, id, 'archetype.') || seenArch.has(id)) continue;
    seenArch.add(id);
    out.archetypes.push({ id, variant: VARIANTS.includes(a?.variant) ? a.variant : type.variant });
  }
  for (const s of Array.isArray(b.stances) ? b.stances.slice(0, MAX_STANCES) : []) {
    const formId = isKind(idx, s?.formId, 'form.') ? s.formId : null;
    const styleId = isStyleLike(idx, s?.styleId) ? s.styleId : null;
    if (!formId && !styleId) continue;
    const form = formId ? idx.get(formId) : null;
    out.stances.push({
      formId,
      styleId,
      alias: form?.aliases?.includes(s?.alias) ? s.alias : form?.aliases?.[0] ?? null,
      constructChoice: typeof s?.constructChoice === 'string' ? s.constructChoice.slice(0, 40) : null,
    });
  }
  out.forms = uniq((Array.isArray(b.forms) ? b.forms : []).filter((id) => isKind(idx, id, 'form.'))).slice(0, MAX_STANCES);
  out.styles = uniq((Array.isArray(b.styles) ? b.styles : []).filter((id) => isStyleLike(idx, id))).slice(0, MAX_STANCES);
  out.buildId = isKind(idx, b.buildId, 'build.') ? b.buildId : null;
  const sk = b.skills ?? {};
  out.skills = {
    replaceFromId: isKind(idx, sk.replaceFromId, 'skill.') ? sk.replaceFromId : null,
    replaceToId: isKind(idx, sk.replaceToId, 'skill.') ? sk.replaceToId : null,
    custom: typeof sk.custom === 'string' ? sk.custom.trim().slice(0, CUSTOM_SKILL_MAX) : '',
  };
  out.level = clampInt(b.level, LEVEL_MIN, LEVEL_MAX, 1);
  out.xp = clampInt(b.xp, 0, 9999, 0);
  out.xpLog = (Array.isArray(b.xpLog) ? b.xpLog : [])
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      at: typeof e.at === 'string' ? e.at.slice(0, 30) : null,
      amount: clampInt(e.amount, -9999, 9999, 0),
      reason: typeof e.reason === 'string' ? e.reason.trim().slice(0, 80) : '',
    }))
    .slice(-XP_LOG_MAX);
  out.superMoveIds = uniq((Array.isArray(b.superMoveIds) ? b.superMoveIds : []).filter((id) => isKind(idx, id, 'super-move.'))).slice(0, 10);
  out.warriorPathId = isKind(idx, b.warriorPathId, 'warrior-path.') ? b.warriorPathId : null;
  out.healthBars = b.healthBars == null ? null : clampInt(b.healthBars, 1, 9, null);
  out.prefs = normalizePrefs(b.prefs);
  return out;
}

// A build with XP added (or taken away, never below 0) and the change logged.
export function withXp(build, amount, reason, at = new Date().toISOString()) {
  const xp = Math.max(0, Math.min(9999, (build.xp ?? 0) + amount));
  const real = xp - (build.xp ?? 0);
  if (!real) return build;
  return { ...build, xp, xpLog: [...(build.xpLog ?? []), { at, amount: real, reason }].slice(-XP_LOG_MAX) };
}

// ------------------------------------------------------------------ advancement

export function levelInfo(build, idx) {
  const type = typeOf(idx, build.type);
  const track = idx.get(type?.trackId) ?? idx.get('advancement-track.focused');
  const levels = track?.levels ?? [];
  const at = levels.find((l) => l.level === build.level) ?? levels[0];
  const next = levels.find((l) => l.level === build.level + 1) ?? null;
  // The level the XP has reached (heroes; the Warrior track has no XP).
  let xpLevel = null;
  if (levels.some((l) => typeof l.totalXp === 'number')) {
    xpLevel = 1;
    for (const l of levels) if (typeof l.totalXp === 'number' && build.xp >= l.totalXp) xpLevel = Math.max(xpLevel, l.level);
  }
  const grants = levels.filter((l) => l.level <= build.level).flatMap((l) => l.grants.map((g) => ({ ...g, level: l.level })));
  const count = (kind) => grants.filter((g) => g.kind === kind).reduce((n, g) => n + (g.count ?? 1), 0);
  return {
    track,
    level: build.level,
    bonusDie: at?.bonusDie ?? null,
    bonusHpPerBar: at?.bonusHpPerBar ?? 0,
    nextXp: typeof next?.totalXp === 'number' ? next.totalXp : null,
    xpLevel,
    canLevelUp: xpLevel != null && xpLevel > build.level,
    grants,
    extra: {
      stances: count('stance'),
      archetypes: count('archetype'),
      superMoves: count('super_move'),
      forms: count('form'),
      styles: count('style'),
    },
    featureIds: grants.filter((g) => g.kind === 'feature').map((g) => g.featureId),
    upgrades: grants.filter((g) => g.kind === 'upgrade_archetype'),
  };
}

// ------------------------------------------------------------------ stances

// A Stance's dice: the Form's, or — with a Freestyle — the Form's purple dice
// plus the Freestyle's (import guide). Plus the level's bonus die.
export function stanceDice(form, style, bonusDie = null) {
  let dice = (form?.actionDice ?? []).map((d) => ({ ...d }));
  if (style?.id?.startsWith('freestyle.')) {
    dice = [...dice.filter((d) => d.color !== 'green'), ...(style.actionDice ?? []).map((d) => ({ ...d }))];
  }
  if (bonusDie?.sides) dice.push({ kind: 'die', sides: bonusDie.sides, bonus: true });
  return dice;
}

// The Form's "when you add this Form to a Style" rules (`stance.construct`):
// range modifiers, possibly a choice (stored per Stance as `constructChoice`).
export function constructRules(form, idx) {
  const out = [];
  for (const aid of form?.abilityIds ?? []) {
    const ab = idx.get(aid);
    for (const r of ab?.rules ?? []) if (r.events.includes('stance.construct')) out.push(r);
  }
  return out;
}

const rangeMods = (node, choice, mods) => {
  if (!node || typeof node !== 'object') return;
  if (node.op === 'modify_rule' && /^range\./.test(node.rule)) mods.push({ rule: node.rule, value: node.value });
  else if (node.op === 'sequence') for (const s of node.steps) rangeMods(s, choice, mods);
  else if (node.op === 'choose') {
    const opt = node.options.find((o) => o.id === choice) ?? node.options[0];
    rangeMods(opt?.effect, choice, mods);
  }
};

export function stanceRange(style, form, idx, constructChoice = null) {
  if (!style?.range) return null;
  let { minimum, maximum } = style.range;
  const mods = [];
  for (const r of constructRules(form, idx)) rangeMods(r.effect, constructChoice, mods);
  for (const m of mods) {
    if (m.rule === 'range.maximum_bonus') maximum += Number(m.value) || 0;
    else if (m.rule === 'range.minimum_set') minimum = Number(m.value) || 0;
    else if (m.rule === 'range.maximum_set') maximum = Number(m.value) || maximum;
    else if (m.rule === 'range.set' && m.value && typeof m.value === 'object') {
      minimum = m.value.minimum ?? minimum;
      maximum = m.value.maximum ?? maximum;
    }
  }
  return { minimum, maximum };
}

// The choice a Form's construct rule offers, if any: [{ id, label }].
export function constructChoices(form, idx) {
  for (const r of constructRules(form, idx)) {
    const node = r.effect?.op === 'choose' ? r.effect : null;
    if (node) {
      const ab = idx.get(r.id.split('.rule-')[0]);
      const bullets = String(ab?.rulesText ?? '')
        .split('•')
        .slice(1)
        .map((t) => t.trim().replace(/\.$/, ''));
      return node.options.map((o, i) => ({ id: o.id, label: bullets[i] ?? `Option ${i + 1}` }));
    }
  }
  return [];
}

// "Add d6 to your Action Dice" (Quickdraw, Lucky Style — phase G): the
// continuous `action_dice.additional` of the Stance's own Abilities, before
// the level's bonus die.
export function extraDice(abilityIds, idx) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.op === 'sequence') return (n.steps ?? []).forEach(walk);
    if (n.op === 'modify_rule' && n.rule === 'action_dice.additional' && (!n.target || n.target.ref === 'self')) {
      for (const d of Array.isArray(n.value) ? n.value : [n.value]) if (d?.kind === 'die' && d.sides > 0) out.push({ kind: 'die', sides: d.sides, extra: true });
    }
  };
  for (const id of abilityIds) for (const r of idx.get(id)?.rules ?? []) if (r.events.includes('continuous')) walk(r.effect);
  return out;
}
const withExtra = (dice, extra) => {
  if (!extra.length) return dice;
  const i = dice.findIndex((d) => d.bonus);
  return i < 0 ? [...dice, ...extra] : [...dice.slice(0, i), ...extra, ...dice.slice(i)];
};

export const stanceKey = (formId, styleId) => `${formId ?? 'none'}+${styleId ?? 'none'}`;

export function deriveStance(pair, idx, bonusDie = null) {
  const form = pair.formId ? idx.get(pair.formId) : null;
  const style = pair.styleId ? idx.get(pair.styleId) : null;
  const alias = pair.alias ?? form?.aliases?.[0] ?? '';
  const name = [shortStyleName(style?.name ?? '—'), alias || form?.name?.replace(/\s+Form$/, '') || '—', 'Stance'].join(' ');
  const abilityIds = [...(form?.abilityIds ?? []), ...(style?.abilityIds ?? [])];
  return {
    key: stanceKey(pair.formId, pair.styleId),
    name,
    formId: pair.formId,
    styleId: pair.styleId,
    isFreestyle: Boolean(style?.id?.startsWith('freestyle.')),
    alias,
    constructChoice: pair.constructChoice ?? null,
    dice: withExtra(stanceDice(form, style, bonusDie), extraDice(abilityIds, idx)),
    range: stanceRange(style, form, idx, pair.constructChoice),
    abilityIds,
    actionIds: [...(form?.actionIds ?? []), ...(style?.actionIds ?? [])],
  };
}

// ------------------------------------------------------------------ the whole derivation

export function deriveBuild(rawBuild, idx) {
  const build = normalizeBuild(rawBuild, idx);
  const type = typeOf(idx, build.type);
  const lv = levelInfo(build, idx);
  const stances = type.assemble ? [] : build.stances.map((s) => deriveStance(s, idx, lv.bonusDie));
  const formIds = uniq(type.assemble ? build.forms : build.stances.map((s) => s.formId).filter(Boolean));
  const styleIds = uniq(type.assemble ? build.styles : build.stances.map((s) => s.styleId).filter(Boolean));

  // Abilities always in effect: each Archetype's chosen variant, the Build,
  // the hero type's, granted Features and the Warrior's Path.
  const archetypes = build.archetypes.map((a) => {
    const arch = idx.get(a.id);
    return { ...a, name: arch?.name, kind: arch?.kind, abilityIds: [...(arch?.abilityVariants?.[a.variant] ?? []), ...(arch?.abilityIds ?? [])] };
  });
  const features = lv.featureIds.map((id) => idx.get(id)).filter(Boolean);
  const buildRow = build.buildId ? idx.get(build.buildId) : null;
  const path = build.warriorPathId ? idx.get(build.warriorPathId) : null;
  // A Frantic Hero's Frantic-variant Archetype abilities are not always on:
  // one of them is picked each turn with the Stance (builder phase 4). Fused
  // ones granted later by advancement stay constant.
  const franticAbilityIds = type.assemble
    ? uniq(archetypes.filter((a) => a.variant === 'frantic').flatMap((a) => idx.get(a.id)?.abilityVariants?.frantic ?? []))
    : [];
  const constantAbilityIds = uniq([
    ...archetypes.flatMap((a) => a.abilityIds).filter((id) => !franticAbilityIds.includes(id)),
    ...(buildRow?.abilityIds ?? []),
    ...(type.abilityIds ?? []),
    ...features.flatMap((f) => f.abilityIds ?? []),
    ...(path?.abilityIds ?? []),
  ]);
  const constantActionIds = uniq([
    ...idx.content.basicActionIds,
    ...archetypes.flatMap((a) => idx.get(a.id)?.actionIds ?? []),
    ...(buildRow?.actionIds ?? []),
    ...features.flatMap((f) => f.actionIds ?? []),
    ...(path?.actionIds ?? []),
  ]);

  // Option tokens (Chaos, Control, ...) whose owner the character has.
  const owned = new Set([...build.archetypes.map((a) => a.id), ...formIds, ...styleIds]);
  const tokens = uniq(idx.content.resourceMechanics.filter((r) => owned.has(r.ownerId)).map((r) => r.tokenKey));

  // Skills: one per Form, one replaced if chosen, plus the free two-word one.
  let skillIds = formIds.map((id) => idx.get(id)?.skillId).filter(Boolean);
  if (build.skills.replaceFromId && build.skills.replaceToId && skillIds.includes(build.skills.replaceFromId)) {
    skillIds = skillIds.map((s) => (s === build.skills.replaceFromId ? build.skills.replaceToId : s));
  }

  const out = {
    build,
    type,
    level: lv,
    archetypes,
    stances,
    formIds,
    styleIds,
    constantAbilityIds,
    franticAbilityIds,
    constantActionIds,
    superMoveIds: build.superMoveIds,
    tokens,
    skillIds: uniq(skillIds),
    customSkill: build.skills.custom,
    healthBars: build.healthBars ?? type.healthBars,
  };
  out.warnings = buildWarnings(out, idx);
  return out;
}

// ------------------------------------------------------------------ warnings (never blocking)

export function buildWarnings(d, idx) {
  const w = [];
  const { build, type, level } = d;
  const wantArch = (type.kind === 'hero' ? type.archetypeCount : 1) + level.extra.archetypes;
  if (build.archetypes.length !== wantArch)
    w.push(`${type.name}: expected ${wantArch} Archetype${wantArch === 1 ? '' : 's'} at level ${build.level}, has ${build.archetypes.length}.`);
  const archIds = new Set(build.archetypes.map((a) => a.id));
  const freestyles = d.styleIds.filter((id) => id.startsWith('freestyle.'));
  if (freestyles.length > 1) w.push('At most one Freestyle may be known.');
  for (const fid of freestyles) {
    const fs = idx.get(fid);
    for (const banned of fs?.bannedFormIds ?? []) if (d.formIds.includes(banned)) w.push(`${fs.name} bans ${idx.get(banned)?.name}.`);
  }
  if (type.assemble) {
    const wantForms = 3 + level.extra.forms;
    const wantStyles = 3 + level.extra.styles;
    if (build.forms.length !== wantForms) w.push(`Frantic: expected ${wantForms} Forms, has ${build.forms.length}.`);
    if (build.styles.length !== wantStyles) w.push(`Frantic: expected ${wantStyles} Styles, has ${build.styles.length}.`);
    const styleArchs = build.styles.map((id) => idx.get(id)?.archetypeId).filter(Boolean);
    if (new Set(styleArchs).size !== styleArchs.length) w.push('Frantic: each Style must come from a different Archetype.');
    for (const a of styleArchs) if (!archIds.has(a)) w.push(`Frantic: ${idx.get(a)?.name}'s Style without its Archetype.`);
  } else {
    const want = type.stanceCount + level.extra.stances;
    if (d.stances.length !== want) w.push(`${type.name}: expected ${want} Stance${want === 1 ? '' : 's'} at level ${build.level}, has ${d.stances.length}.`);
    const forms = build.stances.map((s) => s.formId).filter(Boolean);
    const styles = build.stances.map((s) => s.styleId).filter(Boolean);
    if (new Set(forms).size !== forms.length) w.push('Each Stance should use a different Form.');
    if (new Set(styles).size !== styles.length) w.push('Each Stance should use a different Style.');
    if (build.stances.some((s) => !s.formId || !s.styleId)) w.push('A Stance is missing its Form or Style.');
    for (const sid of styles) {
      const st = idx.get(sid);
      if (st?.archetypeId && !archIds.has(st.archetypeId)) w.push(`${st.name} belongs to ${idx.get(st.archetypeId)?.name}, which this character doesn't have.`);
    }
    if (type.id === 'hero-type.fused') {
      for (const a of build.archetypes) {
        if (!styles.some((sid) => idx.get(sid)?.archetypeId === a.id)) w.push(`Fused: no Style from ${idx.get(a.id)?.name}.`);
      }
    }
  }
  if (!build.buildId) w.push('No Build chosen.');
  if (d.superMoveIds.length !== level.extra.superMoves)
    w.push(`Expected ${level.extra.superMoves} Super Move${level.extra.superMoves === 1 ? '' : 's'} at level ${build.level}, has ${d.superMoveIds.length}.`);
  if (level.featureIds.includes('feature.improved-warrior') && !build.warriorPathId) w.push("Level 3 Warrior: choose a Warrior's Path.");
  if (build.skills.custom && build.skills.custom.split(/\s+/).filter(Boolean).length !== 2) w.push('The free Skill should be two words.');
  if (type.healthBarRange && (d.healthBars < type.healthBarRange.minimum || d.healthBars > type.healthBarRange.maximum))
    w.push(`${type.name}: ${type.healthBarRange.minimum}-${type.healthBarRange.maximum} Health Bars.`);
  return w;
}

// ------------------------------------------------------------------ fights

// **Armor from the build (decided, builder phase 2):** every unconditional
// continuous `grant_armor` rule is one Armor source — 'always' when it comes
// from something always in effect (an Archetype, a Build, a Feature), or the
// Stance's key when it comes from that Stance's Form or Style. Conditional
// ones (Hidden Style in Fog, Inferno against Burning) stay rules text.
export function armorSourcesOf(derived, idx) {
  const grants = (abilityIds) => {
    let n = 0;
    for (const id of abilityIds) {
      for (const r of idx.get(id)?.rules ?? []) {
        if (!r.events.includes('continuous') || r.condition) continue;
        const e = r.effect;
        if (e?.op === 'grant_armor' && !e.temporary && !e.onlyDamageSource) n++;
      }
    }
    return n;
  };
  const out = [];
  for (let i = 0; i < grants(derived.constantAbilityIds); i++) out.push('always');
  for (const s of derived.stances) for (let i = 0; i < grants(s.abilityIds); i++) out.push(s.key);
  return out;
}

// Which level-bonus HP table a type uses (cinematicWeight.js): heroes the
// Hero table, NPC types the Warrior one.
// ------------------------------------------------------------------ Frantic: a Stance each turn

// The Stance a key names for this build: one of its own, or — for a Frantic
// Hero — any known Form with any known Style or Freestyle.
export function stanceOfBuild(derived, key, idx) {
  if (!derived || !key) return null;
  if (!derived.type.assemble) return derived.stances.find((s) => s.key === key && s.formId && s.styleId) ?? null;
  const [formId, styleId] = String(key).split('+');
  if (!derived.formIds.includes(formId) || !derived.styleIds.includes(styleId)) return null;
  return deriveStance({ formId, styleId }, idx, derived.level.bonusDie);
}

// What a Frantic Hero may pick this turn (Frantic Versatility): one Form, one
// Style and one Frantic Ability, none used on their previous turn. `last` is
// that turn's pick { formId, styleId, abilityId } or null. A part with nothing
// but last turn's left is offered anyway (marked used), so a turn can't stall.
export function franticOptions(derived, last, idx) {
  const part = (ids, lastId) => {
    const list = ids.map((id) => ({ id, name: idx.get(id)?.name ?? id, used: id === lastId }));
    return list.some((o) => !o.used) ? list : list.map((o) => ({ ...o, used: false }));
  };
  return {
    forms: part(derived.formIds, last?.formId),
    styles: part(derived.styleIds, last?.styleId),
    abilities: part(derived.franticAbilityIds, last?.abilityId),
  };
}

// Whether a pick is allowed by franticOptions.
export function franticPickAllowed(options, pick) {
  const ok = (list, id) => list.some((o) => o.id === id && !o.used);
  return ok(options.forms, pick.formId) && ok(options.styles, pick.styleId) && (options.abilities.length === 0 ? !pick.abilityId : ok(options.abilities, pick.abilityId));
}

export const hpTableOf = (derived) => (derived.type.kind === 'hero' ? 'hero' : 'warrior');
