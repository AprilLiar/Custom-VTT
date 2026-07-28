// "A", "A and B", "A, B and C" — a natural-language list, used wherever the
// Combat Arena names a side's characters instead of just "Left"/"Right".
export function joinNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
