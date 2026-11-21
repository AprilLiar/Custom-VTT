// **What a fighter stands on (play feedback):** a Trap, Deadly Trap, Pit Trap
// or Rubble under a token (the map) or a figure (a lane) is hidden by it, so
// the fighter wears a small badge naming it.
const HAZARDS = [
  ['deadly_trap', 'Deadly Trap', 'bg-red-700 text-red-50'],
  ['trap', 'Trap', 'bg-orange-600 text-orange-50'],
  ['pit_trap', 'Pit Trap', 'bg-violet-700 text-violet-50'],
  ['rubble', 'Rubble', 'bg-stone-600 text-stone-50'],
];

// The hazards on the squares `at` covers ({ col, row, size? }): [key, label, classes].
export function hazardsAt(tiles, at) {
  if (at?.col == null || at?.row == null) return [];
  const size = at.size ?? 1;
  const kinds = new Set(
    (tiles ?? [])
      .filter((x) => x.col >= at.col && x.col < at.col + size && x.row >= at.row && x.row < at.row + size)
      .flatMap((x) => x.kinds ?? [x.kind])
  );
  // A Deadly Trap is a Trap too: named once.
  if (kinds.has('deadly_trap')) kinds.delete('trap');
  return HAZARDS.filter(([k]) => kinds.has(k));
}

export function HazardBadges({ list, size, className = '' }) {
  if (!list?.length) return null;
  return (
    <div className={`pointer-events-none absolute left-1/2 z-10 flex -translate-x-1/2 gap-0.5 ${className}`} data-testid="token-underfoot">
      {list.map(([k, label, cls]) => (
        <span key={k} className={`whitespace-nowrap rounded-sm px-1 font-display font-bold uppercase leading-tight shadow ${cls}`} style={{ fontSize: Math.max(8, Math.round(size * 0.16)) }}>
          {label}
        </span>
      ))}
    </div>
  );
}
