import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { socket } from '../socket.js';
import {
  cellAt,
  cellCenter,
  cellInside,
  cellRect,
  cellTaken,
  fitImage,
  gridLines,
  moveToken,
  normalizeGrid,
} from '../lib/combatGrid.js';
import { subscribeFighterDrag } from '../lib/combatDrag.js';
import { cropOf } from '../lib/imageCrop.js';
import CroppedImage from './CroppedImage.jsx';

// The Combat view (Panic at the Dojo, Phase 3): the Scene's Combat Background,
// fitted whole into the stage, its square grid, and every placed token.
//
// Replaces the stage while the Scene is in Combat mode (decided: map only — no
// figures, drawings or lane). Grid geometry is in the map image's own pixels
// (client/src/lib/combatGrid.js), so it lines up for every viewer.
//
// Tokens snap to cells. Dragging one onto another swaps them; dropping a new
// one from a palette (combatDrag.js) onto an occupied cell is refused. A click
// that isn't a drag calls `onSelect(token)` — the token panel hangs off it.

const DRAG_THRESHOLD = 5;
const HIGHLIGHT = 'rgba(250, 204, 21, 0.45)';

export default function CombatMap({
  scene,
  tokens,
  stageWidth,
  stageHeight,
  inset,
  role,
  characterId,
  onSelect,
  selectedTokenId = null,
}) {
  const rootRef = useRef(null);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const src = scene?.combat_image_url ?? null;
  useEffect(() => setNatural({ width: 0, height: 0 }), [src]);
  const imgRef = useRef(null);
  useEffect(() => {
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
  }, [src]);

  const grid = useMemo(() => normalizeGrid(scene?.grid ?? {}), [scene?.grid]);
  const insetLeft = inset?.left ?? 0;
  const insetRight = inset?.right ?? 0;
  const fit = useMemo(
    () => fitImage(stageWidth, stageHeight, natural.width, natural.height, { left: insetLeft, right: insetRight }),
    [stageWidth, stageHeight, natural.width, natural.height, insetLeft, insetRight]
  );
  const lines = useMemo(
    () => (natural.width ? gridLines(natural.width, natural.height, grid) : null),
    [natural.width, natural.height, grid]
  );

  // A move is shown where it landed straight away; the next stage update
  // (which carries the server's answer) clears it.
  const [pending, setPending] = useState(null); // [{ id, col, row }]
  useEffect(() => setPending(null), [tokens]);
  const placed = useMemo(() => {
    if (!pending) return tokens;
    const byId = new Map(pending.map((c) => [c.id, c]));
    return tokens.map((t) => (byId.has(t.id) ? { ...t, ...byId.get(t.id) } : t));
  }, [tokens, pending]);

  const ready = natural.width > 0 && fit.scale > 0;
  const toImage = (clientX, clientY) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { x: -1, y: -1 };
    return { x: (clientX - rect.left - fit.left) / fit.scale, y: (clientY - rect.top - fit.top) / fit.scale };
  };
  const cellUnder = (clientX, clientY) => {
    if (!ready) return null;
    const p = toImage(clientX, clientY);
    const c = cellAt(grid, p.x, p.y);
    return cellInside(natural.width, natural.height, grid, c.col, c.row) ? c : null;
  };
  const toStagePx = (x, y) => ({ x: fit.left + x * fit.scale, y: fit.top + y * fit.scale });

  const canDrag = (t) => role === 'gm' || (role === 'player' && t.character_id === characterId);

  // ---- moving a placed token
  const [drag, setDrag] = useState(null); // { id, pointerId, startX, startY, x, y, moved }
  const onTokenDown = (e, t) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!canDrag(t)) {
      onSelect?.(t);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: t.id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, moved: false });
  };
  const onTokenMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > DRAG_THRESHOLD;
    setDrag({ ...drag, x: e.clientX, y: e.clientY, moved });
  };
  const onTokenUp = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const token = placed.find((t) => t.id === drag.id);
    if (!drag.moved) {
      if (token) onSelect?.(token);
    } else {
      const cell = cellUnder(e.clientX, e.clientY);
      const changes = cell ? moveToken(placed, drag.id, cell.col, cell.row) : null;
      if (changes?.length) {
        setPending(changes);
        socket.emit('combat_token:move', { combatantId: drag.id, col: cell.col, row: cell.row });
      }
    }
    setDrag(null);
  };

  // ---- dropping a new token from a palette
  const [paletteDrag, setPaletteDrag] = useState(null); // { fighter, x, y }
  const latest = useRef({});
  latest.current = { cellUnder, placed };
  useEffect(
    () =>
      subscribeFighterDrag((ev) => {
        if (ev.type === 'move') setPaletteDrag({ fighter: ev.fighter, x: ev.x, y: ev.y });
        else {
          setPaletteDrag(null);
          if (ev.type !== 'drop') return;
          const cell = latest.current.cellUnder(ev.x, ev.y);
          if (!cell || cellTaken(latest.current.placed, cell.col, cell.row)) return;
          socket.emit('combat_token:place', {
            ownerType: ev.fighter.ownerType,
            ownerId: ev.fighter.ownerId,
            col: cell.col,
            row: cell.row,
          });
        }
      }),
    []
  );

  const dragging = drag?.moved ? drag : null;
  let hoverCell = null;
  let hoverOk = false;
  if (dragging) {
    hoverCell = cellUnder(dragging.x, dragging.y);
    hoverOk = Boolean(hoverCell);
  } else if (paletteDrag) {
    hoverCell = cellUnder(paletteDrag.x, paletteDrag.y);
    hoverOk = Boolean(hoverCell) && !cellTaken(placed, hoverCell.col, hoverCell.row);
  }
  const highlight = hoverCell && hoverOk ? cellRect(natural.width, natural.height, grid, hoverCell.col, hoverCell.row) : null;

  const tokenSize = grid.size * fit.scale * 0.88;
  const rootRect = rootRef.current?.getBoundingClientRect();

  return (
    <div
      ref={rootRef}
      className="absolute inset-0"
      style={{ zIndex: 1 }}
      onPointerMove={onTokenMove}
      onPointerUp={onTokenUp}
      onPointerCancel={() => setDrag(null)}
    >
      {src ? (
        <img
          ref={imgRef}
          src={src}
          alt=""
          aria-hidden
          draggable={false}
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          className="pointer-events-none absolute select-none"
          style={
            ready
              ? { left: fit.left, top: fit.top, width: fit.width, height: fit.height }
              : { visibility: 'hidden', left: 0, top: 0 }
          }
        />
      ) : (
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center font-display text-sm uppercase tracking-wide text-zinc-500">
          {role === 'gm' ? 'No Combat Background yet — add one in Map settings.' : 'The map is being prepared.'}
        </p>
      )}

      {ready && lines && (
        <svg
          className="pointer-events-none absolute"
          style={{ left: fit.left, top: fit.top }}
          width={fit.width}
          height={fit.height}
          viewBox={`0 0 ${natural.width} ${natural.height}`}
          aria-hidden
        >
          {highlight && (
            <rect x={highlight.x} y={highlight.y} width={highlight.width} height={highlight.height} fill={HIGHLIGHT} />
          )}
          <g opacity={grid.opacity}>
            {[
              ['black', 3],
              ['white', 1.2],
            ].map(([stroke, width]) => (
              <g key={stroke} stroke={stroke} strokeWidth={width} vectorEffect="non-scaling-stroke">
                {lines.xs.map((x) => (
                  <line key={`x${x}`} x1={x} x2={x} y1={lines.rect.y0} y2={lines.rect.y1} vectorEffect="non-scaling-stroke" />
                ))}
                {lines.ys.map((y) => (
                  <line key={`y${y}`} x1={lines.rect.x0} x2={lines.rect.x1} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
                ))}
              </g>
            ))}
          </g>
        </svg>
      )}

      {ready &&
        placed.map((t) => {
          const isDragged = dragging?.id === t.id;
          let center;
          if (isDragged && rootRect) center = { x: dragging.x - rootRect.left, y: dragging.y - rootRect.top };
          else {
            const c = cellCenter(grid, t.col, t.row);
            center = toStagePx(c.x, c.y);
          }
          return (
            <Token
              key={t.id}
              token={t}
              center={center}
              size={tokenSize}
              lifted={isDragged}
              selected={selectedTokenId === t.id}
              canEdit={canDrag(t)}
              onPointerDown={(e) => onTokenDown(e, t)}
            />
          );
        })}

      {paletteDrag && rootRect && (
        <Token
          token={{ name: paletteDrag.fighter.name, image_url: paletteDrag.fighter.image_url, crop: paletteDrag.fighter.crop }}
          center={{ x: paletteDrag.x - rootRect.left, y: paletteDrag.y - rootRect.top }}
          size={Math.max(36, tokenSize)}
          lifted
          ghost={!hoverOk}
        />
      )}
    </div>
  );
}

const cropFrom = (c) => (c ? cropOf({ crop_x: c.x, crop_y: c.y, crop_w: c.w, crop_h: c.h }) : null);

// A round combat token: the fighter's combat-token picture (or portrait), a
// light ring and a drop shadow. Lifted while dragged.
export function Token({ token, center, size, lifted = false, selected = false, ghost = false, canEdit = false, onPointerDown }) {
  return (
    <div
      className={`group absolute ${onPointerDown ? (canEdit ? (lifted ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer') : 'pointer-events-none'}`}
      style={{
        left: center.x - size / 2,
        top: center.y - size / 2,
        width: size,
        height: size,
        zIndex: lifted ? 30 : selected ? 20 : 10,
        opacity: ghost ? 0.45 : 1,
        transition: lifted ? 'none' : 'left 160ms ease-out, top 160ms ease-out',
        touchAction: 'none',
      }}
      title={token.name}
      data-combat-token={token.id}
      onPointerDown={onPointerDown}
    >
      <div
        className={`h-full w-full overflow-hidden rounded-full border-2 bg-zinc-800 ${
          selected ? 'border-yellow-400' : 'border-zinc-100/80'
        }`}
        style={{
          boxShadow: lifted ? '0 10px 18px rgba(0,0,0,0.7)' : '0 3px 6px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.8)',
          transform: lifted ? 'scale(1.08)' : undefined,
        }}
      >
        {token.image_url ? (
          <CroppedImage src={token.image_url} crop={cropFrom(token.crop)} alt={token.name} className="h-full w-full rounded-full" draggable={false} />
        ) : (
          <span className="flex h-full w-full items-center justify-center font-display text-lg font-bold uppercase text-zinc-300">
            {(token.name ?? '?').slice(0, 1)}
          </span>
        )}
      </div>
      {canEdit && !lifted && token.id != null && (
        <button
          type="button"
          title={`Remove ${token.name} from the map`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            socket.emit('combat_token:remove', { combatantId: token.id });
          }}
          className="hover-only-action absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/90 text-zinc-300 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
