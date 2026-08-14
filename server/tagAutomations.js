// Tag automations — the first Tags in the game that DO something rather than
// describe something.
//
// Tags started as pure annotation: a world-level name + description the GM
// hangs on a Move, shown as a chip with a tooltip. This module is where a Tag
// stops being decoration and starts being a rule, and it is deliberately
// shaped like `PERK_HOOKS` in perkAutomations.js — a small registry keyed by
// the Tag's **exact name**, holding hand-written behaviour per Tag, rather
// than a generic automation system that tries to anticipate every effect
// anybody might want. That generic approach was already tried once for Perks
// and removed (see vttprojectplan.md's Perks & Tags section); the lesson
// carries over.
//
// **Keyed by name, matched case-insensitively, never by id.** The GM owns the
// tag list: ids differ between databases, a world may already have its own
// "Block" tag, and the GM can rename or re-create one at any time. Matching
// on the name is what keeps a mechanic attached to the thing the table thinks
// it is attached to.

export const BLOCK_TAG = 'Block';
export const NO_DAMAGE_TAG = 'No Damage';

// One entry per Tag that carries mechanics. See resolveBlockStamina and
// resolveNoDamageOutcome in combatDamage.js for the arithmetic behind each,
// and vttprojectplan.md's Block Stamina / No Damage Tag rules for the design.
export const TAG_HOOKS = {
  [BLOCK_TAG]: {
    // The move has no up-front Stamina Cost. writeMove forces stamina_cost
    // to 0 so it can't be authored, and combat:declare's affordability check
    // therefore never blocks declaring one.
    noStaminaCost: true,
    // It spends Stamina at resolution instead, proportional to how much of
    // the attack its guard actually absorbed.
    staminaFromAbsorbed: true,
    // Which authoring field replaces Stamina Cost on the Move Creator.
    staminaField: 'stamina_modifier',
  },
  [NO_DAMAGE_TAG]: {
    // The move never deals damage — it does not reach applyAutoDamage at all,
    // and it never triggers an Interruption check, because Interruption is
    // gated on damage having actually been dealt.
    suppressesDamage: true,
    // What it does instead: compare the roll against the move's own Success
    // Threshold. Success fires On Hit — it connected, which is the same
    // reasoning that makes Insignificant Damage fire On Hit rather than On
    // Miss. Failure fires nothing (see resolveNoDamage in roundResolution.js).
    usesSuccessThreshold: true,
    // Which authoring field the Move Creator reveals for it.
    thresholdField: 'success_threshold',
  },
};

const norm = (name) => String(name ?? '').trim().toLowerCase();

// Does this set of tag names include `tagName`? Case-insensitive, whitespace
// tolerant — a GM typing "block " must not silently lose the mechanic.
export function hasTagNamed(tagNames, tagName) {
  const wanted = norm(tagName);
  return (tagNames ?? []).some((n) => norm(n) === wanted);
}

export const carriesBlockTag = (tagNames) => hasTagNamed(tagNames, BLOCK_TAG);
export const carriesNoDamageTag = (tagNames) => hasTagNamed(tagNames, NO_DAMAGE_TAG);

// A move's tag names as they apply **to one specific character**, not as the
// template stores them. Perks can add or remove a Tag on a move for a single
// character (character_move_tags, action 'add' | 'remove'), and the Moves tab
// already renders that resolved set — so a mechanic hanging off a Tag has to
// read the same resolved set, or a Perk that grants the Block Tag would show
// up in the UI and do nothing.
//
// Removals are applied after additions, so a Perk that removes a tag wins
// over one that adds it — matching the effective_tag_ids resolution in
// server/index.js, which this mirrors on names instead of ids.
export function effectiveTagNames({ moveTagNames = [], overrides = [] }) {
  const added = overrides.filter((o) => o.action === 'add').map((o) => o.tag_name);
  const removed = new Set(overrides.filter((o) => o.action === 'remove').map((o) => norm(o.tag_name)));
  const out = [];
  const seen = new Set();
  for (const name of [...moveTagNames, ...added]) {
    const key = norm(name);
    if (!key || seen.has(key) || removed.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
