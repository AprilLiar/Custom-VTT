import { useEffect, useMemo, useRef, useState } from 'react';
import { socket } from '../socket.js';
import { laneGeometry, laneLinesPath, moveOnLane, pointsAttr, slotAt } from '../lib/simpleLane.js';

// Simple Combat's overlay (Panic at the Dojo, Phase 2): one to three lanes of
// ten spaces in perspective (the GM's table setting) at 5/7 of the stage's
// height, glowing faintly in the
// backdrop's own most prominent colour, with every summoned fighter standing
// on it as a tabletop miniature.
//
// Sits ON TOP of the normal stage — decided: the full-size figures stay where
// they are and the miniatures stand on the lane in front of them. Positions
// are the server's (summon.lane_slot, packed from the left by packLane); this
// component only draws them and sends `lane:move` when a miniature is dropped.
// One fighter per space, snapped to the space's centre; dropping onto someone
// swaps the two.
//
// `onSelect(summon)` is called on a click that did not become a drag — the
// token panel hangs off it (Phase 4).

const DRAG_THRESHOLD = 5;
const HIGHLIGHT = 'rgba(250, 204, 21, 0.45)';

export default function SimpleCombatLane({
  summons,
  stageWidth,
  stageHeight,
  glow,
  role,
  characterId,
  onSelect,
  selectedSummonId = null,
  inset,
  lanes = 1,
}) {
  const rootRef = useRef(null);
  const insetLeft = inset?.left ?? 0;
  const insetRight = inset?.right ?? 0;
  const geometry = useMemo(
    () => laneGeometry(stageWidth, stageHeight, { left: insetLeft, right: insetRight }, lanes),
    [stageWidth, stageHeight, insetLeft, insetRight, lanes]
  );
  const [drag, setDrag] = useState(null); // { id, pointerId, startX, startY, x, y, moved }
  // A drop is shown where it landed straight away, rather than snapping back
  // until the server's stage:updated arrives. Cleared by that update.
  const [pending, setPending] = useState(null); // Map(summonId → slot|null)
  useEffect(() => setPending(null), [summons]);

  const placed = useMemo(() => {
    const packed = new Map(summons.map((s) => [s.id, s.lane_slot ?? null]));
    return pending ?? packed;
  }, [summons, pending]);

  const canDrag = (s) => role === 'gm' || (role === 'player' && s.character_id === characterId);

  const toStage = (e) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };

  // Below the lane by more than a figure's plinth, a GM's drop goes to the tray.
  const trayY = geometry.bottomY + Math.max(36, geometry.height);
  const dropTarget = (point) => {
    if (role === 'gm' && point.y > trayY) return { tray: true, slot: null };
    return { tray: false, slot: slotAt(geometry, point.x, point.y) };
  };

  const onPointerDown = (e, s) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!canDrag(s)) {
      onSelect?.(s);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toStage(e);
    setDrag({ id: s.id, pointerId: e.pointerId, startX: p.x, startY: p.y, x: p.x, y: p.y, moved: false });
  };
  const onPointerMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const p = toStage(e);
    const moved = drag.moved || Math.hypot(p.x - drag.startX, p.y - drag.startY) > DRAG_THRESHOLD;
    setDrag({ ...drag, x: p.x, y: p.y, moved });
  };
  const onPointerUp = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const summon = summons.find((s) => s.id === drag.id);
    if (!drag.moved) {
      // A click, not a drag — the panel opens; nothing moves.
      if (summon) onSelect?.(summon);
    } else {
      const { slot } = dropTarget(toStage(e));
      if (placed.get(drag.id) !== slot) {
        setPending(moveOnLane(placed, drag.id, slot));
        socket.emit('lane:move', { summonId: drag.id, slot });
      }
    }
    setDrag(null);
  };

  const dragging = drag?.moved ? drag : null;
  const target = dragging ? dropTarget({ x: dragging.x, y: dragging.y }) : null;
  const highlight = target && !target.tray ? geometry.segments[target.slot] : null;

  const onLane = summons.filter((s) => placed.get(s.id) != null);
  const inTray = summons.filter((s) => placed.get(s.id) == null);

  // A miniature's size follows its space: back lanes are narrower, so their
  // miniatures are smaller.
  const frontWidth = geometry.segments[0]?.width ?? 0;
  const miniFor = (scale = 1) => {
    const w = frontWidth * scale;
    return { width: w * 0.8, maxHeight: w * 2.6, plinthRx: w * 0.42 };
  };
  const mini = miniFor(1);

  // The line work as one path, drawn twice: a black outline under a glowing
  // white line.
  const linesPath = useMemo(() => laneLinesPath(geometry), [geometry]);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: 5 }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <svg className="absolute inset-0" width={stageWidth} height={stageHeight} aria-hidden>
        <defs>
          <filter id="lane-glow" x="-20%" y="-200%" width="140%" height="500%">
            <feGaussianBlur stdDeviation={Math.max(6, geometry.height * 0.35)} />
          </filter>
          <filter id="lane-line-glow" x="-5%" y="-50%" width="110%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* The backdrop-coloured glow under and around the lane. */}
        <polygon points={pointsAttr(geometry.outline)} fill={glow} opacity="0.85" filter="url(#lane-glow)" />
        <polygon points={pointsAttr(geometry.outline)} fill={glow} opacity="0.22" />
        {highlight && <polygon points={pointsAttr(highlight.points)} fill={HIGHLIGHT} />}
        <path d={linesPath} fill="none" stroke="black" strokeWidth="5" strokeLinejoin="round" opacity="0.9" />
        <path
          d={linesPath}
          fill="none"
          stroke="rgba(255,255,255,0.92)"
          strokeWidth="2"
          strokeLinejoin="round"
          filter="url(#lane-line-glow)"
        />
      </svg>

      {onLane.map((s) => {
        const seg = geometry.segments[placed.get(s.id)];
        if (!seg) return null;
        const isDragged = dragging?.id === s.id;
        const size = miniFor(isDragged ? 1 : seg.scale);
        return (
          <Miniature
            key={s.id}
            summon={s}
            x={isDragged ? dragging.x : seg.center.x}
            y={isDragged ? dragging.y + size.plinthRx * 0.3 : seg.center.y}
            size={size}
            // Nearer lanes stand in front of farther ones.
            layer={10 - seg.lane}
            lifted={isDragged}
            selected={selectedSummonId === s.id}
            draggable={canDrag(s)}
            onPointerDown={(e) => onPointerDown(e, s)}
          />
        );
      })}

      {/* Fighters who don't fit on the lane, or whom the GM set aside. */}
      {(inTray.length > 0 || (role === 'gm' && dragging)) && (
        <div
          className={`pointer-events-auto absolute flex -translate-x-1/2 items-center gap-2 panel-cut-sm border px-2 py-1 ${
            target?.tray ? 'border-yellow-400 bg-yellow-400/20' : 'border-zinc-700 bg-zinc-950/70'
          }`}
          style={{ left: (geometry.outline[2][0] + geometry.outline[3][0]) / 2, top: trayY + 4 }}
        >
          <span className="font-display text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            Waiting
          </span>
          {inTray.map((s) => (
            <button
              key={s.id}
              type="button"
              title={s.name}
              onPointerDown={(e) => onPointerDown(e, s)}
              className={`h-9 w-9 overflow-hidden rounded-full border border-zinc-600 bg-zinc-800 ${
                s.is_hidden ? 'opacity-50' : ''
              } ${dragging?.id === s.id ? 'opacity-30' : ''} ${canDrag(s) ? 'cursor-grab' : ''}`}
            >
              <img src={s.image_url} alt="" draggable={false} className="h-full w-full object-cover object-top" />
            </button>
          ))}
        </div>
      )}
      {dragging && placed.get(dragging.id) == null && (
        <Miniature
          summon={summons.find((s) => s.id === dragging.id)}
          x={dragging.x}
          y={dragging.y + mini.plinthRx * 0.3}
          size={mini}
          lifted
          draggable
        />
      )}
    </div>
  );
}

// One fighter as a tabletop miniature: their Scene Picture, a little smaller
// than a lane space, fading out at the bottom so the feet disperse rather than
// end on a hard edge, standing on a small round plinth. (x, y) is where the
// plinth's centre sits.
function Miniature({ summon, x, y, size, lifted = false, selected = false, draggable, onPointerDown, layer = 1 }) {
  if (!summon) return null;
  const rx = size.plinthRx;
  const ry = rx * 0.32;
  return (
    <div
      className={`pointer-events-auto absolute flex flex-col items-center ${
        draggable ? (lifted ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'
      }`}
      style={{
        left: x - size.width / 2,
        top: y - size.maxHeight,
        width: size.width,
        height: size.maxHeight + ry,
        transition: lifted ? 'none' : 'left 180ms ease-out, top 180ms ease-out',
        zIndex: lifted ? 30 : layer,
        opacity: summon.is_hidden ? 0.5 : 1,
        filter: lifted ? 'drop-shadow(0 10px 14px rgba(0,0,0,0.65))' : 'drop-shadow(0 4px 6px rgba(0,0,0,0.5))',
        touchAction: 'none',
      }}
      title={summon.name}
      data-lane-mini={summon.id}
      onPointerDown={onPointerDown}
    >
      {/* The plinth — a dark disc with a lit rim, seen at the lane's angle. */}
      <svg
        className="absolute left-1/2 -translate-x-1/2"
        style={{ bottom: 0 }}
        width={rx * 2 + 4}
        height={ry * 2 + 6}
        aria-hidden
      >
        <defs>
          <linearGradient id={`plinth-${summon.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3f3f46" />
            <stop offset="1" stopColor="#09090b" />
          </linearGradient>
        </defs>
        <ellipse cx={rx + 2} cy={ry + 4} rx={rx} ry={ry} fill="#09090b" />
        <ellipse
          cx={rx + 2}
          cy={ry + 2}
          rx={rx}
          ry={ry}
          fill={`url(#plinth-${summon.id})`}
          stroke={selected ? '#facc15' : 'rgba(255,255,255,0.35)'}
          strokeWidth={selected ? 2 : 1}
        />
      </svg>
      <img
        src={summon.image_url}
        alt={summon.name}
        draggable={false}
        className="relative mt-auto w-auto select-none object-contain"
        style={{
          maxWidth: size.width,
          maxHeight: size.maxHeight,
          marginBottom: ry * 0.9,
          WebkitMaskImage: 'linear-gradient(to bottom, #000 62%, transparent 100%)',
          maskImage: 'linear-gradient(to bottom, #000 62%, transparent 100%)',
        }}
      />
    </div>
  );
}
