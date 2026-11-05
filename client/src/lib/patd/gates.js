// An Action's rules text as its base effect and its Gates, for the sheet and
// the dice board. Pure. Two kinds of Gate:
//   dice — "3+: …"                          (a die's number, or what a cost counts as)
//   cost — "5 Iron: …", "4 Basic Tokens: …" (how many tokens / HP were paid)
//
// "Deal 1 damage. 3+: Deal 2 instead. 5+: Deal 3 instead."
//   → { base: 'Deal 1 damage.', gates: [{ threshold: '3+', n: 3, kind: 'dice', text: 'Deal 2 instead.' }, …] }
const GATE = /(?:^|\s)(?:(\d{1,2})\+|(\d{1,2})\s+([A-Z][A-Za-z]+(?:\s+[Tt]okens?)?))\s*:\s*/g;

export function splitGates(text) {
  const src = String(text ?? '');
  const marks = [...src.matchAll(GATE)];
  if (!marks.length) return { base: src.trim(), gates: [] };
  const base = src.slice(0, marks[0].index).trim();
  const gates = marks.map((m, i) => {
    const dice = m[1] != null;
    return {
      threshold: dice ? `${m[1]}+` : `${m[2]} ${m[3]}`,
      n: Number(dice ? m[1] : m[2]),
      kind: dice ? 'dice' : 'cost',
      text: src.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : src.length).trim(),
    };
  });
  return { base, gates };
}
