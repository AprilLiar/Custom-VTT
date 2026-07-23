import { iconFor } from '../lib/styleIcons.js';

// Vector rendering of the 7-style counter tournament, drawn to blend with the
// UI. Arrows point winner -> disadvantaged style. With an active stance, its
// two styles are highlighted: green edges = matchups you counter, red edges =
// matchups that counter you, indigo = an edge between your own two styles.

const SIZE = 460;
const CENTER = SIZE / 2;
const RADIUS = 150;
const NODE_R = 22;

const polar = (i, n, radius) => {
  const angle = ((-90 + (i * 360) / n) * Math.PI) / 180;
  return {
    x: CENTER + radius * Math.cos(angle),
    y: CENTER + radius * Math.sin(angle),
  };
};

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

export default function StanceGraph({ attributes, counters, activePair }) {
  const positions = new Map(
    attributes.map((attr, i) => [attr.id, polar(i, attributes.length, RADIUS)])
  );
  const inPair = (id) => activePair?.includes(id) ?? false;

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
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="mx-auto w-full max-w-md">
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
        const label = polar(i, attributes.length, RADIUS + 44);
        const active = inPair(attr.id);
        const Icon = iconFor(attr.icon);
        return (
          <g key={attr.id}>
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
              fontSize="12"
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
