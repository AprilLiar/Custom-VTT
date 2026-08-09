import { PHASE_BG, PHASE_LABEL } from '../lib/framePhaseColors.js';

// Frame data strip: adjoining squares — Startup amber, Active rose,
// Recovery blue. Renders exactly startup+active+recovery squares, in that
// order, 0-indexed across the whole sequence. `defensePositions` (0-based
// indices into that same sequence — see sanitizeDefensePositions in
// server/moveLogic.js) overrides individual squares to green: a Defense
// Frame is an annotation on top of whichever phase it lands in, not a 4th
// phase with its own tic budget, so the total square count never changes.
// `onToggle(index)` makes the bar itself the editor (Move Creator's frame
// preview) — click any square to flip its Defense tag; omit it for the
// read-only display used everywhere else.
//
// Colors come from framePhaseColors.js (Combat Automation overhaul §4.3) —
// this file used to hard-code its own yellow/red/blue/green, one of four
// near-duplicate copies of the same palette.
const SEGMENTS = [
  { key: 'startup', label: PHASE_LABEL.startup, className: PHASE_BG.startup },
  { key: 'active', label: PHASE_LABEL.active, className: PHASE_BG.active },
  { key: 'recovery', label: PHASE_LABEL.recovery, className: PHASE_BG.recovery },
];

export default function FrameBar({
  startup,
  active,
  recovery,
  defensePositions = [],
  onToggle,
  // Which squares `onToggle` will actually accept. Defense Frames are
  // Active-only now (decided), and a square that silently ignores a click
  // is worse than one that plainly isn't a button.
  canToggle = () => true,
  size = 'h-3.5 w-3.5',
}) {
  const counts = { startup, active, recovery };
  const defenseSet = new Set(defensePositions);
  const total = (startup ?? 0) + (active ?? 0) + (recovery ?? 0);
  let index = -1;
  return (
    <span
      className="inline-flex"
      title={`Startup ${startup} · Active ${active} · Recovery ${recovery}${
        defenseSet.size ? ` · Defense ${defenseSet.size}` : ''
      }`}
    >
      {SEGMENTS.flatMap(({ key, label, className }) =>
        Array.from({ length: counts[key] ?? 0 }, (_, i) => {
          index += 1;
          const squareIndex = index;
          const isDefense = squareIndex < total && defenseSet.has(squareIndex);
          const editable = Boolean(onToggle) && canToggle(squareIndex);
          const Tag = editable ? 'button' : 'span';
          return (
            <Tag
              key={`${key}-${i}`}
              type={editable ? 'button' : undefined}
              onClick={editable ? () => onToggle(squareIndex) : undefined}
              title={
                editable
                  ? `${label} ${i + 1} — click to toggle Defense`
                  : onToggle
                    ? `${label} ${i + 1} — only Active frames can be Defense Frames`
                    : undefined
              }
              className={`${size} ${isDefense ? PHASE_BG.defense : className} border border-zinc-900 first:rounded-l-sm last:rounded-r-sm ${
                editable ? 'cursor-pointer hover:opacity-75' : onToggle ? 'cursor-not-allowed opacity-60' : ''
              }`}
            />
          );
        })
      )}
    </span>
  );
}
