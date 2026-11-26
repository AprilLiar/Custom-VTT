import { useRef, useState } from 'react';
import { socket } from '../socket.js';
import { BORDER_STYLE, useBorderTool } from '../lib/borderTool.js';
import { borderKey } from '../lib/patd/engine/borders.js';

// **Map borders on the Combat map (decided, new).** Everyone sees them: a
// thick red or purple line along a square's edge — solid when it blocks
// range, dashed when it doesn't. While the GM's Borders tool is on, this
// layer takes the pointer: a tap on an edge sets a border there with the
// tool's colour and range setting (a tap on one that already matches removes
// it), and a drag paints every edge it passes along. Rules:
// client/src/lib/patd/engine/borders.js.
//
// `edgePx(side, col, row)` → [[x1, y1], [x2, y2]] in this view's pixels;
// `edgeAt(clientX, clientY)` → { side, col, row } of the edge nearest the pointer | null;
// `cell` → the square's size in pixels (for the line's thickness).
export default function MapBorderLayer({ borders, edgePx, edgeAt, cell, width, height, zIndex = 5, editable = false }) {
  const tool = useBorderTool();
  const painting = editable && tool.on;
  const [hover, setHover] = useState(null);
  const stroke = useRef(null); // { pointerId, edges: Map(key → edge), first, startedOn }
  const [trail, setTrail] = useState([]);
  const byKey = new Map(borders.map((b) => [borderKey(b.side, b.col, b.row), b]));
  const thick = Math.max(3, Math.min(10, cell * 0.09));

  const line = (side, col, row, style, dashed, opacity = 1, extra = 0) => {
    const p = edgePx(side, col, row);
    if (!p) return null;
    const [[x1, y1], [x2, y2]] = p;
    const dash = dashed ? `${thick * 2.2} ${thick * 1.6}` : undefined;
    return (
      <g key={`${side}:${col},${row}`} opacity={opacity}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={style.glow} strokeWidth={thick * 2.4 + extra} strokeLinecap="butt" strokeDasharray={dash} />
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={style.stroke} strokeWidth={thick + extra} strokeLinecap="round" strokeDasharray={dash} />
      </g>
    );
  };

  const onDown = (e) => {
    if (!painting || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const edge = edgeAt(e.clientX, e.clientY);
    if (!edge) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const k = borderKey(edge.side, edge.col, edge.row);
    stroke.current = { pointerId: e.pointerId, edges: new Map([[k, edge]]), first: k };
    setTrail([edge]);
  };
  const onMove = (e) => {
    if (!painting) return;
    const edge = edgeAt(e.clientX, e.clientY);
    setHover(edge);
    const s = stroke.current;
    if (!s || e.pointerId !== s.pointerId || !edge) return;
    const k = borderKey(edge.side, edge.col, edge.row);
    if (s.edges.has(k)) return;
    s.edges.set(k, edge);
    setTrail([...s.edges.values()]);
  };
  const onUp = (e) => {
    const s = stroke.current;
    if (!s || e.pointerId !== s.pointerId) return;
    stroke.current = null;
    setTrail([]);
    const edges = [...s.edges.values()];
    const same = (b) => b && b.color === tool.color && b.blocksRange === tool.blocksRange;
    // A tap on a border that already matches the tool removes it.
    if (edges.length === 1 && same(byKey.get(s.first))) socket.emit('map_border:remove', { edges });
    else socket.emit('map_border:set', { edges, color: tool.color, blocksRange: tool.blocksRange });
  };

  const style = BORDER_STYLE[tool.color];
  return (
    <svg
      className="absolute left-0 top-0"
      width={width}
      height={height}
      style={{ zIndex: painting ? 40 : zIndex, pointerEvents: painting ? 'all' : 'none', cursor: painting ? 'crosshair' : undefined, touchAction: painting ? 'none' : undefined }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => {
        stroke.current = null;
        setTrail([]);
      }}
      onPointerLeave={() => setHover(null)}
      data-map-borders={borders.length}
    >
      {painting && <rect x={0} y={0} width={width} height={height} fill="rgba(0,0,0,0.001)" />}
      {borders.map((b) => line(b.side, b.col, b.row, BORDER_STYLE[b.color] ?? BORDER_STYLE.red, !b.blocksRange))}
      {painting && trail.map((t) => line(t.side, t.col, t.row, style, !tool.blocksRange, 0.75, 1))}
      {painting && hover && !trail.length && line(hover.side, hover.col, hover.row, style, !tool.blocksRange, 0.45)}
    </svg>
  );
}
