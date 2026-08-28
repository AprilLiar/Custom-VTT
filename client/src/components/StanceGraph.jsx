import { iconFor } from '../lib/styleIcons.js';
import {
  LABEL_FONT_SIZE,
  NODE_R,
  labelPosition,
  nodePosition,
  viewBoxString,
} from '../lib/stanceGraphLayout.js';

// Vector rendering of the 7-style counter tournament, drawn to blend with the
// UI. Arrows point winner -> disadvantaged style. With an active stance, its
// two styles are highlighted: green edges = matchups you counter, red edges =
// matchups that counter you, indigo = an edge between your own two styles.
//
// The geometry lives in `stanceGraphLayout.js` — including why a label is not
// simply on its node's ray at a fixed radius, which is the fix for the labels
// overlapping the icons.

const EDGE_COLORS = {
  neutral: '#52525b',
  win: '#22c55e',
  loss: '#ef4444',
  internal: '#818cf8',
};

function Edge({ from, to, kind }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const sx = from.x + ux * (NODE_R + 3);
  const sy = from.y + uy * (NODE_R + 3);
  const ex = to.x - ux * (NODE_R + 9);
  const ey = to.y - uy * (NODE_R + 9);
  // slight consistent curve so opposite-direction edges don't overlap
  const mx = (sx + ex) / 2 - uy * 14;
  const my = (sy + ey) / 2 + ux * 14;
  const highlighted = kind !== 'neutral';
  return (
    <path
      d={`M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`}
      fill="none"
      stroke={EDGE_COLORS[kind]}
      strokeWidth={highlighted ? 2 : 1}
      opacity={highlighted ? 0.9 : 0.3}
      markerEnd={`url(#arrow-${kind})`}
    />
  );
}

// `onNodeClick`, when passed, turns every style node into a picker: clicking
// one calls onNodeClick(attr.id) instead of just displaying matchups (see
// StancesTab.jsx's Stance Creator, which highlights the same `activePair`
// prop as the pick-in-progress rather than an active stance). A node not
// already in the pair dims once two are picked, mirroring the old chip
// buttons' disabled state.
export default function StanceGraph({ attributes, counters, activePair, onNodeClick }) {
  const positions = new Map(
    attributes.map((attr, i) => [attr.id, nodePosition(i, attributes.length)])
  );
  const inPair = (id) => activePair?.includes(id) ?? false;
  const picking = Boolean(onNodeClick);
  const atCapacity = picking && (activePair?.length ?? 0) >= 2;

  const edgeKind = (row) => {
    if (!activePair) return 'neutral';
    const a = inPair(row.attacker_attribute_id);
    const d = inPair(row.defender_attribute_id);
    if (a && d) return 'internal';
    if (a) return 'win';
    if (d) return 'loss';
    return 'neutral';
  };

  return (
    <svg viewBox={viewBoxString(attributes)} className="mx-auto w-full max-w-md">
      <defs>
        {Object.entries(EDGE_COLORS).map(([kind, color]) => (
          <marker
            key={kind}
            id={`arrow-${kind}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
          </marker>
        ))}
      </defs>

      {counters.map((row) => (
        <Edge
          key={row.id}
          from={positions.get(row.attacker_attribute_id)}
          to={positions.get(row.defender_attribute_id)}
          kind={edgeKind(row)}
        />
      ))}

      {attributes.map((attr, i) => {
        const pos = positions.get(attr.id);
        const label = labelPosition(i, attributes.length, attr.name);
        const active = inPair(attr.id);
        const Icon = iconFor(attr.icon);
        const disabled = picking && atCapacity && !active;
        return (
          <g
            key={attr.id}
            onClick={picking ? () => onNodeClick(attr.id) : undefined}
            style={picking ? { cursor: disabled ? 'not-allowed' : 'pointer' } : undefined}
            opacity={disabled ? 0.4 : 1}
          >
            {picking && (
              <circle cx={pos.x} cy={pos.y} r={NODE_R + 12} fill="transparent" />
            )}
            <circle
              cx={pos.x}
              cy={pos.y}
              r={NODE_R}
              fill="#27272a"
              stroke={active ? '#818cf8' : '#52525b'}
              strokeWidth={active ? 3 : 1.5}
            />
            <Icon
              x={pos.x - 11}
              y={pos.y - 11}
              width={22}
              height={22}
              color={active ? '#c7d2fe' : '#a1a1aa'}
              strokeWidth={2}
            />
            <text
              x={label.x}
              y={label.y}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={active ? '#c7d2fe' : '#a1a1aa'}
              fontSize={LABEL_FONT_SIZE}
              fontWeight={active ? 700 : 500}
            >
              {attr.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
