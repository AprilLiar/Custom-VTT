// An Action's rules text as its base effect and its Gates (book: "3+: …"),
// for the sheet's rules reference. Pure.
//
// "Deal 1 damage. 3+: Deal 2 instead. 5+: Deal 3 instead."
//   → { base: 'Deal 1 damage.', gates: [{ threshold: '3+', text: 'Deal 2 instead.' }, { threshold: '5+', … }] }
const GATE = /(?:^|\s)(\d{1,2}\+)\s*:\s*/g;

export function splitGates(text) {
  const src = String(text ?? '');
  const marks = [...src.matchAll(GATE)];
  if (!marks.length) return { base: src.trim(), gates: [] };
  const base = src.slice(0, marks[0].index).trim();
  const gates = marks.map((m, i) => ({
    threshold: m[1],
    text: src.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : src.length).trim(),
  }));
  return { base, gates };
}
