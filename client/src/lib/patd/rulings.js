// **The table's rulings on the book's content (vttprojectplan.md, "Rulings").**
// Small, named patches applied to the content when it is indexed, on the
// server and the client alike, so the content file stays the user's export.
//
// Each ruling: { id, abilityId, ruleId, patch(rule) → rule, note? } — the note
// is added to the Ability's rules text, so the sheet shows the ruling.

export const RULINGS = [
  {
    // Halcyon Style: "at the start of your turn, you may discard one token" —
    // ruled: only a Status token (Burning, Fatigue, Weakness), never a basic
    // one; skipped when none is held, otherwise a choice (or none).
    id: 'halcyon-status-only',
    abilityId: 'ability.style-halcyon.halcyon-style',
    ruleId: 'ability.style-halcyon.halcyon-style.rule-1',
    patch: (rule) => ({ ...rule, effect: { ...rule.effect, tokenFilter: 'status' } }),
    note: 'Table ruling: only a Status token (Burning, Fatigue, Weakness) may be discarded this way.',
  },
];

export function applyRulings(content) {
  const byAbility = new Map();
  for (const r of RULINGS) byAbility.set(r.abilityId, [...(byAbility.get(r.abilityId) ?? []), r]);
  return {
    ...content,
    abilities: content.abilities.map((a) => {
      const rs = byAbility.get(a.id);
      if (!rs) return a;
      const notes = rs.map((r) => r.note).filter(Boolean);
      return {
        ...a,
        rulesText: notes.length ? `${a.rulesText}\n${notes.join('\n')}` : a.rulesText,
        rules: a.rules.map((rule) => rs.filter((r) => r.ruleId === rule.id).reduce((acc, r) => r.patch(acc), rule)),
      };
    }),
  };
}
