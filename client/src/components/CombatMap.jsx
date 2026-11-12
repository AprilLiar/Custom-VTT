import { useEffect, useMemo, useRef, useState } from 'react';
import CopyLayer from './CopyLayer.jsx';
import SquarePickLayer from './SquarePickLayer.jsx';
import ActiveRangeLayer from './ActiveRangeLayer.jsx';
import PickViewLayer from './PickViewLayer.jsx';
import { isChoosing, pickAt, useChoosing } from '../lib/squarePick.js';
import { Maximize2, Minus, Plus, X } from 'lucide-react';
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
import FighterOverlay, { ArmorRings, ChallengeLock } from './FighterOverlay.jsx';
import FighterFx from './fx/FighterFx.jsx';
import { armorRings } from '../lib/panicTokens.js';
import { MapTileLayer } from './MapTiles.jsx';
import { isTakenOut } from '../lib/hpBars.js';
import { useHandMove } from './HandMoveDialog.jsx';

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
const MAX_ZOOM = 5;
const MIN_ZOOM = 0.5;
const HIGHLIGHT = 'rgba(250, 204, 21, 0.45)';

export default function CombatMap({
  active = true,
  scene,
  tokens,
  stageWidth,
  stageHeight,
  inset,
  role,
  controls = () => false,
  setup = {},
  // Armor sources used this turn, by combatant id (the fight's `armor_used`).
  armorUsed = {},
  weight = null,
  tiles = [],
  // The combatant whose turn it is (a fight in this mode), or null.
  activeCombatantId = null,
  // Board animations: the beat playing now (useBoardFx), or null.
  fxBeat = null,
}) {
  // The token whose panel is open (Phase 4). A click opens it; a drag closes it.
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  // No token menu while any choice is open (decided, batch 3) — and one open
  // when a choice starts closes.
  const choosing = useChoosing();
  const onSelect = (t) => !isChoosing() && setSelectedTokenId(t.id);
  useEffect(() => {
    if (choosing) setSelectedTokenId(null);
  }, [choosing]);
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
  const baseFit = useMemo(
    () => fitImage(stageWidth, stageHeight, natural.width, natural.height, { left: insetLeft, right: insetRight }),
    [stageWidth, stageHeight, natural.width, natural.height, insetLeft, insetRight]
  );

  // **Zoom (decided, added with Phase 5)** — per viewer, never synced: the
  // wheel zooms about the pointer (0.5× to 5×), dragging empty map pans, and
  // the corner buttons do the same for touch. `view` is the offset of the
  // zoomed image's corner from where the fitted image would sit.
  const [view, setView] = useState({ zoom: 1, offX: 0, offY: 0 });
  useEffect(() => setView({ zoom: 1, offX: 0, offY: 0 }), [src]);
  const area = { left: insetLeft, right: stageWidth - insetRight, top: 0, bottom: stageHeight };
  // **The camera may leave the arena (decided, batch 5):** the map can be
  // dragged, at any zoom, until only a strip of it is left on screen — never
  // lost entirely. Zoom runs from 0.5× to 5×.
  const clampView = (v) => {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
    const w = baseFit.width * zoom;
    const h = baseFit.height * zoom;
    const clampAxis = (off, base, size, lo, hi) => {
      const keep = Math.min(120, size / 4, (hi - lo) / 4);
      return Math.min(hi - keep, Math.max(lo + keep - size, base + off)) - base;
    };
    return {
      zoom,
      offX: clampAxis(v.offX, baseFit.left, w, area.left, area.right),
      offY: clampAxis(v.offY, baseFit.top, h, area.top, area.bottom),
    };
  };
  // Zoom by `factor` keeping the stage point (sx, sy) where it is.
  const zoomAt = (factor, sx, sy) =>
    setView((v) => {
      const scale = baseFit.scale * v.zoom;
      const ox = baseFit.left + v.offX;
      const oy = baseFit.top + v.offY;
      const px = (sx - ox) / scale;
      const py = (sy - oy) / scale;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const ns = baseFit.scale * zoom;
      return clampView({ zoom, offX: sx - px * ns - baseFit.left, offY: sy - py * ns - baseFit.top });
    });
  const fit = {
    scale: baseFit.scale * view.zoom,
    width: baseFit.width * view.zoom,
    height: baseFit.height * view.zoom,
    left: baseFit.left + view.offX,
    top: baseFit.top + view.offY,
  };
  // **Tokens stick to their squares (fix).** A token slides when IT moves (a
  // drop, a swap), but when the view moves — pan, zoom, a resize — every token
  // must move with the map in the same frame, or they trail behind it.
  const viewKey = `${fit.left.toFixed(2)},${fit.top.toFixed(2)},${fit.scale.toFixed(5)}`;
  const lastViewKey = useRef(viewKey);
  const viewMoved = lastViewKey.current !== viewKey;
  useEffect(() => {
    lastViewKey.current = viewKey;
  });
  const panRef = useRef(null);
  const onWheel = (e) => {
    if (!baseFit.scale) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    zoomAt(Math.exp(-e.deltaY / 400), e.clientX - rect.left, e.clientY - rect.top);
  };
  // One finger (or the mouse) on empty map pans; **two fingers pinch (decided,
  // batch 5)**: the zoom follows their spread, about their midpoint, and the
  // map follows the midpoint.
  const touches = useRef(new Map()); // pointerId → { x, y }
  const pinchOf = () => {
    const [a, b] = [...touches.current.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  const onPanDown = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    panRef.current = touches.current.size === 2 ? { pinch: pinchOf() } : { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onPanMove = (e) => {
    const p = panRef.current;
    if (!p || !touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (p.pinch) {
      if (touches.current.size < 2) return;
      const now = pinchOf();
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect && p.pinch.d > 0 && now.d > 0) zoomAt(now.d / p.pinch.d, now.x - rect.left, now.y - rect.top);
      const dx = now.x - p.pinch.x;
      const dy = now.y - p.pinch.y;
      setView((v) => clampView({ ...v, offX: v.offX + dx, offY: v.offY + dy }));
      panRef.current = { pinch: now };
      return;
    }
    if (p.id !== e.pointerId) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    panRef.current = { ...p, x: e.clientX, y: e.clientY };
    setView((v) => clampView({ ...v, offX: v.offX + dx, offY: v.offY + dy }));
  };
  const onPanUp = (e) => {
    touches.current.delete(e.pointerId);
    // One finger left after a pinch pans on.
    const [id, at] = [...touches.current.entries()][0] ?? [];
    panRef.current = id != null ? { id, x: at.x, y: at.y } : null;
  };
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

  // Map tiles: a grid cell's square in stage pixels (only cells that can hold
  // a token).
  const tileQuadOf = (col, row) => {
    if (!ready || !cellInside(natural.width, natural.height, grid, col, row)) return null;
    const r = cellRect(natural.width, natural.height, grid, col, row);
    const a = toStagePx(r.x, r.y);
    const b = toStagePx(r.x + r.width, r.y + r.height);
    return [[a.x, a.y], [b.x, a.y], [b.x, b.y], [a.x, b.y]];
  };

  // The GM, or a Player who controls this character (their own, or an NPC assigned to them).
  const canDrag = (t) => role === 'gm' || (t.character_id != null && controls(t.character_id));

  // ---- moving a placed token
  const [drag, setDrag] = useState(null); // { id, pointerId, startX, startY, x, y, moved }
  // A hand move of a fighter holding Speed asks whether to spend it (decided).
  const [handMove, handMoveDialog] = useHandMove();
  const onTokenDown = (e, t) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // A legal square of the open pick under this token: the tap is the pick's.
    if (pickAt('combat', t.col, t.row)) return;
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
    if (moved && !drag.moved) setSelectedTokenId(null);
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
        const id = drag.id;
        handMove({
          combatantId: token?.fight ? id : null,
          name: token?.name,
          speed: token?.fight?.tokens?.speed ?? 0,
          where: { col: cell.col, row: cell.row },
          send: () => socket.emit('combat_token:move', { combatantId: id, col: cell.col, row: cell.row }),
          revert: () => setPending(null),
        });
      }
    }
    setDrag(null);
  };

  // ---- dropping a new token from a palette
  const [paletteDrag, setPaletteDrag] = useState(null); // { fighter, x, y }
  const latest = useRef({});
  latest.current = { cellUnder, placed, active };
  useEffect(
    () =>
      subscribeFighterDrag((ev) => {
        if (!latest.current.active) return;
        if (ev.type === 'move') setPaletteDrag({ fighter: ev.fighter, x: ev.x, y: ev.y });
        else {
          setPaletteDrag(null);
          if (ev.type !== 'drop' || !latest.current.active) return;
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
  // A token's middle: its square's, or — the Giant's 2×2 — between its four.
  const tokenCenter = (t) => {
    const a = cellCenter(grid, t.col, t.row);
    if (!(t.size > 1)) return toStagePx(a.x, a.y);
    const b = cellCenter(grid, t.col + 1, t.row + 1);
    return toStagePx((a.x + b.x) / 2, (a.y + b.y) / 2);
  };
  const rootRect = rootRef.current?.getBoundingClientRect();

  return (
    <div
      ref={rootRef}
      // Click-through: only the tokens (and an open panel) catch the pointer,
      // so the drawers beside the map stay usable even while it is raised.
      className="pointer-events-none absolute inset-0"
      // Above the GM's drawers while a token's panel is open.
      // Clipped to the map area between the drawers, so a zoomed-in token off
      // the edge never shows through a drawer — except while a panel is open,
      // when the whole layer sits above the drawers instead.
      style={{
        // 1001 while a panel is open: above the drawers, docks and corner controls.
        zIndex: selectedTokenId != null ? 1001 : 1,
        clipPath: selectedTokenId != null ? undefined : `inset(0 ${insetRight}px 0 ${insetLeft}px)`,
      }}
      // The wheel bubbles here from the map and from the tokens on it alike.
      onWheel={onWheel}
      onPointerMove={onTokenMove}
      onPointerUp={onTokenUp}
      onPointerCancel={() => setDrag(null)}
    >
      {/* The visible map area, between the drawers: clips the zoomed map, and
          catches the wheel (zoom) and drags on empty map (pan). */}
      <div
        className={`absolute overflow-hidden ${src ? 'pointer-events-auto' : ''} cursor-grab active:cursor-grabbing`}
        style={{ left: area.left, top: 0, width: Math.max(0, area.right - area.left), height: stageHeight, touchAction: 'none' }}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanUp}
        onPointerCancel={onPanUp}
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
              ? { left: fit.left - area.left, top: fit.top, width: fit.width, height: fit.height, maxWidth: 'none' }
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
          style={{ left: fit.left - area.left, top: fit.top }}
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
      </div>

      {/* Above the grid, below every token (tokens are z 10). */}
      {ready && (
        <MapTileLayer
          active={active}
          mode="combat"
          tiles={tiles.filter((t) => t.kind !== 'copy')}
          squareAt={cellUnder}
          quadOf={tileQuadOf}
          width={stageWidth}
          height={stageHeight}
          rootRef={rootRef}
          zIndex={5}
        />
      )}
      {/* Copies (phase E): the Original's picture, faded. */}
      {ready && (
        <CopyLayer
          copies={tiles.filter((t) => t.kind === 'copy')}
          quadOf={tileQuadOf}
          ownerOf={(id) => tokens.find((t) => t.id === id) ?? null}
          zIndex={7}
        />
      )}
      {/* Squares to pick (phase D): above the tiles, below the tokens. */}
      {ready && <ActiveRangeLayer mode="combat" active={activeCombatantId != null && active} quadOf={tileQuadOf} width={stageWidth} height={stageHeight} zIndex={6} />}
      {ready && <PickViewLayer mode="combat" quadOf={tileQuadOf} width={stageWidth} height={stageHeight} zIndex={7} />}
      {ready && <SquarePickLayer mode="combat" quadOf={tileQuadOf} width={stageWidth} height={stageHeight} zIndex={8} />}

      {ready && (
        <div
          className="pointer-events-auto absolute bottom-3 flex flex-col gap-1"
          style={{ right: insetRight + 12, zIndex: 30, marginBottom: 'var(--safe-bottom)' }}
        >
          {[
            [Plus, 'Zoom in', () => zoomAt(1.25, (area.left + area.right) / 2, stageHeight / 2)],
            [Minus, 'Zoom out', () => zoomAt(0.8, (area.left + area.right) / 2, stageHeight / 2)],
            [Maximize2, 'Fit the whole map', () => setView({ zoom: 1, offX: 0, offY: 0 })],
          ].map(([Icon, label, onClick]) => (
            <button
              key={label}
              type="button"
              onClick={onClick}
              title={label}
              aria-label={label}
              className="flex h-9 w-9 items-center justify-center panel-cut-sm border border-zinc-700 bg-zinc-900/85 text-zinc-300 hover:border-brand-500 hover:text-brand-300"
            >
              <Icon size={16} aria-hidden />
            </button>
          ))}
          {Math.abs(view.zoom - 1) > 0.001 && (
            <span className="text-center font-display text-[10px] tabular-nums text-zinc-400">{view.zoom.toFixed(1)}×</span>
          )}
        </div>
      )}

      {ready &&
        placed.map((t) => {
          const isDragged = dragging?.id === t.id;
          let center;
          if (isDragged && rootRect) center = { x: dragging.x - rootRect.left, y: dragging.y - rootRect.top };
          else center = tokenCenter(t);
          return (
            <Token
              key={t.id}
              token={t}
              center={center}
              size={tokenSize * (t.size ?? 1) + (t.size > 1 ? grid.size * fit.scale * 0.12 : 0)}
              lifted={isDragged}
              animate={!viewMoved}
              selected={selectedTokenId === t.id}
              canEdit={canDrag(t)}
              onPointerDown={(e) => onTokenDown(e, t)}
            />
          );
        })}

      {ready &&
        (() => {
          // Where every token stands, for the overlays and the Challenge sparks.
          const centers = new Map(placed.map((t) => [t.id, tokenCenter(t)]));
          const iconSize = Math.max(14, Math.min(26, tokenSize * 0.42));
          const byId = new Map(placed.map((t) => [t.id, t]));
          return placed.map((t) => {
            if (dragging?.id === t.id) return null;
            const center = centers.get(t.id);
            const fight = t.fight;
            const challenger = fight?.challenge_id != null ? byId.get(fight.challenge_id) : null;
            return (
              <div key={`o${t.id}`}>
                {fight && <ArmorRings center={center} rx={tokenSize / 2 + 6} gap={6} rings={armorRings(fight, setup[`${t.owner_type}:${t.owner_id}`], armorUsed[t.id] ?? 0)} />}
                {/* Only during the Challenge holder's own turn (decided). */}
                {challenger && activeCombatantId === t.id && (
                  <ChallengeLock from={center} to={centers.get(challenger.id)} radius={tokenSize / 2} />
                )}
                {fight && (
                  <FighterOverlay
                    name={t.name}
                    fight={fight}
                    setup={setup[`${t.owner_type}:${t.owner_id}`]}
                    anchor={{ x: center.x, top: center.y - tokenSize / 2, bottom: center.y + tokenSize / 2 }}
                    iconSize={iconSize}
                    selected={selectedTokenId === t.id}
                    canEdit={canDrag(t)}
                    fighterRef={{ combatantId: t.id }}
                    bounds={{ width: stageWidth, height: stageHeight }}
                    weight={weight}
                    challenger={challenger}
                    candidates={placed
                      .filter((o) => o.id !== t.id)
                      .map((o) => ({ key: o.id, ref: { combatantId: o.id }, name: o.name, image_url: o.image_url, crop: o.crop }))}
                    onClose={() => setSelectedTokenId(null)}
                  />
                )}
              </div>
            );
          });
        })()}

      {ready &&
        fxBeat &&
        (() => {
          const centers = new Map(placed.map((t) => [t.id, tokenCenter(t)]));
          return placed.map((t) => (
            <FighterFx
              key={`fx${t.id}`}
              beat={fxBeat}
              combatantId={t.id}
              center={centers.get(t.id)}
              diameter={tokenSize * (t.size ?? 1)}
              centerOf={(id) => centers.get(id)}
            />
          ));
        })()}

      {paletteDrag && rootRect && (
        <Token
          token={{ name: paletteDrag.fighter.name, image_url: paletteDrag.fighter.image_url, crop: paletteDrag.fighter.crop }}
          center={{ x: paletteDrag.x - rootRect.left, y: paletteDrag.y - rootRect.top }}
          size={Math.max(36, tokenSize)}
          lifted
          ghost={!hoverOk}
        />
      )}
      {handMoveDialog}
    </div>
  );
}

const cropFrom = (c) => (c ? cropOf({ crop_x: c.x, crop_y: c.y, crop_w: c.w, crop_h: c.h }) : null);

// A round combat token: the fighter's combat-token picture (or portrait), a
// light ring and a drop shadow. Lifted while dragged.
export function Token({ token, center, size, lifted = false, animate = true, selected = false, ghost = false, canEdit = false, onPointerDown }) {
  return (
    <div
      className={`group absolute ${onPointerDown ? `pointer-events-auto ${canEdit ? (lifted ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer'}` : 'pointer-events-none'}`}
      style={{
        left: center.x - size / 2,
        top: center.y - size / 2,
        width: size,
        height: size,
        zIndex: lifted ? 30 : selected ? 20 : 10,
        // Taken Out at zero HP (batch 5): half transparent and grey, until healed.
        opacity: ghost ? 0.45 : token.fight?.hp && isTakenOut(token.fight.hp) ? 0.5 : 1,
        filter: token.fight?.hp && isTakenOut(token.fight.hp) ? 'grayscale(0.85)' : undefined,
        transition: lifted || !animate ? 'none' : 'left 160ms ease-out, top 160ms ease-out',
        touchAction: 'none',
      }}
      title={token.name}
      data-combat-token={token.id}
      data-taken-out={token.fight?.hp && isTakenOut(token.fight.hp) ? 'true' : undefined}
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
      {/* Only once the token is tapped (decided): on a phone there's no hover,
          and an always-visible ✕ was too easy to hit by accident. */}
      {canEdit && !lifted && token.id != null && selected && (
        <button
          type="button"
          title={`Remove ${token.name} from the map`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            socket.emit('combat_token:remove', { combatantId: token.id });
          }}
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-600 bg-zinc-900/90 text-zinc-300 hover:text-red-400"
        >
          <X size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
