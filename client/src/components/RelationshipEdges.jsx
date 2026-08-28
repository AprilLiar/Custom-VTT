import { useMemo } from 'react';
import { TEXT_VISIBLE_ZOOM } from '../lib/boardViewport.js';
import { edgeEnds, edgePath } from '../lib/relationshipGeometry.js';
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
// **The board's layer stack, stated once.** z-index inside a single SVG cannot
// express any of this, so each band is its own surface:
//
//   0  retired edges  — anything at all may overlap them; that is what
//                       "moves to the backmost layer" means
//   1  live edges
//   2  the portraits  (set in RelationshipNode)
//   3  end handles, and the line being drawn right now
//   4  text
//
// **The portraits sit above the lines, and that is load-bearing.** Every edge
// carries a transparent 16px-wide hit stroke, and it begins exactly at an
// anchor dot — so while the edges painted last, that invisible stroke covered
// the dot it was attached to. Measured with `elementFromPoint`: aiming at a
// connected node's dot returned the PATH, so the dot never lit up and pressing
// it grabbed the line instead of starting a new one. A line drawing over
// somebody's face was the visible half of the same mistake.
//
// The two handles of a SELECTED line then have to climb back above the
// portraits, or the dot they sit on would swallow them and re-aiming a line
// would become impossible — the gesture would start a new line every time.

const RETIRED_COLOR = '#8b8b93';

export default function RelationshipEdges({
  edges,
  nodesById,
  // Computed by the board rather than here: a bend drag needs the offset a line
  // currently has in order to start from it without a jump, and two independent
  // `assignBends` calls would be two chances to disagree about the same fan.
  bends,
  zoom,
  canEdit,
  selectedEdgeId,
  onEdgePointerDown,
  onEdgeDoubleClick,
  onEndPointerDown,
  registerPath,
  showRetired = true,
  draft,
}) {
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

  // Hidden entirely rather than dimmed further: the point of the toggle is a
  // board showing only what is currently true, and a fainter ghost is still
  // clutter.
  const retired = showRetired ? drawable.filter((d) => d.edge.retired) : [];
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
            registerPath={registerPath}
          />
        ))}
      </Surface>

      {/* Above the portraits: the handles that re-aim a line, and the line
          being drawn right now. Both are things you are aiming AT somebody, so
          both have to stay visible and grabbable over the face you are aiming
          at — which is exactly where they end up. */}
      <Surface className="z-[3]">
        {canEdit &&
          drawable.map(({ edge, ends }) => (
            <g key={`ends-${edge.id}`} opacity={edge.retired ? 0.5 : 1}>
              {/* **Both ends are grabbable, not just loose ones.** Clicking a
                  line selects it and puts a handle on each end; dragging one
                  re-anchors that end to another character or another dot, and
                  releasing it over empty space DISCONNECTS it — leaving the
                  line hanging exactly as it would if the character had been
                  deleted. One gesture covers re-aim and detach, because they
                  are the same act with different endings.
                  A loose end shows its handle permanently, selected or not: it
                  is already detached and has to be findable to be picked up. */}
              {(edge.from_node_id == null || selectedEdgeId === edge.id) && (
                <EndHandle
                  point={ends.from}
                  color={edge.retired ? RETIRED_COLOR : edge.color}
                  loose={edge.from_node_id == null}
                  onPointerDown={(e) => onEndPointerDown?.(e, edge, 'from')}
                />
              )}
              {(edge.to_node_id == null || selectedEdgeId === edge.id) && (
                <EndHandle
                  point={ends.to}
                  color={edge.retired ? RETIRED_COLOR : edge.color}
                  loose={edge.to_node_id == null}
                  onPointerDown={(e) => onEndPointerDown?.(e, edge, 'to')}
                />
              )}
            </g>
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
              style={{ left: mid.x, top: mid.y, zIndex: 4 }}
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

function EdgeLine({ edge, ends, d, canEdit, selected, onPointerDown, onDoubleClick, registerPath }) {
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
        // `grab`, not `pointer`: pressing here and moving bends the line, and
        // the cursor is the only advertisement that gesture has.
        style={{ pointerEvents: canEdit ? 'stroke' : 'none', cursor: canEdit ? 'grab' : 'default' }}
        data-edge-hit={edge.id}
        // The two ends ride along because the bend drag needs the chord to
        // measure against, and this component already has them resolved.
        onPointerDown={(e) => onPointerDown?.(e, edge, ends)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleClick?.(edge, e);
        }}
      />
      <path
        ref={(el) => registerPath?.(edge.id, el)}
        d={d}
        // Draws itself in from its start. `pathLength="1"` normalises the dash
        // maths so one rule covers every length of line, and because the
        // element persists across re-renders the animation runs once — when the
        // line is first drawn, and when the board is first opened, where the
        // whole web assembling itself is the nicest moment the tab has.
        pathLength="1"
        className="rel-edge-draw"
        fill="none"
        stroke={color}
        strokeWidth={selected ? 3.5 : 2}
        strokeLinecap="round"
        pointerEvents="none"
        markerStart={edge.arrow === 'from' ? marker : undefined}
        markerEnd={edge.arrow === 'to' ? marker : undefined}
      />
    </g>
  );
}

// Drawn as a ring rather than a disc so it never reads as an arrowhead. A
// detached end is filled dark and hollow — visibly waiting for somewhere to go;
// an attached one is solid, because it is already somewhere.
function EndHandle({ point, color, loose, onPointerDown }) {
  return (
    <g
      style={{ cursor: 'grab', pointerEvents: 'auto' }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onPointerDown?.(e);
      }}
    >
      {/* A 5px ring is not a pointer target. This is. */}
      <circle cx={point.x} cy={point.y} r="12" fill="transparent" />
      <circle
        cx={point.x}
        cy={point.y}
        r="5.5"
        fill={loose ? '#15171b' : color}
        stroke={loose ? color : '#15171b'}
        strokeWidth="2"
      />
    </g>
  );
}
