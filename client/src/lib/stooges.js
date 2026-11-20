// **Stooges (decided): one unit, many bodies.** Fight Setup and Start Combat
// show each Stooges unit as ONE row — "Goons · 6 bodies" — that stands for every
// body. `fighters`: [{ key, ref, combatantId, unit (the unit id or null),
// out (a destroyed body), name, … }] → the same list with each unit's bodies
// collapsed into its first standing body, carrying `bodies` (every body's
// ref) and `combatantIds`; one turn per round. Pure.
export function groupStooges(fighters) {
  const out = [];
  const byUnit = new Map();
  for (const f of fighters) {
    if (f.unit == null) {
      out.push({ ...f, bodies: [f.ref], combatantIds: f.combatantId != null ? [f.combatantId] : [] });
      continue;
    }
    if (f.out) continue;
    const g = byUnit.get(f.unit);
    if (g) {
      g.bodies.push(f.ref);
      if (f.combatantId != null) g.combatantIds.push(f.combatantId);
      g.count += 1;
      g.name = `${g.baseName} · ${g.count} bodies`;
      continue;
    }
    const entry = { ...f, key: `u${f.unit}`, baseName: f.name, count: 1, bodies: [f.ref], combatantIds: f.combatantId != null ? [f.combatantId] : [], turns: 1, stooges: true };
    byUnit.set(f.unit, entry);
    out.push(entry);
  }
  return out;
}
