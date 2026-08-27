import { useMemo } from 'react';
import { TEXT_VISIBLE_ZOOM } from '../lib/boardViewport.js';
import { assignBends, edgeEnds, edgePath } from '../lib/relationshipGeometry.js';
import HaloText from './HaloText.jsx';

// The web: every relationship, drawn.
//
// **In world space, inside the board's transform** — not measured off the DOM
// like `MoveLinkOverlay` does. That component measures because its two anchors
// live in unrelated scrolling subtrees; here every anchor is a sibling at a
// position we already store, so an endpoint is arithmetic rather than a
// measurement. Measuring would add a per-frame loop and reintroduce drift
// during pan and zoom, for nothing.
//
// **Two surfaces, not one.** Retired relationships are a separate SVG that
// paints first, so anything at all may overlap them — that is what "moves to
// the backmost layer" means, and z-index inside one SVG cannot express it as
// simply. Live lines paint above them, and text paints above everything (see
// the label layer at the bottom).

const RETIRED_COLOR = '#8b8b93';

export default function RelationshipEdges({
  edges,
  nodesById,
  zoom,
  canEdit,
  selectedEdgeId,
  onEdgePointerDown,
  onEdgeDoubleClick,
  onEndPointerDown,
  registerPath,
  draft,
}) {
  const bends = useMemo(() => assignBends(edges), [edges]);

  const drawable = useMemo(
    () =>
      edges
        .map((edge) => {
          const ends = edgeEnds(edge, nodesById);
          if (!ends) return null;
          const geom = edgePath(ends.from, ends.to, bends.get(edge.id) ?? 0);
          return { edge, ends, ...geom };
        })
        .filter(Boolean),
    [edges, nodesById, bends]
  );

  const retired = drawable.filter((d) => d.edge.retired);
  const live = drawable.filter((d) => !d.edge.retired);
  const showText = zoom >= TEXT_VISIBLE_ZOOM;

  return (
    <>
      <Surface className="z-0">
        <Defs items={retired} retiredOnly />
        {retired.map((d) => (
          <EdgeLine
            key={d.edge.id}
            {...d}
            canEdit={canEdit}
            selected={selectedEdgeId === d.edge.id}
            onPointerDown={onEdgePointerDown}
            onDoubleClick={onEdgeDoubleClick}
            onEndPointerDown={onEndPointerDown}
            registerPath={registerPath}
          />
        ))}
      </Surface>

      <Surface className="z-[1]">
        <Defs items={live} />
        {live.map((d) => (
          <EdgeLine
            key={d.edge.id}
            {...d}
            canEdit={canEdit}
            selected={selectedEdgeId === d.edge.id}
            onPointerDown={onEdgePointerDown}
            onDoubleClick={onEdgeDoubleClick}
            onEndPointerDown={onEndPointerDown}
            registerPath={registerPath}
          />
        ))}
        {/* The line being drawn right now. Dashed and unattached, so it reads
            as a proposal rather than as a relationship that already exists. */}
        {draft && (
          <path
            d={edgePath(draft.from, draft.to, 0).d}
            fill="none"
            stroke="#e4e4e7"
            strokeOpacity="0.7"
            strokeWidth="2"
            strokeDasharray="6 5"
            strokeLinecap="round"
          />
        )}
      </Surface>

      {/* Labels last, so their halos blur the lines rather than the reverse. */}
      {showText &&
        drawable.map(({ edge, mid }) =>
          edge.label ? (
            <div
              key={`label-${edge.id}`}
              ref={(el) => registerPath?.(`label-${edge.id}`, el)}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
              style={{ left: mid.x, top: mid.y, zIndex: 3 }}
            >
              <HaloText
                className={`text-[12px] font-semibold ${edge.retired ? 'text-zinc-500' : 'text-zinc-100'}`}
              >
                {edge.label}
              </HaloText>
            </div>
          ) : null
        )}
    </>
  );
}

// **The surface has to be a real box, not a 1×1 with `overflow: visible`.**
//
// The first version was a 1×1 svg at the world origin trusting `overflow:
// visible` to let its paths escape. It does not: an outermost `<svg>` clips to
// its viewport regardless, so every relationship was drawn and then thrown
// away — three lines in the database and nothing on screen. Nothing failed and
// nothing logged; the DOM had the paths and the pixels did not.
//
// So the surface spans a large box centred on the world origin, with a viewBox
// that maps user units to world units 1:1. Boards live within a few thousand
// units of the origin in practice, and node coordinates are clamped server-side
// well inside this, so nothing real is ever outside it.
const SPAN = 60000;

function Surface({ className = '', children }) {
  return (
    <svg
      className={`absolute ${className}`}
      style={{ left: -SPAN, top: -SPAN, width: SPAN * 2, height: SPAN * 2 }}
      viewBox={`${-SPAN} ${-SPAN} ${SPAN * 2} ${SPAN * 2}`}
      // Without this the box swallows every click on the void behind it.
      pointerEvents="none"
    >
      {children}
    </svg>
  );
}

// One marker per colour actually in use. Ids carry the colour so two edges of
// the same colour share a marker and a third of another colour gets its own.
function Defs({ items, retiredOnly = false }) {
  const colors = useMemo(
    () => [...new Set(items.map((d) => (retiredOnly || d.edge.retired ? RETIRED_COLOR : d.edge.color)))],
    [items, retiredOnly]
  );
  return (
    <defs>
      {colors.map((color) => (
        <marker
          key={color}
          id={`rel-arrow-${slug(color)}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
        </marker>
      ))}
    </defs>
  );
}

const slug = (color) => String(color).replace(/[^a-zA-Z0-9]/g, '');

function EdgeLine({ edge, ends, d, canEdit, selected, onPointerDown, onDoubleClick, onEndPointerDown, registerPath }) {
  const color = edge.retired ? RETIRED_COLOR : edge.color;
  const marker = `url(#rel-arrow-${slug(color)})`;
  return (
    <g opacity={edge.retired ? 0.5 : 1}>
      {/* An invisible fat stroke under the visible one: a 2px line is nearly
          impossible to hit with a pointer, and this gives it a real target
          without making it look heavy. */}
      <path
        ref={(el) => registerPath?.(`hit-${edge.id}`, el)}
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth="16"
        style={{ pointerEvents: canEdit ? 'stroke' : 'none', cursor: 'pointer' }}
        data-edge-hit={edge.id}
        onPointerDown={(e) => onPointerDown?.(e, edge)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleClick?.(edge);
        }}
      />
      <path
        ref={(el) => registerPath?.(edge.id, el)}
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={selected ? 3.5 : 2}
        strokeLinecap="round"
        pointerEvents="none"
        markerStart={edge.arrow === 'from' ? marker : undefined}
        markerEnd={edge.arrow === 'to' ? marker : undefined}
      />
      {/* A loose end is a real, grabbable thing: it stays where the portrait
          was and can be dragged onto somebody else. Drawn as a ring so it does
          not read as an arrowhead. */}
      {canEdit && edge.from_node_id == null && (
        <LooseEnd point={ends.from} color={color} onPointerDown={(e) => onEndPointerDown?.(e, edge, 'from')} />
      )}
      {canEdit && edge.to_node_id == null && (
        <LooseEnd point={ends.to} color={color} onPointerDown={(e) => onEndPointerDown?.(e, edge, 'to')} />
      )}
    </g>
  );
}

function LooseEnd({ point, color, onPointerDown }) {
  return (
    <g style={{ cursor: 'grab', pointerEvents: 'auto' }} onPointerDown={onPointerDown}>
      <circle cx={point.x} cy={point.y} r="11" fill="transparent" />
      <circle cx={point.x} cy={point.y} r="5" fill="#15171b" stroke={color} strokeWidth="2" />
    </g>
  );
}
